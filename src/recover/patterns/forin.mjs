// src/recover/patterns/forin.mjs
//
// `for (k in o)`.
//
// Inverts VisitForInStatement, src/interpreter/bytecode-generator.cc:3251
// @ 14.4.258.16, which emits exactly:
//
//     <subject> ; ForInEnumerate                 -> acc = the enumerable
//     ForInPrepare <cache triple>, slot          -> cache_type/array/length
//     LdaZero ; Star <index>
//   loop:
//     JumpIfForInDone <index>, <cache_length>    -> done
//     ForInNext <receiver>, <index>, <cache pair>, slot   -> acc = the key
//     JumpIfUndefined -> step                    (the key was deleted)
//     <assign the loop variable> ; <body>
//   step:
//     ForInStep <index> ; Star <index> ; JumpLoop loop
//   done:
//
// The loop is T8's (11.2 gives it `{r:'forIn', left, right, body}`); T7 owns
// the values and the plumbing. `right` is the enumerable -- the value
// ForInEnumerate was applied to, not ForInEnumerate's own result -- and `left`
// is the key, i.e. the ForInNext value. Everything else (the cache triple, the
// index register, the step, the done test) has no source form and is consumed
// so no statement is emitted for it.
//
// The corpus has 1143 of each of ForInEnumerate / ForInPrepare / ForInNext /
// ForInStep, which is the cheapest confirmation that the shape is fixed: one
// of each per `for-in`.

export function run(pc) {
  const ir = pc.ir;
  for (const v of ir.values) {
    if (v?.kind !== 'Op' || v.op !== 'ForInPrepare') continue;

    const enumerateId = pc.canon(pc.accInputOf(v));
    const enumerate = ir.values[enumerateId];
    const subject = enumerate?.kind === 'Op' && enumerate.op === 'ForInEnumerate'
      ? pc.accInputOf(enumerate) : null;

    const instructions = [v.instruction];
    if (enumerate?.kind === 'Op' && enumerate.op === 'ForInEnumerate') instructions.push(enumerate.instruction);

    // the enumerable, for T8's `right`
    if (subject !== null) {
      pc.setExpr(enumerateId, () => pc.E(subject));
      pc.setExpr(v.id, () => pc.E(subject));
      for (const p of v.projections ?? []) pc.setExpr(p, () => pc.E(subject));
    }

    // the key, the step and the done test
    const keys = [];
    for (const w of ir.values) {
      if (w?.kind !== 'Op') continue;
      if (w.op === 'ForInNext' || w.op === 'GetEnumeratedKeyedProperty') {
        if (w.op === 'ForInNext') keys.push(w.id);
        instructions.push(w.instruction);
      } else if (w.op === 'ForInStep') {
        pc.setExpr(w.id, () => ({ e: 'lit', v: 0, forInStep: true }));
        instructions.push(w.instruction);
      } else if (w.op === 'JumpIfForInDone' || w.op === 'JumpIfForInDoneConstant') {
        instructions.push(w.instruction);
      }
    }
    for (const kid of keys) {
      const kv = ir.values[kid];
      pc.setExpr(kid, () => ({ e: 'forInKey', obj: pc.E(pc.firstRegInput(kv)) }));
      pc.forceMaterialise(kid);
    }
    for (const i of instructions) if (i !== undefined) pc.consume(i);

    pc.claim({
      kind: 'forIn', blocks: [v.block], values: [v.id, enumerateId, ...keys],
      instructions, confidence: 'exact', cites: ['VisitForInStatement:3251'],
      detail: `${keys.length} key read(s)`,
    });
  }
}

export default { name: 'forin', run };
