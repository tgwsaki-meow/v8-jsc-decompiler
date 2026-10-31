// src/ir/effects.mjs
//
// The effect graph: a total order inside each block over the ops that read or
// write observable state, merged across blocks along the CFG.
//
// Membership is decided by src/ir/opcode_effects.mjs, not by a name test: an
// op joins the chain when it writes an effect kind, can throw, can enter user
// code, or reads an effect kind. That covers exactly what ARCHITECTURE.md 4.2
// lists -- property load and store, call, construct, throw, context store,
// generator suspend, delete, `in`, and the conversions that can trigger
// ToPrimitive -- plus two it does not mention and which matter:
//
//   * context *loads*. A mutable context slot read must not be hoisted across
//     a store to the same context. 8.4 only has one boolean, `hasEffect`,
//     which cannot say "pure but order-sensitive", so a load has
//     hasEffect:false and still appears in the chain, with its read kind on
//     `effect.reads`. The Immutable* loads are genuinely pure and stay out.
//   * SetPendingMessage. The finally desugaring saves and restores the
//     isolate's pending message around the cleanup block; reordering it
//     silently changes which exception propagates.
//
// The cross-block merge is memory SSA: a single "effect" variable, phis placed
// by the same dominance-frontier algorithm the value SSA uses (unpruned here,
// because the effect state is live everywhere). So effectExit(b) is one value
// id rather than a set, which keeps the structure O(blocks) instead of
// O(blocks^2) on a function with thousands of blocks, and gives T7 an O(1)
// "what is the effect state at this point" query.

/**
 * @param {object} ctx {cfg, dom, ssa}
 */
export function buildEffects(ctx) {
  const { cfg, dom, ssa } = ctx;
  const { blocks, edges, instructions } = cfg;
  const values = ssa.values;
  const nBlocks = blocks.length;

  const mk = (v) => { const id = values.length; values.push({ id, ...v }); return values[id]; };

  // ------------------------------------------------- in-block total order
  const blockEffects = Array.from({ length: nBlocks }, () => []);
  for (const b of blocks) {
    if (!dom.reachable(b.id)) continue;
    for (let i = b.first; i <= b.last; i++) {
      const vid = ssa.instructionValue[i];
      if (vid < 0) continue;
      const v = values[vid];
      if (v.kind === 'Op' && v.inEffectChain) blockEffects[b.id].push(vid);
    }
  }

  // --------------------------------------------------------- memory phis
  const defBlocks = [];
  for (const b of blocks) if (blockEffects[b.id].length) defBlocks.push(b.id);
  const hasPhi = new Uint8Array(nBlocks);
  const work = [...defBlocks];
  if (dom.reachable(0)) work.push(0);
  const queued = new Uint8Array(nBlocks);
  for (const b of work) queued[b] = 1;
  while (work.length) {
    const x = work.pop();
    for (const y of dom.domFrontier[x] ?? []) {
      if (hasPhi[y] || y === 0) continue;
      if (!dom.reachable(y)) continue;
      hasPhi[y] = 1;
      if (!queued[y]) { queued[y] = 1; work.push(y); }
    }
  }

  const effectPhi = new Int32Array(nBlocks).fill(-1);
  for (const b of blocks) {
    if (!hasPhi[b.id]) continue;
    const p = mk({
      kind: 'EffectPhi', block: b.id, operands: new Array(b.preds.length).fill(null),
      hasEffect: true, allocatesIdentity: false, allocationKind: 'none', inEffectChain: true,
    });
    effectPhi[b.id] = p.id;
  }

  // ------------------------------------------------- entry / exit per block
  // The initial effect state: an opaque definition standing for everything
  // that happened before the call.
  const effectEntryValue = mk({
    kind: 'EffectEntry', block: 0, hasEffect: true, allocatesIdentity: false,
    allocationKind: 'none', inEffectChain: true, what: 'stateOnFunctionEntry',
  }).id;

  const effectIn = new Int32Array(nBlocks).fill(-1);
  const effectOut = new Int32Array(nBlocks).fill(-1);
  // Walk the dominator tree: effectIn(b) is the phi if there is one, otherwise
  // effectOut(idom(b)).
  const stack = dom.reachable(0) ? [0] : [];
  while (stack.length) {
    const id = stack.pop();
    const inVal = effectPhi[id] >= 0 ? effectPhi[id]
      : (id === 0 ? effectEntryValue : effectOut[dom.idom[id]]);
    effectIn[id] = inVal;
    const chain = blockEffects[id];
    effectOut[id] = chain.length ? chain[chain.length - 1] : inVal;
    for (const c of dom.children[id] ?? []) stack.push(c);
  }

  // phi operands, per edge
  for (const b of blocks) {
    if (!dom.reachable(b.id)) continue;
    for (const eid of b.outEdges) {
      const e = edges[eid];
      if (!dom.reachable(e.to)) continue;
      const pid = effectPhi[e.to];
      if (pid < 0) continue;
      const j = ssa.predIndexOfEdge[eid];
      values[pid].operands[j] = effectOut[b.id];
    }
  }

  // ------------------------------------------------- the global order index
  const effectOrder = [];
  const effectIndex = new Map();
  for (const id of dom.rpo) {
    if (effectPhi[id] >= 0) {
      effectIndex.set(effectPhi[id], { block: id, pos: -1, global: effectOrder.length });
      effectOrder.push(effectPhi[id]);
    }
    blockEffects[id].forEach((vid, pos) => {
      effectIndex.set(vid, { block: id, pos, global: effectOrder.length });
      effectOrder.push(vid);
    });
  }

  // ------------------------------------------------- the interference query
  //
  // Conservative and cheap: everything in the chain that could run after `a`
  // and before `b`. "Could" is block reachability, so a path that cannot
  // actually be taken is still counted -- which keeps T7's inlining safe.
  const succOf = (i) => blocks[i].succs;
  const reachableFrom = (from) => {
    const seen = new Uint8Array(nBlocks);
    const st = [from]; seen[from] = 1;
    while (st.length) { const v = st.pop(); for (const s of succOf(v)) if (!seen[s]) { seen[s] = 1; st.push(s); } }
    return seen;
  };

  function interferingEffects(aId, bId, opts = {}) {
    const ai = effectIndex.get(aId) ?? positionOf(aId);
    const bi = effectIndex.get(bId) ?? positionOf(bId);
    if (!ai || !bi) return null;
    const kinds = opts.kinds ?? null;        // null = any effect
    const fwd = reachableFrom(ai.block);
    const out = [];
    for (const id of effectOrder) {
      const p = effectIndex.get(id);
      if (!fwd[p.block]) continue;
      if (p.block === ai.block && p.pos <= ai.pos) continue;
      if (p.block === bi.block && p.pos >= bi.pos) continue;
      if (p.global <= ai.global && p.block !== bi.block) continue;
      const v = values[id];
      if (kinds && v.effect) {
        const touches = [...(v.effect.writes ?? []), ...(v.effect.reads ?? [])].some((k) => kinds.includes(k));
        if (!touches && !v.effect.callsUserCode) continue;
      }
      out.push(id);
    }
    return out;
  }
  function positionOf(id) {
    const v = values[id];
    if (!v) return null;
    if (v.block === undefined) return null;
    const b = v.block;
    if (v.kind === 'Op' || v.kind === 'Proj') {
      // not itself in the chain: locate it by instruction order
      const chain = blockEffects[b];
      let pos = -1;
      for (let i = 0; i < chain.length; i++) {
        if (values[chain[i]].instruction <= v.instruction) pos = i;
      }
      return { block: b, pos, global: -1 };
    }
    return { block: b, pos: -1, global: -1 };
  }

  const effectKindCounts = {};
  let allocating = 0, effectful = 0, chainOps = 0;
  let phiCount = 0;
  for (const x of effectPhi) if (x >= 0) phiCount++;
  for (const v of values) {
    if (v.kind !== 'Op') continue;
    if (v.hasEffect) effectful++;
    if (v.allocatesIdentity) allocating++;
    if (v.inEffectChain) chainOps++;
    for (const k of v.effect?.writes ?? []) effectKindCounts[`w:${k}`] = (effectKindCounts[`w:${k}`] ?? 0) + 1;
    for (const k of v.effect?.reads ?? []) effectKindCounts[`r:${k}`] = (effectKindCounts[`r:${k}`] ?? 0) + 1;
  }

  return {
    blockEffects, effectPhi, effectIn, effectOut, effectOrder, effectIndex,
    effectEntryValue, interferingEffects,
    stats: {
      effectChainOps: chainOps,
      effectPhis: phiCount,
      effectfulOps: effectful,
      allocatingOps: allocating,
      effectKindCounts,
      instructions: instructions.length,
    },
  };
}

export default { buildEffects };
