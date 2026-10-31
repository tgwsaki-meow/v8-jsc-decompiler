// src/recover/patterns/misc.mjs
//
// The remaining single-instruction desugarings, each of which has to be
// consumed or it becomes a statement that was never in the source.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   BuildThrowIfHole                      :4902   the TDZ read check
//   BuildHoleCheckForVariableAssignment   :4925   the TDZ write check
//   BuildTryFinally                       :2979   the pending-message save
//   VisitArgumentsObject                  :8560
//   VisitThisFunctionVariable             :8581
//   VisitNewTargetVariable                :8589
//   BuildNewLocalActivationContext        :8470   the context prologue
//   VisitDeclarations / VisitGlobalDeclarations :2305 / :2281
//
// The TDZ checks are the big one by volume: 75 157 `ThrowReferenceErrorIfHole`
// in the corpus, one per read of a `let`/`const` the generator could not prove
// initialised. Each reads the accumulator and defines nothing, so without a
// claim it would be an effectful-op-with-no-use and expr.mjs's statement rule
// would print something for all 75 157 of them. They also carry information
// worth keeping: the checked name, which confirms the variable's declaration
// kind, so the claim records it.

const TDZ_READ = 'ThrowReferenceErrorIfHole';
const TDZ_WRITE = new Set(['ThrowSuperNotCalledIfHole', 'ThrowSuperAlreadyCalledIfNotHole', 'ThrowIfNotSuperConstructor']);

export function run(pc) {
  const ir = pc.ir;

  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;

    if (v.op === TDZ_READ) {
      const n = pc.nameOperandOf(v);
      pc.consume(v.instruction);
      pc.noteTdz(n);
      pc.claim({
        kind: 'tdzCheck', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildThrowIfHole:4902'], detail: n,
      });
      continue;
    }

    if (TDZ_WRITE.has(v.op)) {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'superGuard', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['VisitCallSuper:6961', 'BuildHoleCheckForVariableAssignment:4925'],
        detail: v.op,
      });
      continue;
    }

    // A stack-allocated `let x;` / `const x` in its TDZ: the generator parks
    // the hole in the register, so a read before the initialiser throws
    // (BuildThrowIfHole). The hole itself has no JS spelling, but the
    // DECLARATION does -- so the value becomes a named binding declared
    // without an initialiser, which is the same program.
    if (v.op === 'LdaTheHole') {
      const live = pc.usesOf(v.id).some((u) => {
        const uv = pc.ir.values[u];
        return uv && !(uv.kind === 'Op' && (uv.op === TDZ_READ || TDZ_WRITE.has(uv.op)));
      });
      if (live) {
        pc.forceMaterialise(v.id);
        pc.setStmt(v.id, () => ({
          s: 'decl', kind: 'let', decls: [{ id: pc.E(v.id), init: null }], tdzInitialisation: true,
        }));
        pc.claim({
          kind: 'tdzInit', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['BuildVariableAssignment:4963', 'BuildThrowIfHole:4902'],
          detail: 'a stack-allocated binding in its temporal dead zone',
        });
      }
      continue;
    }

    // `let x;` / `const x` before its initialiser: BuildVariableAssignment
    // stores the hole into the slot so a read before the initialiser throws.
    // The source form is the declaration itself, with no init -- storing a
    // hole is the desugaring, so the statement becomes `let x;`.
    if (v.contextSlot?.mode === 'store') {
      const stored = pc.accInputOf(v);
      const e = stored === null ? null : pc.exprOf(pc.canon(stored));
      if (e?.e === 'hole' && e.why === 'theHole') {
        pc.setStmt(v.id, () => {
          const target = pc.contextSlotName(v);
          return {
            s: 'decl', kind: declKindOf(pc, v),
            decls: [{ id: target, init: null }],
            tdzInitialisation: true,
          };
        });
        pc.claim({
          kind: 'tdzInit', blocks: [v.block], values: [v.id],
          instructions: [], confidence: 'exact',
          cites: ['BuildVariableAssignment:4963', 'BuildHoleCheckForVariableAssignment:4925'],
          detail: v.contextSlot.name ?? null,
        });
        continue;
      }
    }

    if (v.op === 'SetPendingMessage') {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'finallyMessage', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildTryFinally:2979'],
        detail: 'the isolate pending-message save/restore around a finally block',
      });
      continue;
    }

    if (v.op === 'CreateMappedArguments' || v.op === 'CreateUnmappedArguments') {
      pc.claim({
        kind: 'argumentsObject', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['VisitArgumentsObject:8560'],
        detail: v.op === 'CreateMappedArguments' ? 'sloppy (aliases the parameters)' : 'strict',
      });
      continue;
    }

    // the context prologue: Create*Context + PushContext/PopContext. Already
    // `skip` in expr.mjs; claimed so the count is visible and so T9 can see
    // that nothing was dropped silently.
    if (v.sem?.contextCreator || v.op === 'PushContext' || v.op === 'PopContext') {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'contextPlumbing', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildNewLocalActivationContext:8470'], detail: v.op,
      });
      continue;
    }

    const rt = pc.runtimeNameOf(v);
    if (rt === 'DeclareGlobals' || rt === 'DeclareEvalVar' || rt === 'DeclareEvalFunction'
      || rt === 'DeclareModuleExports' || rt === 'SetFunctionName') {
      pc.consume(v.instruction);
      pc.consumeMovesFeeding(v);
      pc.claim({
        kind: 'declarationPass', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['VisitDeclarations:2305', 'VisitGlobalDeclarations:2281'], detail: rt,
      });
      continue;
    }

    if (rt === 'ResolvePossiblyDirectEval') {
      const args = pc.flatRegInputs(v);
      pc.setExpr(v.id, () => ({
        e: 'call', optional: false,
        callee: { e: 'name', name: 'eval', ref: { k: 'global', directEval: true } },
        args: args.length > 1 ? [pc.E(args[1])] : [],
      }));
      pc.claim({
        kind: 'directEval', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'shape', cites: ['VisitCall:6738'],
        detail: 'the %ResolvePossiblyDirectEval + Call pair; the call itself stays',
      });
      continue;
    }

    if (rt === 'ThrowIteratorResultNotAnObject') {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'iteratorGuard', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildIteratorNext:7994'], detail: rt,
      });
      continue;
    }
  }

  // block coverage counters, only present under --block-coverage
  for (const v of ir.values) {
    if (v?.kind === 'Op' && v.op === 'IncBlockCounter') pc.consume(v.instruction);
  }
}

/** The declaration keyword the slot's VariableMode implies. */
function declKindOf(pc, v) {
  const slotId = v.contextSlot?.slotValue;
  const sv = slotId === null || slotId === undefined ? null : pc.ir.values[slotId];
  switch (sv?.mode) {
    case 'kConst': return 'const';
    case 'kVar': return 'var';
    default: return 'let';
  }
}

export default { name: 'misc', run };
