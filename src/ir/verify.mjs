// src/ir/verify.mjs
//
// The structural invariants, in one place so that the CLI, the self-test and
// the corpus scan all assert exactly the same thing.
//
// Every check returns a count of violations and, when there are any, the first
// few with enough detail to find them. Nothing is relaxed when it fails: a
// failing invariant is reported with its count and an example, which is the
// only way the corpus numbers mean anything.

import { bruteForceDominators, bruteForcePostDominators, immediateFromSets } from './dominators.mjs';
import { VAR_ACCUMULATOR } from './vars.mjs';

const SAMPLES = 3;

class Report {
  constructor() { this.checks = []; this.violations = 0; }

  add(name, violations, total, samples = [], note = null) {
    const n = Array.isArray(violations) ? violations.length : violations;
    const s = Array.isArray(violations) ? violations.slice(0, SAMPLES) : samples.slice(0, SAMPLES);
    this.checks.push({ name, ok: n === 0, violations: n, total, samples: s, note });
    this.violations += n;
    return this;
  }

  get ok() { return this.violations === 0; }
}

/** Where a value is defined, as (block, position-in-block). */
function defSite(v) {
  switch (v.kind) {
    case 'Phi': case 'CaughtException': case 'EffectPhi':
      return { block: v.block, pos: -1 };
    case 'FrameEntry': case 'Param': case 'EffectEntry':
      return { block: 0, pos: -2 };
    case 'Op': case 'Proj':
      return { block: v.block, pos: v.instruction };
    default:
      return null;                      // ContextSlot: a location, not a def
  }
}

/**
 * @param {object} ir            the buildIR result
 * @param {{bruteForce?: boolean, bruteForceLimit?: number}} opts
 */
export function verifyIR(ir, opts = {}) {
  const r = new Report();
  const { blocks, edges, values, dominators: dom, postDominators: pdom, loopInfo, vs } = ir;
  const n = blocks.length;
  const reach = (i) => dom.reachable(i);

  // ------------------------------------------------- 1. shape of the graph
  {
    const bad = [];
    for (const b of blocks) if (!reach(b.id)) bad.push({ block: b.id, offset: b.startOffset, preds: b.preds.slice(0, 4) });
    r.add('every block is reachable from the entry', bad, n, [],
      'V8 emits no dead code (ARCHITECTURE.md 0), so an unreachable block means a missing edge');
  }
  {
    const bad = [];
    for (const e of edges) {
      if (!(e.from >= 0 && e.from < n)) bad.push({ edge: e.id, why: 'from out of range', from: e.from });
      else if (!(e.to >= 0 && e.to < n)) bad.push({ edge: e.id, why: 'to out of range', to: e.to });
    }
    // and the adjacency lists have to agree with the edge list
    const seen = new Map();
    for (const e of edges) seen.set(e.id, e);
    for (const b of blocks) {
      if (b.preds.length !== b.inEdges.length) bad.push({ block: b.id, why: 'preds/inEdges length mismatch' });
      if (b.succs.length !== b.outEdges.length) bad.push({ block: b.id, why: 'succs/outEdges length mismatch' });
      b.inEdges.forEach((eid, i) => {
        const e = seen.get(eid);
        if (!e || e.to !== b.id || e.from !== b.preds[i]) bad.push({ block: b.id, why: 'inEdges[i] does not match preds[i]', i });
      });
      b.outEdges.forEach((eid, i) => {
        const e = seen.get(eid);
        if (!e || e.from !== b.id || e.to !== b.succs[i]) bad.push({ block: b.id, why: 'outEdges[i] does not match succs[i]', i });
      });
    }
    r.add('every edge has endpoints that exist and the adjacency lists agree', bad, edges.length);
  }

  // ------------------------------------------------- 2. dominance of uses
  {
    const bad = [];
    const dominatesSite = (d, useBlock, usePos) => {
      if (d.block === useBlock) return d.pos < usePos;
      return dom.strictlyDominates(d.block, useBlock);
    };
    for (const v of values) {
      if (!v) continue;
      if (v.kind === 'Op') {
        if (!reach(v.block)) continue;
        for (let k = 0; k < v.inputs.length; k++) {
          const d = values[v.inputs[k]];
          if (!d) { bad.push({ value: v.id, op: v.op, why: 'input value missing', input: v.inputs[k] }); continue; }
          const site = defSite(d);
          if (!site) { bad.push({ value: v.id, op: v.op, why: `input is a ${d.kind}` }); continue; }
          if (!dominatesSite(site, v.block, v.instruction)) {
            bad.push({
              value: v.id, op: v.op, offset: v.offset, block: v.block,
              input: d.id, inputKind: d.kind, inputBlock: site.block,
              why: 'definition does not dominate the use',
            });
          }
        }
      } else if (v.kind === 'Proj') {
        const of = values[v.of];
        if (!of || of.block !== v.block) bad.push({ value: v.id, why: 'projection is not in its op\'s block' });
      }
    }
    r.add('every SSA use is dominated by its definition', bad, values.length);
  }
  {
    // A phi operand must be available at the exit of the matching predecessor.
    const bad = [];
    for (const v of values) {
      if (!v || (v.kind !== 'Phi' && v.kind !== 'EffectPhi')) continue;
      if (!reach(v.block)) continue;
      const b = blocks[v.block];
      for (let j = 0; j < v.operands.length; j++) {
        const o = v.operands[j];
        const pred = b.preds[j];
        if (o === null || o === undefined) {
          if (reach(pred)) bad.push({ phi: v.id, block: v.block, predIndex: j, pred, why: 'null operand for a reachable predecessor' });
          continue;
        }
        const d = values[o];
        const site = d ? defSite(d) : null;
        if (!site) { bad.push({ phi: v.id, predIndex: j, why: 'operand is not a definition' }); continue; }
        // available at pred's exit: defined in pred, or in a block dominating pred
        const ok = site.block === pred ? true : dom.strictlyDominates(site.block, pred);
        if (!ok) {
          bad.push({
            phi: v.id, kind: v.kind, block: v.block, predIndex: j, pred,
            operand: o, operandBlock: site.block,
            why: 'operand is not dominated by the predecessor\'s exit',
          });
        }
      }
    }
    r.add('every phi operand is available at the matching predecessor\'s exit', bad, ir.phis.length);
  }

  // ------------------------------------------------- 3. phi arity and order
  {
    const bad = [];
    for (const v of values) {
      if (!v || (v.kind !== 'Phi' && v.kind !== 'EffectPhi')) continue;
      const b = blocks[v.block];
      if (v.operands.length !== b.preds.length) {
        bad.push({ phi: v.id, block: v.block, arity: v.operands.length, preds: b.preds.length });
      }
    }
    r.add('phi arity equals the predecessor count, in predecessor order', bad, ir.phis.length,
      [], 'operand j belongs to preds[j], which is inEdges[j], so two edges from the same block get two operands');
  }

  // ------------------------------------------------- 4. one reaching def
  {
    const bad = [];
    for (const v of values) {
      if (!v || v.kind !== 'Op' || !reach(v.block)) continue;
      for (let k = 0; k < v.inputs.length; k++) {
        const want = v.inputVars[k];
        const d = values[v.inputs[k]];
        if (!d) continue;
        const got = d.var === undefined ? -1 : d.var;
        if (want >= 0 && got !== want) {
          bad.push({
            value: v.id, op: v.op, offset: v.offset, k,
            wantVar: want, wantName: vs.name(want), gotVar: got, gotKind: d.kind,
            why: 'the reaching definition is for a different variable',
          });
        }
        if (want < 0 && !(d.kind === 'FrameEntry' && d.readOnly)) {
          bad.push({ value: v.id, op: v.op, k, why: 'a read of a non-variable register did not resolve to a frame-header value' });
        }
      }
    }
    // and every definition is unique: a value defines at most one variable and
    // appears as the def of that variable exactly once
    const defOf = new Map();
    for (const v of values) {
      if (!v || v.var === undefined || v.var < 0) continue;
      if (v.kind === 'ContextSlot') continue;
      if (defOf.has(v.id)) bad.push({ value: v.id, why: 'duplicate definition record' });
      defOf.set(v.id, v.var);
    }
    r.add('every variable use has exactly one reaching definition, for the right variable', bad, values.length);
  }

  // ------------------------------------------------- 5. loops
  {
    const bad = [];
    for (const eid of loopInfo.backEdges) {
      const e = edges[eid];
      if (!dom.dominates(e.to, e.from)) bad.push({ edge: eid, from: e.from, to: e.to, why: 'back-edge target does not dominate its source' });
    }
    r.add('every back edge\'s target dominates its source', bad, loopInfo.backEdges.length);
  }
  {
    const bad = [];
    const loops = loopInfo.loops;
    for (const l of loops) {
      // acyclic parent chain
      const seen = new Set([l.id]);
      let p = l.parent, steps = 0;
      while (p !== null) {
        if (seen.has(p)) { bad.push({ loop: l.id, why: 'cycle in the loop nesting forest' }); break; }
        seen.add(p); p = loops[p].parent;
        if (++steps > loops.length) { bad.push({ loop: l.id, why: 'parent chain longer than the loop count' }); break; }
      }
      // a child's body must be contained in its parent's
      if (l.parent !== null) {
        const par = loops[l.parent];
        for (const b of l.body) if (!par.bodySet[b]) { bad.push({ loop: l.id, parent: par.id, block: b, why: 'child body not contained in the parent body' }); break; }
      }
      // the header dominates the whole body
      for (const b of l.body) if (!dom.dominates(l.header, b)) { bad.push({ loop: l.id, block: b, why: 'header does not dominate a body block' }); break; }
      // latches are in the body and have a back edge to the header
      for (const lt of l.latches) if (!l.bodySet[lt]) bad.push({ loop: l.id, latch: lt, why: 'latch is not in the body' });
    }
    r.add('the loop nesting forest is a forest and every header dominates its body', bad, loops.length);
  }

  // ------------------------------------------------- 6. post-dominators
  {
    const bad = [];
    const exit = pdom.exit;
    for (const b of dom.rpo) {
      let x = b, steps = 0;
      while (x !== exit) {
        const next = x === exit ? exit : (x < n ? pdom.ipdom[x] : exit);
        if (next < 0) { bad.push({ block: b, why: 'ipdom chain hits an undefined entry', at: x }); break; }
        if (next === x) { bad.push({ block: b, why: 'ipdom is a self-loop that is not the exit', at: x }); break; }
        x = next;
        if (++steps > n + 2) { bad.push({ block: b, why: 'ipdom chain does not reach the exit' }); break; }
      }
    }
    r.add('ipdom is a tree rooted at the virtual exit', bad, dom.rpo.length,
      [], `${pdom.virtualExitEdges.length} virtual exit edge(s) were needed for blocks with no path to a return`);
  }

  // ------------------------------------------------- 7. jump tables, handlers
  {
    const bad = [];
    let targets = 0;
    for (const ins of ir.instructions) {
      if (!ins.jumpTable) continue;
      for (const e of ins.jumpTable) {
        if (e.target === null) continue;
        targets++;
        if (!ir.disasm.byOffset.has(e.target)) { bad.push({ offset: ins.offset, target: e.target, why: 'not an instruction start' }); continue; }
        const b = blocks.find((x) => x.startOffset === e.target);
        if (!b) bad.push({ offset: ins.offset, target: e.target, why: 'jump table target is not a block leader' });
      }
    }
    r.add('every jump-table target is a block leader', bad, targets);
  }
  {
    const bad = [];
    const byHandler = new Map();
    for (const e of edges) if (e.kind === 'exception') byHandler.set(e.handler, (byHandler.get(e.handler) ?? 0) + 1);
    for (const h of ir.handlers) {
      const b = blocks.find((x) => x.startOffset === h.handlerOffset);
      if (!b) { bad.push({ handler: h.index, offset: h.handlerOffset, why: 'no block starts at the handler offset' }); continue; }
      if (!b.isHandlerEntryFor.includes(h.index)) bad.push({ handler: h.index, block: b.id, why: 'the handler block is not marked as this range\'s handler' });
      if (!byHandler.has(h.index)) bad.push({ handler: h.index, why: 'no exception edge accounts for this range' });
    }
    r.add('every protected range has a handler block and at least one exception edge', bad, ir.handlers.length);
  }

  // ----------------------------------- cross-checks against the disassembler
  {
    // The backward branch opcode, located by the profile (opcode_facts.mjs
    // derives it as the lowest member of the jump block, cross-checked against
    // the loop-depth + feedback-slot operand shape), never by name.
    const backward = ir.cfgFacts.facts.backwardJumpValue;
    let jumpLoopInstructions = 0;
    for (const b of blocks) {
      if (!reach(b.id)) continue;
      for (let i = b.first; i <= b.last; i++) {
        if (ir.instructions[i].opcodeValue === backward) jumpLoopInstructions++;
      }
    }
    const jl = loopInfo.jumpLoop;

    // (a) the real invariant: nothing but a JumpLoop can produce a back edge.
    const bad = [];
    for (const eid of loopInfo.backEdges) {
      const e = edges[eid];
      if (!blocks[e.from].terminator?.isBackward) {
        bad.push({
          edge: eid, from: e.from, to: e.to, kind: e.kind,
          terminator: blocks[e.from].terminator?.opcode,
          why: 'a back edge left a block that does not end in the backward branch opcode',
        });
      }
    }
    r.add('every back edge comes from the backward branch opcode', bad, loopInfo.backEdges.length,
      [], 'JumpLoop is V8\'s only backward branch (src/interpreter/bytecodes.h: IsForwardJump excludes it alone)');

    // (b) the cross-check against the disassembler: every reachable JumpLoop
    // instruction produces exactly one classified edge.
    const bad2 = [];
    if (jumpLoopInstructions !== jl.total) {
      bad2.push({ jumpLoopInstructions, jumpLoopEdges: jl.total, why: 'a reachable JumpLoop produced no edge' });
    }
    if (jl.backEdge + jl.irreducible + jl.cycleBrokenBySuspend !== jl.total) {
      bad2.push({ ...jl, why: 'the JumpLoop classification does not add up' });
    }
    // A JumpLoop in a cycle whose target does not dominate it means the region
    // is irreducible, so the function has to be flagged as such.
    if (jl.irreducible > 0 && loopInfo.irreducible.length === 0) {
      bad2.push({
        jumpLoopInIrreducibleRegion: jl.irreducible, examples: jl.otherExamples,
        why: 'a cyclic JumpLoop whose target does not dominate it was found, but no irreducible edge was reported',
      });
    }
    r.add('every reachable JumpLoop produces exactly one classified edge', bad2, jumpLoopInstructions, [],
      `${jl.backEdge} back edge, ${jl.irreducible} in an irreducible region, ${jl.cycleBrokenBySuspend} with the `
      + 'cycle broken by a suspend (the body returns, so one invocation\'s CFG is acyclic)');
  }
  {
    const bad = [];
    let decoded = 0;
    for (const b of blocks) {
      if (!reach(b.id)) continue;
      const last = ir.instructions[b.last];
      if (!last.jumpTable) continue;
      for (const e of last.jumpTable) if (e.target !== null) decoded++;
    }
    const switchEdges = edges.filter((e) => e.kind === 'switch' && reach(e.from)).length;
    if (switchEdges !== decoded) bad.push({ switchEdges, decodedEntries: decoded });
    r.add('switch successor count equals the decoded jump-table entry count', bad, decoded);
  }

  // --------------------------------------------------------- the oracles
  if (opts.bruteForce) {
    const graph = { n, entry: 0, succs: (i) => blocks[i].succs, preds: (i) => blocks[i].preds };
    const sets = bruteForceDominators(graph);
    const slowIdom = immediateFromSets(sets, 0, (b) => reach(b));
    const bad = [];
    for (const b of dom.rpo) if (slowIdom[b] !== dom.idom[b]) bad.push({ block: b, fast: dom.idom[b], slow: slowIdom[b] });
    r.add('idom agrees with the brute-force dominator oracle', bad, dom.rpo.length);

    const pslow = bruteForcePostDominators(graph, pdom);
    const slowIpdom = immediateFromSets(pslow.sets, pdom.exit, (b) => b === pdom.exit || reach(b));
    const bad2 = [];
    for (const b of dom.rpo) {
      if (b === pdom.exit) continue;
      if (slowIpdom[b] !== pdom.ipdom[b]) bad2.push({ block: b, fast: pdom.ipdom[b], slow: slowIpdom[b] });
    }
    r.add('ipdom agrees with the brute-force post-dominator oracle', bad2, dom.rpo.length,
      [], 'the slow version is the definition: p post-dominates n iff deleting p makes the exit unreachable from n');
  }

  // ------------------------------------------- model assumptions, reported
  r.add('the accumulator is dead at every handler entry', ir.stats.accumulatorLiveInAtHandler, ir.handlers.length,
    [], 'the caught-exception model replaces the incoming accumulator at a handler');

  return r;
}

export default { verifyIR };
export { VAR_ACCUMULATOR };
