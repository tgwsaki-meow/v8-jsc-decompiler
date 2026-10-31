// src/ir/dominators.mjs
//
// Dominators, dominance frontiers, post-dominators and immediate
// post-dominators, plus a deliberately slow oracle for each.
//
// Algorithm: Keith D. Cooper, Timothy J. Harvey and Ken Kennedy, "A Simple,
// Fast Dominance Algorithm", Rice University technical report TR-06-33870
// (2001). Iterate the data-flow equation
//
//     idom(b) = intersect over processed predecessors p of b
//
// in reverse postorder until nothing changes, where `intersect` is the
// two-finger walk up the partially built dominator tree comparing postorder
// numbers. It is chosen over Lengauer-Tarjan for the reason the paper gives:
// on the control-flow graphs real compilers see it is as fast or faster, and it
// is short enough to be obviously right.
//
// Post-dominators are the same algorithm on the reverse graph rooted at a
// virtual exit. ARCHITECTURE.md 4.4 needs immediate post-dominators to divide
// an acyclic region into if/else, and src/relooper.js's `_findMergeBlock`
// -- "the lowest-numbered block reachable from both branches" -- is not that.
// So ipdom is computed here and checked against the oracle below.
//
// The virtual exit
// ----------------
// A function has many exits (one per Return, Throw and ReThrow) and may have
// blocks that reach none of them (`while (true) {}` with no break). Without a
// single sink, post-dominance is not a tree. The fix is the standard one plus
// one extra rule:
//
//   * every block with no successors gets an edge to EXIT;
//   * while some block cannot reach EXIT, the one with the highest reverse
//     postorder number among them gets an edge to EXIT, and we recompute.
//
// The second rule terminates (each round connects at least one block) and is
// deterministic. On a single endless loop it picks the latch, which is the
// block an emitter would have to break out of, so the resulting tree is the
// one a structuring pass wants. The number of edges it had to invent is
// reported as `virtualExitEdges`, never hidden.

/**
 * @typedef {{n: number, succs: (i:number)=>Iterable<number>, preds: (i:number)=>Iterable<number>, entry: number}} Graph
 */

/** Reverse postorder of the nodes reachable from `entry`, plus the numbering. */
export function reversePostorder(graph) {
  const { n, succs, entry } = graph;
  const state = new Uint8Array(n);          // 0 new, 1 on stack, 2 done
  const order = [];
  // Iterative DFS with an explicit successor cursor, so a 100k-block function
  // cannot blow the JS stack.
  const stack = [entry];
  const iter = new Array(n);
  state[entry] = 1;
  iter[entry] = [...succs(entry)];
  let cursor = new Int32Array(n);
  while (stack.length) {
    const v = stack[stack.length - 1];
    const ss = iter[v];
    if (cursor[v] < ss.length) {
      const w = ss[cursor[v]++];
      if (state[w] === 0) {
        state[w] = 1;
        iter[w] = [...succs(w)];
        stack.push(w);
      }
    } else {
      state[v] = 2;
      order.push(v);
      stack.pop();
    }
  }
  order.reverse();                          // postorder reversed
  const rpoNum = new Int32Array(n).fill(-1);
  for (let i = 0; i < order.length; i++) rpoNum[order[i]] = i;
  const postNum = new Int32Array(n).fill(-1);
  for (let i = 0; i < order.length; i++) postNum[order[i]] = order.length - 1 - i;
  return { rpo: order, rpoNum, postNum, reachable: state };
}

/**
 * Cooper-Harvey-Kennedy immediate dominators, dominance frontiers and the
 * dominator tree, over the nodes reachable from `entry`.
 *
 * @param {Graph} graph
 */
export function dominators(graph) {
  const { n, preds, entry } = graph;
  const { rpo, rpoNum, postNum } = reversePostorder(graph);
  const idom = new Int32Array(n).fill(-1);
  if (!rpo.length) return finish(graph, idom, rpo, rpoNum, 0);
  idom[entry] = entry;

  // intersect(a, b): walk both fingers up the tree until they meet. Postorder
  // numbers increase towards the entry, so the finger with the SMALLER number
  // is the deeper one and has to move.
  const intersect = (a, b) => {
    let f1 = a, f2 = b;
    while (f1 !== f2) {
      while (postNum[f1] < postNum[f2]) f1 = idom[f1];
      while (postNum[f2] < postNum[f1]) f2 = idom[f2];
    }
    return f1;
  };

  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds++;
    for (const b of rpo) {
      if (b === entry) continue;
      let newIdom = -1;
      for (const p of preds(b)) {
        if (rpoNum[p] < 0) continue;        // unreachable predecessor
        if (idom[p] === -1) continue;       // not processed yet this round
        newIdom = newIdom === -1 ? p : intersect(p, newIdom);
      }
      if (newIdom !== -1 && idom[b] !== newIdom) { idom[b] = newIdom; changed = true; }
    }
  }
  return finish(graph, idom, rpo, rpoNum, rounds);
}

function finish(graph, idom, rpo, rpoNum, rounds) {
  const { n, preds, entry } = graph;

  // dominator tree children, in rpo order so output is deterministic
  const children = Array.from({ length: n }, () => []);
  for (const b of rpo) if (b !== entry && idom[b] >= 0) children[idom[b]].push(b);

  // Euler in/out numbers for O(1) dominance queries.
  const tin = new Int32Array(n).fill(-1);
  const tout = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n).fill(-1);
  if (rpo.length) {
    let clock = 0;
    const stack = [[entry, 0, 0]];
    depth[entry] = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, , d] = top;
      if (tin[v] < 0) { tin[v] = clock++; depth[v] = d; }
      if (top[1] < children[v].length) {
        const c = children[v][top[1]++];
        stack.push([c, 0, d + 1]);
      } else {
        tout[v] = clock++;
        stack.pop();
      }
    }
  }

  const dominates = (a, b) => tin[a] >= 0 && tin[b] >= 0 && tin[a] <= tin[b] && tout[b] <= tout[a];
  const strictlyDominates = (a, b) => a !== b && dominates(a, b);

  // Dominance frontiers, Cooper-Harvey-Kennedy section 5 (the same formulation
  // as Cytron et al. 1991 but computed off the idom array):
  //   for each join point b, walk each predecessor up to idom(b), adding b.
  const domFrontier = Array.from({ length: n }, () => []);
  const seen = Array.from({ length: n }, () => -1);
  for (const b of rpo) {
    const ps = [...preds(b)].filter((p) => rpoNum[p] >= 0);
    if (ps.length < 2) continue;
    for (const p of ps) {
      let runner = p;
      while (runner !== idom[b] && runner >= 0) {
        if (seen[runner] !== b) { seen[runner] = b; domFrontier[runner].push(b); }
        if (runner === idom[runner]) break;   // the entry
        runner = idom[runner];
      }
    }
  }

  return {
    idom, rpo, rpoNum, children, depth, tin, tout, domFrontier,
    dominates, strictlyDominates, rounds,
    reachable: (b) => rpoNum[b] >= 0,
  };
}

/**
 * Augment a CFG with a single virtual exit so post-dominance is a tree, then
 * run `dominators` on the reverse graph.
 *
 * @param {Graph} graph
 * @returns {{ipdom: Int32Array, exit: number, dom: object, virtualExitEdges: number[],
 *            reverse: Graph, postDominates: (a:number,b:number)=>boolean}}
 */
export function postDominators(graph) {
  const { n, succs, preds, entry } = graph;
  const exit = n;
  const N = n + 1;

  // forward adjacency including the exit node
  const fwd = Array.from({ length: N }, () => []);
  for (let i = 0; i < n; i++) for (const s of succs(i)) fwd[i].push(s);
  const { rpoNum } = reversePostorder(graph);

  const exitPreds = new Set();
  for (let i = 0; i < n; i++) if (rpoNum[i] >= 0 && fwd[i].length === 0) exitPreds.add(i);

  const virtualExitEdges = [];
  const canReachExit = () => {
    // backward reachability from `exit` over fwd
    const rev = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) for (const s of fwd[i]) rev[s].push(i);
    for (const p of exitPreds) rev[exit].push(p);
    const seen = new Uint8Array(N);
    const st = [exit]; seen[exit] = 1;
    while (st.length) { const v = st.pop(); for (const p of rev[v]) if (!seen[p]) { seen[p] = 1; st.push(p); } }
    return seen;
  };
  let seen = canReachExit();
  // Connect sink regions (endless loops) one at a time, highest rpo first.
  for (let guard = 0; guard <= n; guard++) {
    let pick = -1, best = -1;
    for (let i = 0; i < n; i++) {
      if (seen[i] || rpoNum[i] < 0) continue;
      if (rpoNum[i] > best) { best = rpoNum[i]; pick = i; }
    }
    if (pick < 0) break;
    exitPreds.add(pick);
    virtualExitEdges.push(pick);
    seen = canReachExit();
  }

  // The reverse graph, rooted at exit.
  const revSuccs = (i) => (i === exit ? [...exitPreds] : [...preds(i)].filter((p) => rpoNum[p] >= 0));
  const revPreds = (i) => {
    if (i === exit) return [];
    const out = fwd[i].filter((s) => rpoNum[s] >= 0);
    return exitPreds.has(i) ? [...out, exit] : out;
  };
  const reverse = { n: N, entry: exit, succs: revSuccs, preds: revPreds };
  const dom = dominators(reverse);

  const ipdom = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (rpoNum[i] >= 0) ipdom[i] = dom.idom[i];

  return {
    ipdom, exit, dom, reverse, virtualExitEdges,
    exitPreds: [...exitPreds],
    postDominates: (a, b) => dom.dominates(a, b),
    strictlyPostDominates: (a, b) => dom.strictlyDominates(a, b),
    postDomFrontier: dom.domFrontier,
  };
}

// ---------------------------------------------------------------------------
// the oracles
// ---------------------------------------------------------------------------
//
// Slow, obviously correct, straight off the definition: `a` dominates `b` iff
// every path from the entry to `b` passes through `a`, i.e. iff deleting `a`
// makes `b` unreachable. O(V * (V+E)) and only ever run on small functions, as
// the cross-check for the fast version.

function reachableWithout(n, succs, entry, removed) {
  const seen = new Uint8Array(n);
  if (entry === removed) return seen;
  const st = [entry]; seen[entry] = 1;
  while (st.length) {
    const v = st.pop();
    for (const s of succs(v)) if (s !== removed && !seen[s]) { seen[s] = 1; st.push(s); }
  }
  return seen;
}

/** @returns {Array<Set<number>>} dom[b] = the set of nodes dominating b (including b). */
export function bruteForceDominators(graph) {
  const { n, succs, entry } = graph;
  const base = reachableWithout(n, succs, entry, -1);
  const dom = Array.from({ length: n }, () => new Set());
  for (let b = 0; b < n; b++) if (base[b]) dom[b].add(b);
  for (let a = 0; a < n; a++) {
    if (!base[a]) continue;
    const without = reachableWithout(n, succs, entry, a);
    for (let b = 0; b < n; b++) if (base[b] && b !== a && !without[b]) dom[b].add(a);
  }
  if (base[entry]) dom[entry] = new Set([entry]);
  return dom;
}

/**
 * dom sets -> immediate dominators. idom(b) is the unique strict dominator of
 * b that every other strict dominator of b dominates, found as the one with
 * the largest dominator set.
 */
export function immediateFromSets(sets, entry, reachable) {
  const n = sets.length;
  const idom = new Int32Array(n).fill(-1);
  for (let b = 0; b < n; b++) {
    if (!reachable(b)) continue;
    if (b === entry) { idom[b] = entry; continue; }
    let best = -1, bestSize = -1;
    for (const a of sets[b]) {
      if (a === b) continue;
      if (sets[a].size > bestSize) { bestSize = sets[a].size; best = a; }
    }
    idom[b] = best;
  }
  return idom;
}

/**
 * Post-dominator sets over the same augmented graph `postDominators` builds,
 * from the definition: `p` post-dominates `n` iff every path from `n` to EXIT
 * passes through `p`.
 *
 * Takes the augmented graph description back from `postDominators` so the two
 * are compared on identical inputs -- otherwise the oracle would be checking a
 * different question.
 */
export function bruteForcePostDominators(graph, pd) {
  const { n, succs } = graph;
  const exit = pd.exit;
  const N = n + 1;
  const extra = new Set(pd.exitPreds);
  const fwd = (i) => {
    if (i === exit) return [];
    const base = [...succs(i)];
    return extra.has(i) ? [...base, exit] : base;
  };
  const reachesExit = (from, removed) => {
    if (from === removed) return false;
    const seen = new Uint8Array(N);
    const st = [from]; seen[from] = 1;
    while (st.length) {
      const v = st.pop();
      if (v === exit) return true;
      for (const s of fwd(v)) if (s !== removed && !seen[s]) { seen[s] = 1; st.push(s); }
    }
    return false;
  };
  const live = [];
  for (let i = 0; i < n; i++) if (pd.dom.reachable(i)) live.push(i);
  const sets = Array.from({ length: N }, () => new Set());
  for (const b of [...live, exit]) sets[b].add(b);
  for (const p of [...live, exit]) {
    for (const b of live) {
      if (b === p) continue;
      if (!reachesExit(b, p)) sets[b].add(p);
    }
  }
  return { sets, exit, live };
}

export default {
  dominators, postDominators, reversePostorder,
  bruteForceDominators, bruteForcePostDominators, immediateFromSets,
};
