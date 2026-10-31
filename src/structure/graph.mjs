// src/structure/graph.mjs
//
// The *structuring graph*: the one view of the CFG that control-flow
// structuring is allowed to look at.
//
// It differs from `ir`'s graph in four ways, each of them measured rather than
// stylistic:
//
// 1. **No exception edges.** ARCHITECTURE.md 10.6: exception edges are 20.95%
//    of all 2 107 268 corpus edges. They are in `succs` because dominance and
//    SSA are wrong without them, and they are wrong for `if`/`else` shape -- an
//    exception edge is not a branch the program takes, it is a trap. So the
//    walk view is built from `normalSuccs`/`normalPreds` (ARCHITECTURE.md 11.2
//    constraint 2).
//
// 2. **The generator resume dispatcher is gone** and every suspend is spliced
//    to its matching resume (see dispatcher.mjs). ARCHITECTURE.md 10.1: with
//    the dispatcher removed first, 0 of 239 979 functions are irreducible;
//    with loops structured first, 121 functions / 163 edges are, and every one
//    of them is a dispatcher artefact.
//
// 3. **One synthetic dominance edge per structured handler range**, from the
//    range's entry block to the handler block. A handler block has no normal
//    predecessors at all, so without it the handler region is unreachable from
//    the entry and `idom` is undefined there -- and the join after a
//    `try`/`catch` has no owner. The edge is only in the *dominance* view; the
//    walk view never offers it as a successor, so no chain can wander into a
//    handler except through the `try` construct that owns it.
//
// 4. **Parallel edges are collapsed.** `if (c) goto L; else goto L;` is two IR
//    edges and one successor. Readiness counting (regions.mjs) is per
//    predecessor *block*, so a block with two edges from the same predecessor
//    must count as in-degree one or it would never become ready.
//
// Dominators, post-dominators and natural loops are T6's
// (src/ir/dominators.mjs, src/ir/loops.mjs) run over this view -- ARCHITECTURE.md
// 11.6 says not to re-implement them, and this is the one thing it cannot
// supply ready-made, because `ir.idom` / `ir.loops` describe the graph
// *including* exception and resume edges.

import { dominators, postDominators } from '../ir/dominators.mjs';
import { findLoops } from '../ir/loops.mjs';

/**
 * @param {object} ir            the 8.4 IR
 * @param {{removedBlocks: Set<number>, removedEdges: Set<number>,
 *          splices: Array<{from:number,to:number,why:string,suspend:number,resume:number}>,
 *          entry: number, domExtraEdges: Array<{from:number,to:number,why:string}>}} plan
 */
export function structuringGraph(ir, plan) {
  const n = ir.blocks.length;
  const removedBlocks = plan.removedBlocks ?? new Set();
  const removedEdges = plan.removedEdges ?? new Set();
  const splices = plan.splices ?? [];
  const domExtra = plan.domExtraEdges ?? [];
  const entry = plan.entry;

  // ------------------------------------------------------------- walk view
  // successors, deduplicated by target block, with the IR edge(s) that back
  // each one. A removed block is skipped over: an edge into it is dropped, and
  // the structuring plan is responsible for having spliced around it.
  const succSets = Array.from({ length: n }, () => new Map());   // to -> [edge]
  for (const e of ir.edges) {
    if (e.kind === 'exception') continue;
    if (removedEdges.has(e.id)) continue;
    if (removedBlocks.has(e.from) || removedBlocks.has(e.to)) continue;
    const m = succSets[e.from];
    const l = m.get(e.to);
    if (l) l.push(e); else m.set(e.to, [e]);
  }
  for (const s of splices) {
    if (removedBlocks.has(s.from) || removedBlocks.has(s.to)) continue;
    if (!succSets[s.from].has(s.to)) succSets[s.from].set(s.to, []);
    succSets[s.from].synthetic = true;
  }

  const walkSuccs = Array.from({ length: n }, () => []);
  const walkPreds = Array.from({ length: n }, () => []);
  for (let b = 0; b < n; b++) {
    if (removedBlocks.has(b)) continue;
    for (const to of succSets[b].keys()) { walkSuccs[b].push(to); walkPreds[to].push(b); }
  }
  /** The IR edges backing the walk edge b -> to ([] for a synthetic splice). */
  const edgesOf = (from, to) => succSets[from].get(to) ?? null;

  // -------------------------------------------------------- dominance view
  const domSuccs = walkSuccs.map((a) => a.slice());
  const domPreds = walkPreds.map((a) => a.slice());
  for (const x of domExtra) {
    if (removedBlocks.has(x.from) || removedBlocks.has(x.to)) continue;
    if (!domSuccs[x.from].includes(x.to)) { domSuccs[x.from].push(x.to); domPreds[x.to].push(x.from); }
  }

  const domGraph = {
    n, entry,
    succs: (i) => domSuccs[i],
    preds: (i) => domPreds[i],
  };
  const dom = dominators(domGraph);

  let pdomCache = null;
  const pdom = () => (pdomCache ??= postDominators(domGraph));

  // ------------------------------------------------------- natural loops
  // T6's findLoops, over a shim shaped like a src/ir/cfg.mjs result. The shim
  // owns its own `kinds` arrays so the IR's blocks are never mutated.
  const shimEdges = [];
  const shimBlocks = Array.from({ length: n }, (_, i) => ({
    id: i,
    startOffset: ir.blocks[i].startOffset,
    preds: [], succs: [], outEdges: [], inEdges: [],
    kinds: [],
    terminator: ir.blocks[i].terminator
      ? { ...ir.blocks[i].terminator }
      : { opcode: null, isBackward: false, isJump: false, isSwitch: false, isConditional: false, endsFunction: true },
  }));
  for (let b = 0; b < n; b++) {
    if (removedBlocks.has(b)) continue;
    for (const to of walkSuccs[b]) {
      const backing = edgesOf(b, to);
      const e = {
        id: shimEdges.length, from: b, to,
        kind: backing && backing.length ? backing[0].kind : 'splice',
        irEdges: backing ? backing.map((x) => x.id) : [],
      };
      shimEdges.push(e);
      shimBlocks[b].succs.push(to); shimBlocks[to].preds.push(b);
      shimBlocks[b].outEdges.push(e.id); shimBlocks[to].inEdges.push(e.id);
    }
  }
  const shimCfg = {
    blocks: shimBlocks, edges: shimEdges, entry,
    handlers: [], instructions: [], stats: { generatorResumeEdges: 0 },
  };
  const loopInfo = findLoops(shimCfg, dom);

  const backEdge = new Set(loopInfo.backEdges.map((eid) => `${shimEdges[eid].from}>${shimEdges[eid].to}`));
  const isBackEdge = (from, to) => backEdge.has(`${from}>${to}`);

  // in-degree ignoring back edges: a loop header's extra predecessor is its
  // latch, which the loop construct consumes, so counting it would make the
  // header look like a join and would stop it from ever becoming ready.
  const inDeg = new Int32Array(n);
  for (let b = 0; b < n; b++) {
    if (removedBlocks.has(b)) continue;
    for (const to of walkSuccs[b]) if (!isBackEdge(b, to)) inDeg[to]++;
  }

  const loopOfHeader = new Map();
  for (const l of loopInfo.loops) loopOfHeader.set(l.header, l);

  return {
    ir, n, entry, removedBlocks, removedEdges, splices,
    walkSuccs, walkPreds, domSuccs, domPreds, edgesOf,
    dom, pdom, loopInfo, loops: loopInfo.loops, loopOfHeader,
    loopOf: loopInfo.loopOf, loopDepth: loopInfo.loopDepth,
    isBackEdge, inDeg,
    shimEdges,
    rpoNum: dom.rpoNum,
    reachable: (b) => !removedBlocks.has(b) && dom.rpoNum[b] >= 0,
    /** Blocks reachable in the walk view from `roots`, stopping at `stop`. */
    reach(roots, stop = null) {
      const seen = new Set();
      const st = [];
      for (const r of roots) if (!removedBlocks.has(r) && !(stop && stop.has(r))) { seen.add(r); st.push(r); }
      while (st.length) {
        const v = st.pop();
        for (const s of walkSuccs[v]) {
          if (seen.has(s)) continue;
          if (stop && stop.has(s)) continue;
          seen.add(s); st.push(s);
        }
      }
      return seen;
    },
  };
}

export default { structuringGraph };
