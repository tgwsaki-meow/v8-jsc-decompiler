// src/recover/dce.mjs
//
// ARCHITECTURE.md 4.3 step 1: a definition with no side effect and no use is
// dropped.
//
// "No side effect" is read off `ir.sem`, not off a name:
//
//     live  <=>  hasEffect  ||  effect.reads.length > 0  ||  effect.diverges
//                ||  some use is live
//
// `effect.reads` has to count: a mutable context-slot load is `hasEffect:false`
// and still sits in the effect chain (docs/IR.md 7), so dropping an unused one
// is safe but dropping it *silently* would hide the fact that the function read
// a variable. It is dropped and counted under `readOnlyDropped`.
//
// The iteration is a worklist from the live roots backwards over `inputs`,
// which is the standard formulation and terminates because liveness only
// grows. Roots:
//
//     every value whose op hasEffect / throws / callsUserCode / diverges
//     every terminator's inputs (the branch predicate, the returned value)
//     every phi operand of a live phi
//     every context-slot store
//     every instruction a pattern consumed (the pattern decided it matters)
//
// Note what is NOT a root: a `Star` whose value is never read. V8 allocates a
// register for every intermediate, so a function that computes `a.b.c` leaves
// three dead copies behind; dropping them is the difference between readable
// output and a transcript of the register file.

export function deadValues(cx) {
  const { ir } = cx;
  const values = ir.values;
  const live = new Uint8Array(values.length);
  const work = [];
  const push = (id) => {
    if (id === null || id === undefined || id < 0 || id >= values.length) return;
    if (live[id]) return;
    live[id] = 1;
    work.push(id);
  };

  const stats = { total: 0, live: 0, dead: 0, readOnlyDropped: 0, movesDropped: 0 };

  for (const v of values) {
    if (!v) continue;
    stats.total++;
    if (v.kind === 'Op') {
      const e = v.effect ?? {};
      if (v.hasEffect || e.diverges) push(v.id);
      // a terminator's own inputs are live even when its value is not
      const ins = ir.instructions[v.instruction];
      if (ins && (ins.jumpTarget !== null && ins.jumpTarget !== undefined)) push(v.id);
      if (ins && ins.jumpTable && ins.jumpTable.length) push(v.id);
    } else if (v.kind === 'EffectPhi' || v.kind === 'EffectEntry') {
      push(v.id);
    } else if (v.kind === 'CaughtException') {
      push(v.id);
    }
  }
  for (const i of cx.consumedIns) {
    const vid = ir.instructionValue[i];
    if (vid >= 0) push(vid);
  }
  // a value some pattern rewrote into an expression is live by construction
  for (const id of cx.patternValues) push(id);

  while (work.length) {
    const id = work.pop();
    const v = values[id];
    if (!v) continue;
    if (v.kind === 'Op') {
      for (const inId of v.inputs ?? []) push(inId);
    } else if (v.kind === 'Phi') {
      for (const o of v.operands ?? []) push(o);
    } else if (v.kind === 'Proj') {
      push(v.of);
    } else if (v.kind === 'EffectPhi') {
      for (const o of v.operands ?? []) push(o);
    } else if (v.kind === 'ContextSlot') {
      for (const l of v.loads ?? []) push(l);
      for (const s of v.stores ?? []) push(s);
    }
  }

  const dead = new Set();
  for (const v of values) {
    if (!v) continue;
    if (live[v.id]) { stats.live++; continue; }
    stats.dead++;
    dead.add(v.id);
    if (v.kind === 'Op') {
      if (cx.isMove(v)) stats.movesDropped++;
      else if ((v.effect?.reads?.length ?? 0) > 0) stats.readOnlyDropped++;
    }
  }
  return { dead, live, stats };
}

export default { deadValues };
