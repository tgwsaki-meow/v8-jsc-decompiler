// src/recover/patterns/asyncgen.mjs
//
// `await`, `yield`, `yield*`, and the async-function wrapper.
//
// Inverts, all at src/interpreter/bytecode-generator.cc @ 14.4.258.16
// (sha256 2cfe5b32c722d2598bfd9bf60bf1b6349a0a7aca7b7169b70425eafca437163e):
//
//   BuildSuspendPoint                        :5977
//   BuildAwait                               :6337
//   VisitAwait                               :6389
//   VisitYield                               :6001
//   VisitYieldStar                           :6161
//   BuildAsyncReturn                         :4852
//   GenerateAsyncFunctionBody                :1893
//   BuildGeneratorObjectVariableInitialization :8612
//   BuildGeneratorPrologue                   :2074
//
// BuildAwait emits exactly this, and the recogniser is it read backwards:
//
//     Mov   <generator>, args[0]
//     Star  args[1]                             <- the awaited value
//     InvokeIntrinsic AsyncFunctionAwait args    (AsyncGeneratorAwait in an
//                                                 async generator)
//     SuspendGenerator <gen>, <live regs>, id    <- terminator; it RETURNS
//     ResumeGenerator  <gen>, <live regs>        <- acc = the sent value
//     Star  input
//     InvokeIntrinsic GeneratorGetResumeMode <gen>
//     Star  resume_mode
//     LdaSmi #0                                  (JSGeneratorObject::kNext)
//     TestReferenceEqual resume_mode
//     JumpIfTrue -> resume_next
//     Ldar input
//     ReThrow
//   resume_next:
//     Ldar input                                 <- the value of the `await`
//
// So the whole construct is anchored on the intrinsic, which is unambiguous:
// `AsyncFunctionAwait` / `AsyncGeneratorAwait` appear nowhere else. The value
// of the expression is the `input` register after the resume, which is the
// `ResumeGenerator` op's accumulator output -- so that value gets the
// `{e:'await', arg}` expression and everything between the intrinsic and the
// resume-mode dispatch is consumed.
//
// `yield` is the same anchored on `SuspendGenerator` without a preceding await
// intrinsic: the operand is either the raw value (the first yield) or
// `%CreateIterResultObject(value, false)` / `%AsyncGeneratorYieldWithAwait`.
//
// The async function wrapper: `GenerateAsyncFunctionBody` wraps the body in a
// try/catch whose prediction is ASYNC_AWAIT and whose handler is
// `%AsyncFunctionReject(gen, exception)` + `Return`. ARCHITECTURE.md 9.1
// measured 13 713 of the corpus's 25 189 handler ranges as ASYNC_AWAIT, i.e.
// two thirds of all ranges are this wrapper and not a source `try`. Each one
// is claimed here and lands in `consumed.handlerRanges`, which is what lets
// T8 emit zero `try` statements for them (11.2 constraint 3).

const AWAIT_INTRINSICS = new Set(['AsyncFunctionAwait', 'AsyncGeneratorAwait']);
const YIELD_WRAPPERS = new Set(['CreateIterResultObject', 'AsyncGeneratorYieldWithAwait']);
const ENTER = new Set(['AsyncFunctionEnter', 'CreateJSGeneratorObject']);
const RESOLVE = new Set(['AsyncFunctionResolve', 'AsyncGeneratorResolve']);
const REJECT = new Set(['AsyncFunctionReject', 'AsyncGeneratorReject']);

const CITES = ['BuildAwait:6337', 'BuildSuspendPoint:5977', 'VisitAwait:6389'];

export function run(pc) {
  const ir = pc.ir;
  const unit = ir.unit;

  // ------------------------------------------------- the generator prologue
  // %AsyncFunctionEnter(<closure>, <this>) / %CreateJSGeneratorObject(...)
  // -> the .generator_object variable. Not source syntax.
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    const rt = pc.runtimeNameOf(v);
    if (rt && ENTER.has(rt)) {
      pc.consume(v.instruction);
      pc.consumeMovesFeeding(v);
      pc.claim({
        kind: 'generatorPrologue', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildGeneratorObjectVariableInitialization:8612'],
        detail: rt,
      });
    }
  }

  // ------------------------------------------- the entry resume dispatcher
  // BuildGeneratorPrologue. T8 removes it; T7 only has to not emit anything
  // for it, and to record that it was recognised.
  for (const b of ir.blocks) {
    if (!b.isGeneratorDispatch) continue;
    const vid = ir.instructionValue[b.last];
    if (vid < 0) continue;
    pc.consume(b.last);
    pc.claim({
      kind: 'generatorDispatcher', blocks: [b.id], values: [vid],
      instructions: [b.last], confidence: 'exact',
      cites: ['BuildGeneratorPrologue:2074'], detail: null,
    });
  }

  // --------------------------------------------------- await / yield points
  // One claim per suspend. docs/IR.md: the ResumeGenerator for suspend id j is
  // the instruction immediately after the SuspendGenerator carrying that id,
  // so the pairing is read off the instruction stream, not guessed.
  for (const v of ir.values) {
    if (v?.kind !== 'Op' || v.op !== pc.reg.need('SuspendGenerator')) continue;
    const suspendIns = v.instruction;
    const resumeIns = suspendIns + 1;
    const resumeV = pc.valueAt(resumeIns);
    if (!resumeV || resumeV.op !== 'ResumeGenerator') {
      pc.warn('suspendWithoutResume', { offset: ir.instructions[suspendIns].offset });
      continue;
    }

    // What was suspended on: look back from the suspend for the intrinsic.
    const operand = suspendOperand(pc, v);
    const isAwait = operand && AWAIT_INTRINSICS.has(operand.rt);
    const isYield = operand && YIELD_WRAPPERS.has(operand.rt);

    // ResumeGenerator restores the whole spilled register file. docs/IR.md 8:
    // "ResumeGenerator's register outputs hold the values SuspendGenerator's
    // register inputs held", and BuildSuspendPoint passes the SAME
    // RegisterList to both, so output j is input j. Without this mapping every
    // register live across an await comes back as an unrecoverable projection.
    const spilled = pc.flatRegInputs(v).slice(1);        // [0] is the generator
    (resumeV.projections ?? []).forEach((pid, j) => {
      const src = spilled[j];
      if (src === undefined) return;
      pc.setExpr(pid, () => pc.E(src));
    });

    const consumed = [suspendIns, resumeIns];
    if (operand) {
      consumed.push(operand.value.instruction);
      pc.consumeMovesFeeding(operand.value);
    }

    // the resume-mode dispatch that follows the resume
    const dispatch = matchResumeDispatch(pc, resumeIns);
    for (const i of dispatch.instructions) consumed.push(i);
    if (dispatch.rethrowBlock !== null && dispatch.rethrowBlock !== undefined) {
      pc.suppressBlockTail(dispatch.rethrowBlock);
    }

    const resultValue = dispatch.resultValue ?? resumeV.id;
    const argThunk = operand
      ? () => pc.E(operand.argValue)
      : () => pc.E(pc.accInputOf(v));

    if (isAwait) {
      pc.setExpr(resultValue, () => ({ e: 'await', arg: argThunk() }));
      claim('await');
    } else if (isYield) {
      const delegate = false;
      pc.setExpr(resultValue, () => ({ e: 'yield', arg: argThunk(), delegate }));
      claim('yield');
    } else {
      // the first `yield` of a generator suspends the raw value, and the
      // initial yield of a generator function suspends `undefined`.
      pc.setExpr(resultValue, () => ({ e: 'yield', arg: argThunk(), delegate: false, initial: true }));
      claim('yield');
    }

    for (const i of consumed) pc.consume(i);

    function claim(kind) {
      pc.claim({
        kind, blocks: [v.block, resumeV.block], values: [v.id, resumeV.id, resultValue],
        instructions: consumed.slice(), confidence: dispatch.matched ? 'exact' : 'shape',
        cites: kind === 'await' ? CITES : ['VisitYield:6001', 'BuildSuspendPoint:5977'],
        detail: operand?.rt ?? 'rawSuspend',
      });
    }
  }

  // ---------------------------------------------------- `yield*` delegation
  // VisitYieldStar builds a loop around BuildIteratorNext + a resume-mode
  // switch. It is recognised by its own marker: the only place the generator
  // emits `%CreateAsyncFromSyncIterator` or a `GetIterator` whose result is
  // driven by a `SwitchOnSmiNoFeedback` over the resume mode.
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    const rt = pc.runtimeNameOf(v);
    if (rt !== 'CreateAsyncFromSyncIterator') continue;
    pc.setExpr(v.id, () => pc.E(pc.firstRegInput(v)));
    pc.claim({
      kind: 'yieldStar', blocks: [v.block], values: [v.id],
      instructions: [v.instruction], confidence: 'shape',
      cites: ['VisitYieldStar:6161'],
      detail: 'async-from-sync iterator wrapper; the delegation loop itself is T8\'s',
    });
    pc.consume(v.instruction);
  }

  // -------------------------------------------- async return / async reject
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    const rt = pc.runtimeNameOf(v);
    if (!rt) continue;
    if (RESOLVE.has(rt)) {
      // BuildAsyncReturn: %AsyncFunctionResolve(gen, value) then Return.
      // The source statement is `return value`.
      const args = pc.flatRegInputs(v);
      const valueId = args[1] ?? null;
      pc.setExpr(v.id, () => (valueId === null ? { e: 'lit', v: undefined } : pc.E(valueId)));
      pc.consumeMovesFeeding(v);
      pc.consume(v.instruction);
      pc.claim({
        kind: 'asyncReturn', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildAsyncReturn:4852'], detail: rt,
      });
    } else if (REJECT.has(rt)) {
      // GenerateAsyncFunctionBody's catch arm. Not source syntax: the whole
      // handler block is the desugaring of "an async function returns a
      // rejected promise", including the `Return` the builder puts after it
      // (BuildReturn(kNoSourcePosition) on line 1936), so that Return goes too
      // or it would print `return <the reject call>`.
      pc.consumeMovesFeeding(v);
      pc.consume(v.instruction);
      const after = pc.valueAt(v.instruction + 1);
      if (after?.kind === 'Op' && after.op === 'Return' && pc.sameValue(pc.accInputOf(after), v.id)) {
        pc.consume(after.instruction);
      }
      pc.suppressBlockTail(v.block);
      pc.claim({
        kind: 'asyncReject', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['GenerateAsyncFunctionBody:1893'], detail: rt,
      });
    } else if (rt === 'GeneratorClose') {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'generatorClose', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['GenerateAsyncGeneratorFunctionBody:1956'], detail: rt,
      });
    }
  }

  // --------------------------------------------- the ASYNC_AWAIT try ranges
  // ARCHITECTURE.md 9.1 / 11.2 constraint 3: these are the await desugaring,
  // not a source `try`, and T8 must emit none of them. Claim every one so the
  // count is visible and T9 can cross-check.
  (ir.handlers ?? []).forEach((h, i) => {
    const p = h.predictionName ?? h.prediction;
    if (p !== 'ASYNC_AWAIT' && p !== 'UNCAUGHT_ASYNC_AWAIT') return;
    pc.consumeHandlerRange(i);
    pc.claim({
      kind: 'asyncAwaitHandlerRange', blocks: [], values: [],
      instructions: [], handlerRanges: [i], confidence: 'exact',
      cites: ['GenerateAsyncFunctionBody:1893', 'BuildTryCatch:2926'],
      detail: String(p),
    });
  });

  // the resume-mode comparison the dispatch uses, when it was not consumed
  // above (a generator whose `yield` appears in a shape this does not cover)
  if (unit.isGenerator || unit.isAsync) pc.stats.resumable = true;
}

/**
 * The intrinsic immediately before a SuspendGenerator, if any, plus which of
 * its arguments is the operand of the await/yield.
 */
function suspendOperand(pc, suspend) {
  for (let i = suspend.instruction - 1; i >= 0 && i >= suspend.instruction - 6; i--) {
    const v = pc.valueAt(i);
    if (!v) continue;
    const rt = pc.runtimeNameOf(v);
    if (!rt) {
      // a Mov/Star setting up the argument list is fine to walk over
      if (pc.isMove(v)) continue;
      return null;
    }
    const args = pc.flatRegInputs(v);
    if (AWAIT_INTRINSICS.has(rt) || rt === 'AsyncGeneratorYieldWithAwait') {
      return { rt, value: v, argValue: args[1] ?? null };
    }
    if (rt === 'CreateIterResultObject') {
      return { rt, value: v, argValue: args[0] ?? null };
    }
    return null;
  }
  return null;
}

/**
 * BuildAwait's resume-mode dispatch, following a ResumeGenerator:
 *
 *     Star input
 *     InvokeIntrinsic GeneratorGetResumeMode <gen>
 *     Star resume_mode
 *     LdaZero / LdaSmi #kNext
 *     TestReferenceEqual resume_mode
 *     JumpIfTrue -> resume_next
 *     Ldar input ; ReThrow
 *   resume_next:
 *     Ldar input
 *
 * Returns the instructions to consume and the SSA value that carries the
 * expression's result (the `input` register, i.e. the resume's own output).
 */
/**
 * `Ldar input ; ReThrow` -- BuildAwait's throw-completion arm, starting at
 * instruction `i`. Returns the instruction indices, or [] if the two
 * instructions after the branch are not that arm (VisitYield's three-way
 * `SwitchOnSmiNoFeedback` dispatch, for one, has no such arm).
 */
function rethrowArm(pc, i) {
  const out = [];
  let j = i;
  for (let guard = 0; guard < 3; guard++, j++) {
    const v = pc.valueAt(j);
    if (!v || v.kind !== 'Op') return [];
    if (pc.isMove(v)) { out.push(j); continue; }
    if (v.op === pc.reg.need('ReThrow')) { out.push(j); return out; }
    return [];
  }
  return [];
}

function matchResumeDispatch(pc, resumeIns) {
  const out = { matched: false, instructions: [], resultValue: null, rethrowBlock: null };
  const ir = pc.ir;
  let i = resumeIns + 1;
  const limit = Math.min(ir.instructions.length, resumeIns + 10);
  let sawResumeMode = false;
  for (; i < limit; i++) {
    const v = pc.valueAt(i);
    if (!v) break;
    const rt = pc.runtimeNameOf(v);
    if (rt === 'GeneratorGetResumeMode') { sawResumeMode = true; out.instructions.push(i); continue; }
    if (!sawResumeMode) {
      if (pc.isMove(v)) continue;            // Star input
      break;
    }
    // after the resume mode: the comparison and the branch
    if (pc.isMove(v)) { out.instructions.push(i); continue; }
    if (v.op === 'TestReferenceEqual' || v.op === 'LdaZero' || v.op === 'LdaSmi') {
      out.instructions.push(i); continue;
    }
    if (ir.instructions[i].jumpTarget !== null && ir.instructions[i].jumpTarget !== undefined) {
      out.instructions.push(i);
      out.matched = true;
      // BuildAwait:6381 -- "Resume with throw completion (rethrow the received
      // value)": `Ldar input ; ReThrow` is the not-taken arm of the branch and
      // is as much part of the desugaring as the branch itself. Consuming it
      // matters beyond tidiness: `input` is read by this arm AND by the
      // resume_next arm, so leaving it makes the resume value a two-use value,
      // which materialises it and prints `let t = await p; ... return t`
      // instead of `return await p`.
      const arm = rethrowArm(pc, i + 1);
      for (const j of arm) out.instructions.push(j);
      if (arm.length) {
        const bv = pc.valueAt(arm[arm.length - 1]);
        if (bv?.block !== undefined) out.rethrowBlock = bv.block;
      }
      break;
    }
    if (v.op === 'SwitchOnSmiNoFeedback') {
      // VisitYield's three-way resume dispatch
      out.instructions.push(i);
      out.matched = true;
      break;
    }
    break;
  }
  if (!out.matched) out.instructions.length = 0;
  // the result is the resume's own accumulator output: every `Ldar input` in
  // the dispatch canonicalises back to it.
  out.resultValue = ir.instructionValue[resumeIns] >= 0 ? ir.instructionValue[resumeIns] : null;
  return out;
}

export default { name: 'asyncgen', run };
