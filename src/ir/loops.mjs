// src/ir/loops.mjs
//
// Natural loops, the loop nesting forest, and the reducibility measurement.
//
// Definitions, all standard (Aho/Lam/Sethi/Ullman ch. 9.6):
//
//   back edge        n -> h where h dominates n
//   natural loop     {h} union every node that can reach a latch of h without
//                    passing through h
//   latch            the source of a back edge to h
//   exit edge        an edge out of the loop body
//   retreating edge  n -> h where h precedes n in the depth-first spanning
//                    tree, i.e. rpo(h) <= rpo(n)
//
// A graph is reducible iff every retreating edge is a back edge. ARCHITECTURE.md
// section 0 *asserts* reducibility because Ignition bytecode is emitted from an
// AST by a single-pass generator with no CFG rewriting. That is an argument,
// not a measurement, so every retreating edge whose target does not dominate it
// is recorded here with the opcode that produced it and reported by
// tools/ir/corpus_scan.mjs. If the number is 0 over all 239 979 functions, T8
// needs the goto fall-back only as insurance.
//
// Note on the back-edge count cross-check: V8 has exactly one backward branch
// opcode, JumpLoop (src/interpreter/bytecodes.h: IsForwardJump excludes it and
// nothing else), so a reducible CFG must have exactly as many back edges as it
// has reachable JumpLoop instructions. tools/ir/corpus_scan.mjs asserts that
// per function.

/**
 * @param {object} cfg          the src/ir/cfg.mjs result
 * @param {object} dom          the src/ir/dominators.mjs result for that cfg
 */
export function findLoops(cfg, dom) {
  const { blocks, edges } = cfg;
  const n = blocks.length;
  const backEdges = [];
  const retreatingEdges = [];
  const irreducible = [];

  for (const e of edges) {
    if (!dom.reachable(e.from) || !dom.reachable(e.to)) continue;
    const retreating = dom.rpoNum[e.to] <= dom.rpoNum[e.from];
    if (!retreating) continue;
    retreatingEdges.push(e.id);
    if (dom.dominates(e.to, e.from)) backEdges.push(e);
    else {
      irreducible.push({
        edge: e.id, from: e.from, to: e.to, kind: e.kind,
        fromOffset: blocks[e.from].startOffset,
        toOffset: blocks[e.to].startOffset,
        terminator: blocks[e.from].terminator?.opcode ?? null,
        // every node that reaches `to` without the dominator relation holding
        // is a second entry into the same cycle
        why: 'retreating edge whose target does not dominate its source',
      });
    }
  }

  // ------------------------------------------------- one loop per header
  const latchesByHeader = new Map();
  for (const e of backEdges) {
    const l = latchesByHeader.get(e.to) ?? [];
    l.push(e);
    latchesByHeader.set(e.to, l);
  }

  const preds = (i) => blocks[i].preds;
  const loops = [];
  for (const [header, back] of [...latchesByHeader.entries()].sort((a, b) => a[0] - b[0])) {
    // natural loop: backward closure from the latches, stopping at the header
    const inLoop = new Uint8Array(n);
    inLoop[header] = 1;
    const stack = [];
    for (const e of back) if (!inLoop[e.from]) { inLoop[e.from] = 1; stack.push(e.from); }
    while (stack.length) {
      const v = stack.pop();
      for (const p of preds(v)) {
        if (!dom.reachable(p) || inLoop[p]) continue;
        inLoop[p] = 1; stack.push(p);
      }
    }
    const body = [];
    for (let i = 0; i < n; i++) if (inLoop[i]) body.push(i);
    const exits = [];
    for (const b of body) {
      for (const eid of blocks[b].outEdges) {
        const e = edges[eid];
        if (!inLoop[e.to]) exits.push({ edge: e.id, from: e.from, to: e.to, kind: e.kind });
      }
    }
    loops.push({
      id: loops.length,
      header,
      latches: back.map((e) => e.from),
      backEdges: back.map((e) => e.id),
      body, bodySet: inLoop,
      exits,
      parent: null, children: [], depth: 0,
      // a loop whose body cannot leave: `while (true) {}` with no break
      endless: exits.length === 0,
    });
  }

  // ------------------------------------------------- the nesting forest
  // Parent = the smallest other loop whose body is a strict superset.
  const bySize = [...loops].sort((a, b) => a.body.length - b.body.length);
  for (const inner of bySize) {
    let best = null;
    for (const outer of bySize) {
      if (outer === inner) continue;
      if (outer.body.length <= inner.body.length) continue;
      if (!outer.bodySet[inner.header]) continue;
      // containment check; bodies of natural loops with different headers are
      // either nested or disjoint in a reducible graph, so one membership test
      // on the header would do, but check properly so an irreducible graph is
      // reported instead of silently producing a cyclic "forest".
      let contained = true;
      for (const b of inner.body) if (!outer.bodySet[b]) { contained = false; break; }
      if (!contained) continue;
      if (best === null || outer.body.length < best.body.length) best = outer;
    }
    inner.parent = best ? best.id : null;
  }
  for (const l of loops) if (l.parent !== null) loops[l.parent].children.push(l.id);
  // depth, by walking up; the forest property is asserted in src/ir/verify.mjs
  for (const l of loops) {
    let d = 0, p = l.parent, guard = 0;
    while (p !== null && guard++ <= loops.length) { d++; p = loops[p].parent; }
    l.depth = d;
  }

  // innermost loop per block, and the loop depth of each block
  const loopOf = new Int32Array(n).fill(-1);
  const loopDepth = new Int32Array(n);
  for (const l of [...loops].sort((a, b) => a.body.length - b.body.length)) {
    for (const b of l.body) if (loopOf[b] === -1) loopOf[b] = l.id;
  }
  for (let i = 0; i < n; i++) loopDepth[i] = loopOf[i] === -1 ? 0 : loops[loopOf[i]].depth + 1;

  // stamp the 8.4 block kind
  for (const l of loops) {
    const b = blocks[l.header];
    if (!b.kinds.includes('loopHeader')) b.kinds.push('loopHeader');
  }

  // ---------------------------------------------- classify every JumpLoop
  //
  // "Back edges must equal the JumpLoop count per function" is the obvious
  // cross-check against the disassembler, and it is false. JumpLoop is V8's
  // only backward branch, so every reachable one points backwards in OFFSET
  // space -- but that is not the same as pointing backwards in the CFG. In an
  // async function whose `await` is inside the loop, the loop body ends in
  // `SuspendGenerator`, which RETURNS, so the body has no path back to the
  // header: one invocation's CFG is acyclic and the loop is closed at runtime
  // only by re-entering the function through the resume dispatcher. The
  // JumpLoop edge is then a perfectly ordinary forward edge.
  //
  // So each reachable JumpLoop edge is classified instead, and the count that
  // has to add up is the classification, not the back-edge total.
  const backEdgeIds = new Set(backEdges.map((e) => e.id));
  const jumpLoop = { total: 0, backEdge: 0, irreducible: 0, cycleBrokenBySuspend: 0, other: 0, otherExamples: [] };
  const canReach = (from, to) => {
    if (from === to) return true;
    const seen = new Uint8Array(n);
    const st = [from]; seen[from] = 1;
    while (st.length) {
      const v = st.pop();
      for (const s of blocks[v].succs) {
        if (s === to) return true;
        if (!seen[s]) { seen[s] = 1; st.push(s); }
      }
    }
    return false;
  };
  for (const e of edges) {
    const src = blocks[e.from];
    if (!src.terminator?.isBackward) continue;
    // Only the branch itself, not an exception edge that also leaves the
    // block. JumpLoop cannot raise, so the precise exception model never gives
    // it one; the coarse model of ARCHITECTURE.md 4.2 gives every block in a
    // range an exception edge and would otherwise double-count here.
    if (e.kind === 'exception') continue;
    if (!dom.reachable(e.from) || !dom.reachable(e.to)) continue;
    jumpLoop.total++;
    if (backEdgeIds.has(e.id)) jumpLoop.backEdge++;
    else if (!canReach(e.to, e.from)) jumpLoop.cycleBrokenBySuspend++;
    else {
      // A cycle exists but the JumpLoop target does not dominate its source,
      // so the cycle has more than one entry: the region is irreducible by
      // definition. Whether THIS edge is also the retreating edge the
      // depth-first numbering happened to pick is a property of the traversal,
      // not of the graph, so it is not used to classify.
      jumpLoop.irreducible++;
      if (jumpLoop.otherExamples.length < 3) {
        jumpLoop.otherExamples.push({
          edge: e.id, from: e.from, to: e.to,
          fromOffset: src.startOffset, toOffset: blocks[e.to].startOffset,
          retreatingInThisDfs: dom.rpoNum[e.to] <= dom.rpoNum[e.from],
        });
      }
    }
  }

  const maxDepth = loops.length ? Math.max(...loops.map((l) => l.depth)) + 1 : 0;
  return {
    loops, backEdges: backEdges.map((e) => e.id), retreatingEdges,
    irreducible, loopOf, loopDepth, jumpLoop,
    stats: {
      generatorResumeEdges: cfg.stats.generatorResumeEdges,
      jumpLoopEdges: jumpLoop.total,
      jumpLoopBackEdges: jumpLoop.backEdge,
      jumpLoopIrreducible: jumpLoop.irreducible,
      jumpLoopCycleBrokenBySuspend: jumpLoop.cycleBrokenBySuspend,
      jumpLoopUnclassified: jumpLoop.other,
      loops: loops.length,
      backEdges: backEdges.length,
      retreatingEdges: retreatingEdges.length,
      irreducibleBackEdges: irreducible.length,
      maxNestingDepth: maxDepth,
      endlessLoops: loops.filter((l) => l.endless).length,
      multiLatchLoops: loops.filter((l) => l.latches.length > 1).length,
      multiExitLoops: loops.filter((l) => l.exits.length > 1).length,
    },
  };
}

/**
 * Re-measure reducibility with the generator resume dispatcher's jump-table
 * edges removed.
 *
 * ARCHITECTURE.md 4.4.6 tells T8 to delete the dispatcher and turn each
 * suspend point back into `yield` / `await`. If the CFG is reducible once
 * those edges are gone, then every irreducible function in the corpus is
 * irreducible *because of* the dispatcher, the fix is already in the plan, and
 * the only thing the plan needs is an ordering constraint: remove the
 * dispatcher before structuring, not after. That is a much more useful answer
 * than "N functions are irreducible", so it is measured rather than argued.
 *
 * The dispatcher's fall-through edge (the first call into the generator) is
 * kept; only the resume edges go.
 *
 * @returns {{irreducible: Array, reachable: number, removedEdges: number}}
 */
export function reducibilityWithoutGeneratorResume(cfg, dominatorsFn) {
  const { blocks, edges } = cfg;
  const n = blocks.length;
  const removed = new Set();
  for (const e of edges) if (e.kind === 'switch' && e.generatorResume) removed.add(e.id);
  if (!removed.size) return { irreducible: [], reachable: null, removedEdges: 0, unchanged: true };

  const succs = (i) => blocks[i].outEdges.filter((eid) => !removed.has(eid)).map((eid) => edges[eid].to);
  const preds = (i) => blocks[i].inEdges.filter((eid) => !removed.has(eid)).map((eid) => edges[eid].from);
  const dom = dominatorsFn({ n, entry: 0, succs, preds });
  const irreducible = [];
  for (const e of edges) {
    if (removed.has(e.id)) continue;
    if (!dom.reachable(e.from) || !dom.reachable(e.to)) continue;
    if (dom.rpoNum[e.to] > dom.rpoNum[e.from]) continue;
    if (dom.dominates(e.to, e.from)) continue;
    irreducible.push({
      edge: e.id, from: e.from, to: e.to, kind: e.kind,
      fromOffset: blocks[e.from].startOffset, toOffset: blocks[e.to].startOffset,
      terminator: blocks[e.from].terminator?.opcode ?? null,
    });
  }
  return { irreducible, reachable: dom.rpo.length, removedEdges: removed.size, unchanged: false };
}

export default { findLoops, reducibilityWithoutGeneratorResume };
