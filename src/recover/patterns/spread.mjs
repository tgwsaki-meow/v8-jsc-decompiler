// src/recover/patterns/spread.mjs
//
// Spread and rest, in calls, constructs, arrays and objects.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitSpread              :7887
//   VisitCall                :6738   (the CallWithSpread arm)
//   VisitCallNew             :7136   (the ConstructWithSpread arm)
//   BuildCreateArrayLiteral  :4508   (the CreateArrayFromIterable arm)
//   BuildFillArrayWithIterator :4474
//   VisitObjectLiteral       :4190   (the %CopyDataProperties arm)
//   VisitRestArgumentsArray  :8571
//   VisitSuperCallForwardArgs:7184   (ConstructForwardAllArgs)
//
// Four of the five are one opcode each, so the "pattern" is a claim plus a
// count rather than a subgraph match -- expr.mjs already transcribes
// `CallWithSpread` / `ConstructWithSpread` / `CreateArrayFromIterable` /
// `CreateRestParameter` because the opcode itself says "spread". The one that
// needs work is the object form.
//
// `{...src}` and `{a, ...src}`: VisitObjectLiteral emits `CloneObject <src>`
// when the spread is the first property (it can clone straight into the
// result) and `%CopyDataProperties(<target>, <src>)` otherwise. The second
// form writes INTO an existing object, so it is a statement in bytecode and a
// property in source; the fold below turns it back into a `...src` property of
// the literal that `target` holds, and only when `target` is a literal this
// pass can see -- otherwise it stays a statement and is reported.
//
// `const {a, ...rest} = o` uses
// `%CopyDataPropertiesWithExcludedPropertiesOnStack(src, n, ...excluded)`,
// whose result IS a fresh object, so that one is a value and needs no fold.

const SPREAD_OPS = new Set(['CallWithSpread', 'ConstructWithSpread', 'CreateArrayFromIterable']);

export function run(pc) {
  const ir = pc.ir;

  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;

    if (SPREAD_OPS.has(v.op)) {
      pc.claim({
        kind: 'spread', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact',
        cites: v.op === 'CreateArrayFromIterable'
          ? ['BuildCreateArrayLiteral:4508', 'BuildFillArrayWithIterator:4474']
          : ['VisitSpread:7887', v.op === 'CallWithSpread' ? 'VisitCall:6738' : 'VisitCallNew:7136'],
        detail: v.op,
      });
      continue;
    }

    if (v.op === 'CreateRestParameter') {
      // VisitRestArgumentsArray. The rest array IS the parameter, so it is a
      // binding and not an expression: the value gets a name and no defining
      // statement, and T9 puts `...name` in the signature. The name itself is
      // synthetic ("rest") because ScopeInfo carries no name for a
      // stack-allocated parameter.
      const from = Math.max(0, (ir.unit.parameterCount ?? 1) - 1);
      pc.forceMaterialise(v.id);
      pc.consume(v.instruction);
      pc.declareRestParameter(v.id, from);
      pc.claim({
        kind: 'restParameter', blocks: [v.block], values: [v.id],
        instructions: [], confidence: 'exact', cites: ['VisitRestArgumentsArray:8571'],
        detail: `rest from parameter index ${from}`,
      });
      continue;
    }

    if (v.op === 'ConstructForwardAllArgs') {
      pc.claim({
        kind: 'spread', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['VisitSuperCallForwardArgs:7184'],
        detail: 'super(...arguments)',
      });
      continue;
    }

    if (v.op === 'CloneObject') {
      pc.claim({
        kind: 'spread', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['VisitObjectLiteral:4190'],
        detail: 'object spread as the first property',
      });
      continue;
    }

    const rt = pc.runtimeNameOf(v);
    if (rt === 'CopyDataProperties') copyInto(pc, v);
    else if (rt === 'CopyDataPropertiesWithExcludedPropertiesOnStack') restObject(pc, v);
  }
}

function copyInto(pc, v) {
  const args = pc.flatRegInputs(v);
  const targetId = args[0] ?? null;
  const sourceId = args[1] ?? null;
  if (targetId === null || sourceId === null) return;
  const target = pc.ir.values[pc.canon(targetId)];
  const targetExpr = target ? pc.exprOf(target.id) : null;
  const folded = targetExpr?.e === 'object' && target.allocationKind === 'definite';

  if (folded) {
    pc.addObjectProperty(target.id, () => ({ kind: 'spread', key: null, computed: false, value: pc.E(sourceId) }));
    pc.consume(v.instruction);
    pc.consumeMovesFeeding(v);
  } else {
    // honest fall-back: it stays a statement, as `Object.assign(target, src)`,
    // which is what %CopyDataProperties does for data properties. The runtime
    // function returns its target, so the value is the target too.
    const call = () => ({
      e: 'call', optional: false,
      callee: { e: 'member', obj: { e: 'name', name: 'Object', ref: { k: 'global' } }, prop: 'assign', computed: false, optional: false },
      args: [pc.E(targetId), pc.E(sourceId)],
    });
    pc.setStmt(v.id, () => ({ s: 'expr', expr: call() }));
    pc.setExpr(v.id, call);
  }
  pc.claim({
    kind: 'spread', blocks: [v.block], values: [v.id], instructions: folded ? [v.instruction] : [],
    confidence: folded ? 'exact' : 'shape', cites: ['VisitObjectLiteral:4190'],
    detail: folded ? 'object spread folded into its literal' : 'object spread into a target this pass cannot see',
  });
}

function restObject(pc, v) {
  const args = pc.flatRegInputs(v);
  pc.setExpr(v.id, () => ({
    e: 'object',
    props: [{ kind: 'spread', key: null, computed: false, value: pc.E(args[0]) }],
    excluded: args.slice(2).map((id) => pc.E(id)),
  }));
  pc.claim({
    kind: 'destructure', blocks: [v.block], values: [v.id],
    instructions: [v.instruction], confidence: 'exact',
    cites: ['BuildDestructuringObjectAssignment:5638'],
    detail: `object rest, ${Math.max(0, args.length - 2)} excluded key(s)`,
  });
  pc.consume(v.instruction);
}

export default { name: 'spread', run };
