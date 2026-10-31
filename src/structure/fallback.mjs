// src/structure/fallback.mjs
//
// The honest `unstructured` region (ARCHITECTURE.md 4.4.7).
//
//   { r:'unstructured', blocks:[id], dispatchVar, why }
//
// T9 emits it as `while (true) switch (__pc) { ... }` with an
// `/* UNSTRUCTURED */` marker, every block becoming one `case` that assigns
// the next `__pc` and falls back to the dispatch. That is a direct, correct
// interpretation of the CFG -- correct-but-ugly, which ARCHITECTURE.md 4.4.7
// accepts; silently-wrong, which it does not.
//
// Scope. The fall-back is whole-function, not per-region, and that is a
// deliberate choice rather than laziness: a partial tree with an
// `unstructured` tail would need `__pc` to be live across the boundary between
// structured and unstructured code, i.e. the structured part would have to
// assign it on every edge that crosses into the region. Covering the whole
// function makes `__pc` entirely local to the dispatch and keeps 11.3
// invariant 1 trivially checkable. It costs structure on a function that
// fails, and the measured cost of that is in docs/STRUCTURE.md: after stage 1
// the corpus is fully reducible (docs/IR.md section 9: 0 of 239 979 functions
// irreducible once the resume dispatcher is gone), so this should fire on
// nothing, and its count is reported either way.
//
// `dispatchVar` is a name, not an SSA id: there is no bytecode register for
// it. It is derived from the entry block so two runs over the same input
// produce the same name, which O2 checks.

/**
 * @param {object} ir
 * @param {object} g          the structuring graph
 * @param {number[]} blocks   the blocks the region covers
 * @param {string} why        a short, stable reason code
 * @param {object} detail
 */
export function unstructuredRegion(ir, g, blocks, why, detail = {}) {
  const inside = new Set(blocks);
  const ordered = [...inside].sort((a, b) => {
    const ra = g.rpoNum[a], rb = g.rpoNum[b];
    if (ra >= 0 && rb >= 0 && ra !== rb) return ra - rb;
    if (ra !== rb) return (ra < 0 ? 1 : 0) - (rb < 0 ? 1 : 0);
    return a - b;
  });
  return {
    r: 'unstructured',
    blocks: ordered,
    dispatchVar: `__pc${g.entry}`,
    why,
    detail,
    /** Successors per block, so T9 does not have to re-derive the dispatch. */
    edges: ordered.map((b) => ({
      block: b,
      succs: g.walkSuccs[b].filter((s) => inside.has(s)),
      exits: g.walkSuccs[b].filter((s) => !inside.has(s)),
    })),
    entry: g.entry,
  };
}

export default { unstructuredRegion };
