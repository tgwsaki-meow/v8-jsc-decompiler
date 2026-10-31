// src/recover/inline.mjs
//
// ARCHITECTURE.md 4.3.2, the constrained inlining, and 4.3's small
// `duplicable` class. The baseline got both backwards: 12.93% of
// side-effecting calls were re-evaluated and 50.27% of allocations lost their
// identity (worst case: one object expression copied 22 times). Those are
// metrics 6 and 7 and they have to be 0.
//
// Two separate decisions, and it matters that they are separate:
//
//   DUPLICABLE -- may appear at more than one use site.
//     Only "pure, cheap, identity-free": a literal, a constant-pool constant,
//     an immutable context-slot read, an identifier. Decided from `ir.sem`,
//     never from an opcode name:
//
//        allocationKind === 'none'          no identity to lose
//        && !hasEffect                      nothing observable happens
//        && effect.reads.length === 0       not order-sensitive, so a mutable
//                                           context read is excluded and an
//                                           Immutable* one is not
//        && the transcribed Expr is a leaf  (lit / name / this / newTarget /
//                                           importMeta / regexp-free)
//
//     The last clause is the "cheap" of 4.3: a pure arithmetic tree over three
//     calls is identity-free but duplicating it duplicates the calls, and the
//     calls are what the 12.93% measured. `GetTemplateObject` is
//     allocationKind 'cached' and still not duplicated, because its op is in
//     the effect chain; its *value* is safe to name once and reuse.
//
//   INLINABLE -- may be moved from its definition point to its single use.
//     Exactly 4.3.2:
//        the value has exactly one use, AND
//        the definition dominates the use, AND
//        nothing interferes on the effect chain in between.
//
//     The third clause, made precise: if the definition is in the effect chain
//     it may only move forward over chain members that are themselves being
//     inlined into the same use, in evaluation order. That is the stack
//     discipline the bytecode was emitted with -- `VisitArguments` evaluates
//     arguments left to right into consecutive registers, so the chain
//     immediately before a call is exactly its effectful arguments in order --
//     and it is why `f(g(), h())` comes back whole while `f(g(), x)` with an
//     unrelated `k()` between them does not and `g()` gets a named temp.
//
// Everything that is neither duplicable nor inlinable is MATERIALISED: it gets
// a name from names.mjs and one statement at its definition point. That is the
// "物化成命名临时变量" of 4.3, and it is what makes invariant 11.3.4
// ("an ssaId appears more than once iff it is duplicable") hold by
// construction rather than by hope.

/** Expr tags that are cheap enough to copy. */
const LEAF_EXPRS = new Set(['lit', 'name', 'this', 'newTarget', 'importMeta', 'super']);

export function isLeafExpr(x) {
  if (!x || typeof x !== 'object') return false;
  return LEAF_EXPRS.has(x.e);
}

/**
 * Is this value's *definition* safe to copy to several use sites?
 * `v` is an SSA value; `expr` its transcription (may be absent).
 */
export function isDuplicable(v, expr) {
  if (!v) return false;
  // Frame entries and parameters are names: always duplicable.
  if (v.kind === 'Param' || v.kind === 'FrameEntry') return true;
  if (v.kind === 'Phi' || v.kind === 'EffectPhi' || v.kind === 'EffectEntry') return false;
  if (v.kind === 'CaughtException') return true;        // a named binding
  if (v.kind === 'ContextSlot') return true;            // a location, i.e. a name
  if (v.kind === 'Proj') return false;                  // its op's identity
  if (v.kind !== 'Op') return false;

  if (v.allocationKind !== 'none') return false;        // definite / maybe / cached
  if (v.hasEffect) return false;
  if ((v.effect?.reads?.length ?? 0) !== 0) return false;
  return isLeafExpr(expr);
}

/**
 * The inlining decision for a whole function.
 *
 * @param {object} cx {ir, canon, usesOf, exprOf, consumedIns, isMove}
 * @returns {{inlined:Set<number>, materialised:Set<number>, duplicable:Set<number>,
 *            reasons:Map<number,string>, stats:object}}
 */
export function planInlining(cx) {
  const { ir } = cx;
  const values = ir.values;
  const inlined = new Set();
  const materialised = new Set();
  const duplicable = new Set();
  const reasons = new Map();
  const inlineTarget = new Map();     // def -> the use it was inlined into
  const stats = {
    candidates: 0, inlined: 0, materialised: 0, duplicable: 0,
    blockedByEffectOrder: 0, blockedByMultipleUses: 0, blockedByDominance: 0,
    allocationsMaterialised: 0, callsMaterialised: 0,
  };

  // ---------------------------------------------------------------- phase 1
  // The duplicable class. Independent of use counts: it is a property of the
  // value, which is what lets a literal appear in ten places.
  for (const v of values) {
    if (!v) continue;
    if (isDuplicable(v, cx.exprOf(v.id))) { duplicable.add(v.id); }
  }
  stats.duplicable = duplicable.size;

  // ---------------------------------------------------------------- phase 2
  // Walk every block in reverse postorder; inside a block walk instructions
  // backwards, and for each op try to absorb its operands.
  //
  // The chain cursor is the position in `block.effects` immediately before the
  // op being considered. An effectful definition may only be absorbed when it
  // sits exactly at the cursor, i.e. nothing else ran between it and the use.
  //
  // The chain used here is `block.effects` with the instructions an idiom
  // consumed REMOVED. Those emit nothing at their own position (the statement
  // pass skips a consumed instruction before it ever looks at an override), so
  // they are not something a definition can be reordered across: either the
  // idiom dropped the effect -- a TDZ check, the context plumbing, the
  // `finally` message save -- or it folded the effect into the rewritten
  // expression of another value, and *that* value is the chain member the
  // ordering has to respect. Leaving them in is what made
  //
  //     LdaCurrentContextSlot [2] ; ThrowReferenceErrorIfHole 'later' ; Return
  //
  // print `let later$3 = later; return later$3`: the consumed TDZ check sat
  // between the load and the return and read as an intervening effect.
  const chainPos = new Map();         // ssaId -> index in its block's live chain
  const liveChain = new Map();        // blockId -> [ssaId] with consumed removed
  for (const b of ir.blocks) {
    const live = [];
    for (const vid of b.effects ?? []) {
      const v = values[vid];
      if (v && v.instruction !== undefined && cx.consumedIns.has(v.instruction)) continue;
      chainPos.set(vid, live.length);
      live.push(vid);
    }
    liveChain.set(b.id, live);
  }

  // For every instruction, the live-chain index of the last member strictly
  // before it. One linear pass per block: scanning the chain per instruction
  // instead made a single-block function quadratic in its own length, and the
  // corpus has 10 MB files whose biggest function is one block.
  const chainBefore = new Int32Array(ir.instructions.length).fill(-1);
  for (const b of ir.blocks) {
    const live = liveChain.get(b.id) ?? [];
    let at = 0;
    for (let i = b.first; i <= b.last && i < chainBefore.length; i++) {
      while (at < live.length && values[live[at]].instruction < i) at++;
      chainBefore[i] = at - 1;
    }
  }

  for (const bid of ir.dominators.rpo) {
    const b = ir.blocks[bid];
    for (let i = b.last; i >= b.first; i--) {
      const vid = ir.instructionValue[i];
      if (vid < 0) continue;
      const use = values[vid];
      if (!use || use.kind !== 'Op') continue;
      if (cx.isMove(use)) continue;              // a copy absorbs nothing
      if (cx.consumedIns.has(i)) continue;       // an idiom owns this one

      // where the chain stands just before this use
      let cursor = chainPos.has(vid) ? chainPos.get(vid) - 1 : chainBefore[i];

      // inputs in evaluation order; absorb from the last one backwards
      const ins = cx.canonicalInputs(use);
      for (let slot = ins.length - 1; slot >= 0; slot--) {
        const defId = ins[slot];
        if (defId === null || defId === undefined || defId < 0) continue;
        const def = values[defId];
        if (!def) continue;
        if (duplicable.has(defId)) continue;     // no decision needed
        if (inlined.has(defId) || materialised.has(defId)) continue;
        stats.candidates++;

        // "use only once" counts OCCURRENCES, not distinct user instructions.
        // `f() ; r1 + r1` is one user and two uses, and inlining there would
        // print the call twice -- which is exactly the 12.93% the baseline
        // measured. An occurrence inside an instruction an idiom consumed does
        // not count: the idiom's rewritten expression decides whether that
        // operand is mentioned at all, so the operand's remaining live
        // occurrences are what the decision has to be made on.
        const occ = cx.occurrencesOf(defId);
        if (occ !== 1) { stats.blockedByMultipleUses++; markMaterialised(defId, occ > 1 ? 'multipleUses' : 'noLiveUse'); continue; }
        if (cx.occurrencesIn(defId, vid) !== 1) { markMaterialised(defId, 'useMismatch'); continue; }
        if (!dominates(ir, def, use)) { stats.blockedByDominance++; markMaterialised(defId, 'defDoesNotDominateUse'); continue; }

        const defInChain = chainPos.has(defId);
        if (defInChain) {
          if (def.block !== b.id) { stats.blockedByEffectOrder++; markMaterialised(defId, 'effectfulDefInAnotherBlock'); continue; }
          if (chainPos.get(defId) !== cursor) { stats.blockedByEffectOrder++; markMaterialised(defId, 'interveningEffect'); continue; }
          cursor--;
        }
        inlined.add(defId);
        inlineTarget.set(defId, vid);
        reasons.set(defId, defInChain ? 'inlinedNextEffectConsumer' : 'inlinedPure');
        stats.inlined++;
      }
    }
  }

  // ---------------------------------------------------------------- phase 3
  //
  // Anything still undecided. Three cases, and the third is the one that keeps
  // a desugaring honest:
  //
  //   >1 live occurrence   materialise (it could not be inlined above)
  //    1 live occurrence   materialise (the absorb pass declined it)
  //    0 live occurrences  the value is referenced only by instructions an
  //                        idiom consumed. If it is PURE, nothing is emitted
  //                        for it -- the idiom's rewritten expression inlines
  //                        it if it mentions it, and drops it otherwise. If it
  //                        has an EFFECT, it is materialised: the effect
  //                        happened and must appear exactly once, whether or
  //                        not the idiom's expression mentions its value.
  for (const v of values) {
    if (!v) continue;
    const id = v.id;
    if (duplicable.has(id) || inlined.has(id) || materialised.has(id)) continue;
    if (v.kind === 'EffectPhi' || v.kind === 'EffectEntry' || v.kind === 'ContextSlot') continue;
    if (cx.isMove(v)) continue;
    const k = cx.occurrencesOf(id);
    if (k === 0) {
      if (v.hasEffect && cx.hasConsumedUser(id)) {
        markMaterialised(id, 'effectReferencedOnlyByAnIdiom');
        stats.effectOnlyUnderIdiom = (stats.effectOnlyUnderIdiom ?? 0) + 1;
      }
      continue;
    }
    markMaterialised(id, 'notInlinable');
  }

  for (const id of materialised) {
    const v = values[id];
    if (v?.allocationKind === 'definite') stats.allocationsMaterialised++;
    if (v?.effect?.callsUserCode) stats.callsMaterialised++;
  }
  stats.inlinedTotal = inlined.size;
  stats.materialised = materialised.size;

  function markMaterialised(id, why) {
    materialised.add(id);
    if (!reasons.has(id)) reasons.set(id, why);
  }

  return { inlined, materialised, duplicable, reasons, inlineTarget, stats };
}

/**
 * Does `def` dominate `use`? Inside one block it is instruction order; across
 * blocks it is T6's O(1) dominator-tree query.
 */
export function dominates(ir, def, use) {
  const db = def.block, ub = use.block;
  if (db === undefined || ub === undefined) return false;
  if (db === ub) {
    const di = def.instruction, ui = use.instruction;
    if (di === undefined) return true;              // a phi / entry value
    if (ui === undefined) return false;
    return di < ui;
  }
  return ir.dominators.dominates
    ? ir.dominators.dominates(db, ub)
    : legacyDominates(ir, db, ub);
}

function legacyDominates(ir, a, b) {
  let x = b;
  for (let guard = 0; guard < ir.blocks.length + 2; guard++) {
    if (x === a) return true;
    const next = ir.idom[x];
    if (next === x || next === undefined || next < 0) return false;
    x = next;
  }
  return false;
}

export default { planInlining, isDuplicable, isLeafExpr, dominates };
