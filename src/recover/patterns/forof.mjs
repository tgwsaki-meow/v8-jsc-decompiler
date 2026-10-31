// src/recover/patterns/forof.mjs
//
// `for (x of it)` and `for await (x of it)`, i.e. the iterator protocol.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitForOfStatement    :3344
//   BuildGetIterator       :7911
//   BuildIteratorNext      :7994
//   BuildCallIteratorMethod:8015
//   BuildIteratorClose     :8033
//   BuildFinalizeIteration :5331
//
// BuildGetIterator emits `GetIterator <obj>` for the sync case, and for the
// async case `GetIterator` on @@asyncIterator with a fall back through
// `%CreateAsyncFromSyncIterator`. BuildIteratorNext is
//
//     CallProperty0 <next>, <iterator>
//     (%ThrowIteratorResultNotAnObject <result> when the result may not be an
//      object)
//     Star <result>
//     GetNamedProperty <result>, "done"      -> the loop test
//     GetNamedProperty <result>, "value"     -> the loop variable
//
// and BuildFinalizeIteration wraps the body in a `try { } finally { ... }` that
// calls `return` on the iterator -- which is why a `for-of` function has
// handler ranges that are not source `try` statements. Those ranges are
// CAUGHT/UNCAUGHT rather than ASYNC_AWAIT, so 11.2 constraint 3 does not cover
// them: they are claimed here, and T8 emitting a `try` for them would be
// correct-but-ugly rather than wrong, so the claim is advisory and the range is
// NOT consumed. docs/RECOVER.md records that as a known divergence.
//
// T7 owns: the iterable expression, the `value` read that is the loop variable,
// and consuming the next/done plumbing. T8 owns the loop.

export function run(pc) {
  const ir = pc.ir;
  for (const v of ir.values) {
    if (v?.kind !== 'Op' || v.op !== 'GetIterator') continue;

    const iterable = pc.firstRegInput(v);
    const instructions = [];

    // the `next` property load and the call that drives it
    let nextLoad = null, nextCall = null, resultDone = null, resultValue = null;
    for (const u of pc.usesOf(v.id)) {
      const uv = ir.values[u];
      if (!uv) continue;
      if (uv.kind === 'Op' && uv.op === 'GetNamedProperty' && pc.nameOperandOf(uv) === 'next') {
        nextLoad = uv;
      }
    }
    if (nextLoad) {
      for (const u of pc.usesOf(nextLoad.id)) {
        const uv = ir.values[u];
        if (uv?.kind === 'Op' && pc.isCall(uv)) nextCall = uv;
      }
    }
    if (nextCall) {
      for (const u of pc.usesOf(nextCall.id)) {
        const uv = ir.values[u];
        if (uv?.kind !== 'Op' || uv.op !== 'GetNamedProperty') continue;
        const n = pc.nameOperandOf(uv);
        if (n === 'done') resultDone = uv;
        else if (n === 'value') resultValue = uv;
      }
    }
    // Nothing is consumed. Every instruction of the protocol has a faithful
    // plain-JS transcription (`it[Symbol.iterator]()`, `it.next()`,
    // `r.done`, `r.value`), so a function whose loop T8 does not recognise as
    // a `for-of` still comes out correct, just verbose. Consuming them would
    // make T7 depend on T8 getting the loop right, which 11.1 forbids
    // (`consumed` is not T8's input).
    const isAwait = looksAsync(pc, v);

    pc.claim({
      kind: isAwait ? 'forAwaitOf' : 'forOf',
      blocks: [v.block], values: [v.id, nextCall?.id, resultDone?.id, resultValue?.id].filter((x) => x !== undefined && x !== null),
      instructions, confidence: nextCall ? 'exact' : 'shape',
      cites: ['VisitForOfStatement:3344', 'BuildGetIterator:7911', 'BuildIteratorNext:7994'],
      detail: nextCall ? null : 'GetIterator with no recognised next() call: a bare iterator access',
    });
  }

  // BuildIteratorClose / BuildFinalizeIteration: the `return` call on the
  // iterator in the finally arm.
  for (const v of ir.values) {
    if (v?.kind !== 'Op' || v.op !== 'GetNamedProperty') continue;
    if (pc.nameOperandOf(v) !== 'return') continue;
    pc.claim({
      kind: 'iteratorClose', blocks: [v.block], values: [v.id], instructions: [],
      confidence: 'shape', cites: ['BuildIteratorClose:8033', 'BuildFinalizeIteration:5331'],
      detail: 'iterator.return() -- the for-of finally arm',
    });
  }
}

/** for-await-of: the iterator came through %CreateAsyncFromSyncIterator, or the loop awaits its result. */
function looksAsync(pc, v) {
  if (pc.ir.unit.isAsync !== true) return false;
  for (const u of pc.usesOf(v.id)) {
    const uv = pc.ir.values[u];
    if (uv?.kind === 'Op' && pc.runtimeNameOf(uv) === 'CreateAsyncFromSyncIterator') return true;
  }
  return pc.ir.values.some((w) => w?.kind === 'Op' && pc.runtimeNameOf(w) === 'CreateAsyncFromSyncIterator');
}

export default { name: 'forof', run };
