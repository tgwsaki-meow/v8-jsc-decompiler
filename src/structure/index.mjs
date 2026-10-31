// src/structure/index.mjs
//
// Stage D of ARCHITECTURE.md 4.4: the CFG -> a structured control tree.
// Output: the `StructuredFunction` of ARCHITECTURE.md 11.2.
//
//   structure(ir, { profile? }) -> StructuredFunction
//
//   src/structure/
//     index.mjs       the fixed stage order (this file)
//     facts.mjs       every opcode name and branch predicate this layer
//                     matches on, checked against the loaded profile
//     dispatcher.mjs  STAGE 1: delete the generator/async resume dispatcher
//     graph.mjs       the structuring graph (normal edges only, dispatcher
//                     gone, suspends spliced) + dominators / loops over it
//     exceptions.mjs  handler ranges -> try, and the await desugaring -> nothing
//     loops.mjs       natural loops -> while / doWhile / for / forever
//     switches.mjs    the jump table AND the compare chain
//     regions.mjs     acyclic regions by follow node -> if/else; the tree
//     conditions.mjs  Test and Target -- the whole of the T7/T8 split
//     jumps.mjs       break / continue / labels
//     fallback.mjs    the honest `unstructured` region
//     verify.mjs      the invariants
//
// This layer touches the GRAPH and never produces an expression
// (ARCHITECTURE.md 11.2). A condition is `{block, value, negate, predicate}` --
// "the SSA value the terminator of that block reads". T7 maps SSA values to
// expressions independently and T9 joins the two, which is why T7 and T8 need
// no communication.
//
// THE STAGE ORDER IS NOT NEGOTIABLE (ARCHITECTURE.md 10.1)
// --------------------------------------------------------
//   1. remove the resume dispatcher and splice every suspend to its resume
//   2. classify handler ranges, and remove the ones that are await desugaring
//   3. build the structuring graph: dominators, post-dominators, natural loops
//   4. plan the try regions (they need the graph; the graph needs their
//      synthetic dominance edges, so the graph is rebuilt once)
//   5. plan loops and switches
//   6. build the region tree
//   7. verify, or fall back to one honest `unstructured` region
//
// Measured justification for 1 before 3: 0 of 239 979 corpus functions are
// irreducible in that order; 121 functions and 163 edges are in the reverse
// order, and every one of them is a dispatcher artefact (docs/IR.md section 9).
//
// Layering (ARCHITECTURE.md 11.0): this directory imports src/ir, src/disasm
// and src/profile only. It must not import src/verify/ or tools/ -- those are
// the only places that spawn a real V8, and the decompilation path has to be
// engine-independent by construction rather than by accident.

import { structureFacts } from './facts.mjs';
import { planDispatcherRemoval } from './dispatcher.mjs';
import { structuringGraph } from './graph.mjs';
import {
  classifyHandlers, asyncDesugaringBlocks, planTryRegions, recogniseFinallyToken,
} from './exceptions.mjs';
import { planLoops } from './loops.mjs';
import { planSwitches } from './switches.mjs';
import { buildRegions } from './regions.mjs';
import { unstructuredRegion } from './fallback.mjs';
import { verifyStructure, summarise } from './verify.mjs';

export class StructureError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

/**
 * @param {object} ir    the 8.4 IR from src/ir/buildIR
 * @param {{profile?: object, verify?: boolean, tidy?: boolean}} opts
 * @returns {object} a StructuredFunction (ARCHITECTURE.md 11.2)
 */
export function structure(ir, opts = {}) {
  if (!ir || !ir.blocks) throw new StructureError('structure() needs an ir from src/ir/buildIR');
  const profile = opts.profile ?? ir.profile;
  if (!profile) throw new StructureError('structure() needs { profile } or ir.profile');
  const t0 = process.hrtime.bigint();
  const facts = structureFacts(profile);
  const warnings = [];
  const push = (stage, list) => { for (const w of list ?? []) warnings.push({ stage, ...w }); };

  // ------------------------------------------------- STAGE 1: the dispatcher
  const dispatch = planDispatcherRemoval(ir, facts);
  push('dispatcher', dispatch.warnings);

  // ------------------------------------------- STAGE 2: handler ranges
  const classification = classifyHandlers(ir);
  push('handlers', classification.warnings);

  // ------------------------------------------- STAGE 3: the structuring graph
  let g = structuringGraph(ir, {
    removedBlocks: dispatch.removedBlocks, removedEdges: dispatch.removedEdges,
    splices: dispatch.splices, entry: dispatch.entry, domExtraEdges: [],
  });

  let asyncBlocks = { removed: new Set(), detail: [] };
  if (classification.asyncRanges.length) {
    asyncBlocks = asyncDesugaringBlocks(ir, g, classification);
    if (asyncBlocks.removed.size) {
      g = structuringGraph(ir, {
        removedBlocks: new Set([...dispatch.removedBlocks, ...asyncBlocks.removed]),
        removedEdges: dispatch.removedEdges, splices: dispatch.splices,
        entry: dispatch.entry, domExtraEdges: [],
      });
    }
  }

  // ------------------------------------------- STAGE 4: the try regions
  //
  // This is a fixpoint, not one pass, and the reason is measured. A handler
  // block has no normal predecessor, so the only thing that makes it
  // dominance-reachable is the synthetic `rangeEntry -> handlerBlock` edge
  // graph.mjs adds for each *planned* range. A range whose own entry lies
  // inside another range's handler region is therefore unreachable while that
  // outer range is still unplanned, and gets skipped as
  // `rangeEntryUnreachable` -- after which its handler block is neither
  // placed nor removed and simply vanishes from 11.3 invariant 1.
  // `proxyWeChatRequest` in `b_357background.jsc` is that case: handler 3's
  // range [323,415) starts inside handler 2's catch body, and blocks 65-67
  // went missing. So: plan, add the edges, re-plan, until the plan set stops
  // growing. It only grows (more blocks become reachable), so it converges;
  // the bound is there because a budget is cheaper than a proof.
  let tryPlan = planTryRegions(ir, facts, g, classification);
  let tryRounds = 1;
  const planEdges = (p) => [...p.plans.values()].map((plan) => ({
    from: plan.entryBlock, to: plan.handlerBlock, why: 'handlerReachableFromTheRangeEntry',
  }));
  for (let round = 0; round < 8; round++) {
    const domExtraEdges = planEdges(tryPlan);
    if (!domExtraEdges.length) break;
    g = structuringGraph(ir, {
      removedBlocks: g.removedBlocks, removedEdges: dispatch.removedEdges,
      splices: dispatch.splices, entry: dispatch.entry, domExtraEdges,
    });
    const next = planTryRegions(ir, facts, g, classification);
    const grew = next.plans.size > tryPlan.plans.size;
    tryPlan = next;
    tryRounds++;
    if (!grew) break;
  }
  push('try', tryPlan.warnings);

  const finallyShapes = new Map();
  for (const plan of tryPlan.plans.values()) {
    const shape = recogniseFinallyToken(ir, facts, g, plan);
    if (shape) finallyShapes.set(plan.index, shape);
  }

  // ------------------------------------------- STAGE 5: loops and switches
  const loopPlan = planLoops(ir, facts, g);
  push('loops', loopPlan.warnings);
  const finallyDispatchBlocks = new Set([...finallyShapes.values()].map((s) => s.dispatchBlock));
  const switchPlan = planSwitches(ir, facts, g, { finallyDispatchBlocks });

  // ------------------------------------------- STAGE 6: the region tree
  const built = buildRegions({
    ir, facts, g, loopPlans: loopPlan.plans, tryPlans: tryPlan.plans,
    switchPlan, finallyShapes,
  });
  push('regions', built.warnings);

  // --------------------------------------------------- assemble the output
  const loopTestBlocks = [];
  for (const [header, lp] of loopPlan.plans) {
    if (lp.headerPlacedInBody) continue;
    if (lp.form !== 'while' && lp.form !== 'for') continue;
    for (const b of lp.testChain ?? []) {
      if (built.consumedBlocks.has(b)) {
        loopTestBlocks.push({ block: b, loop: header, form: lp.form, testBlock: lp.testBlock });
      }
    }
  }

  const removed = {
    generatorDispatchers: dispatch.dispatchers.map((d) => ({
      block: d.block, resumeEdges: d.resumeEdges,
      removedResumeEdges: d.removedResumeEdges, blockRemoved: d.blockRemoved,
      splices: d.splices,
    })),
    asyncHandlerRanges: classification.asyncRanges.map((r) => r.index),
    asyncHandlerBlocks: [...asyncBlocks.removed].sort((a, b) => a - b),
    loopTestBlocks,
    skippedHandlerRanges: tryPlan.skipped,
  };

  let root = built.root;
  let unstructured = [];
  let fellBack = null;

  /** ARCHITECTURE.md 4.4.7: one honest `unstructured` region for the function. */
  const fallBackWholeFunction = (failure) => {
    fellBack = failure ?? { why: 'unknown' };
    const all = [];
    for (const b of ir.blocks) {
      if (!ir.dominators.reachable(b.id)) continue;
      if (g.removedBlocks.has(b.id)) continue;
      all.push(b.id);
    }
    // a whole-function fall-back consumes nothing, so the loop test blocks are
    // placed again and must not be claimed as removed
    removed.loopTestBlocks = [];
    const region = unstructuredRegion(ir, g, all, fellBack.why, fellBack.detail ?? {});
    root = region;
    unstructured = [{ blocks: region.blocks, why: region.why, dispatchVar: region.dispatchVar, detail: region.detail }];
  };

  if (root === null) {
    fallBackWholeFunction(built.failure);
  } else {
    const sum = summarise({ root, labels: built.labels });
    unstructured = sum.unstructured.map((u) => ({
      blocks: u.blocks, why: u.why, dispatchVar: u.dispatchVar, detail: u.detail,
    }));
  }

  const loopHeaders = new Set(g.loops.map((l) => l.header));
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const sf = {
    ir,
    root,
    placed: { blocks: built.placedBlocks, edges: built.placedEdges, consumed: built.consumedBlocks },
    unstructured,
    removed,
    labels: built.labels,
    warnings,
    // --- additive, documented in docs/STRUCTURE.md
    graph: g,
    loopHeaders,
    loopPlans: loopPlan.plans,
    tryPlans: tryPlan.plans,
    finallyShapes,
    switchPlan,
    classification,
    fellBack,
    stats: null,
  };

  sf.stats = collectStats(sf, {
    dispatch, classification, tryPlan, loopPlan, switchPlan, built, g, elapsedMs, fellBack,
    tryRounds,
  });

  if (opts.verify !== false) {
    let rep = verifyStructure(sf);
    // The last line of defence for 11.3 invariant 1. A block that is neither
    // placed nor `removed` is lost silently -- T9 would emit a function with a
    // piece missing and nothing anywhere would say so, which is the one
    // failure mode ARCHITECTURE.md section 7 forbids outright. Measured cause
    // (1 function in 33 550 on the five largest corpus files): V8 emits a
    // handler range whose start equals its end -- an empty `try` -- and the
    // range protects nothing, so the catch body has no normal predecessor and
    // no `try` construct can own it. Rather than ship the hole, the function
    // takes the honest whole-function fall-back and the cost shows up in the
    // fall-back count with `why: 'blocksNotPlaced'`.
    if (rep.checks[0].violations && !fellBack) {
      fallBackWholeFunction({
        why: 'blocksNotPlaced',
        detail: { samples: rep.checks[0].samples, skippedHandlerRanges: tryPlan.skipped.slice(0, 4) },
      });
      sf.root = root;
      sf.unstructured = unstructured;
      sf.fellBack = fellBack;
      sf.removed = removed;
      sf.stats = collectStats(sf, {
        dispatch, classification, tryPlan, loopPlan, switchPlan, built, g, elapsedMs, fellBack, tryRounds,
      });
      rep = verifyStructure(sf);
    }
    sf.verification = rep;
    sf.stats.invariantViolations = rep.checks.reduce((a, c) => a + c.violations, 0);
  }
  return sf;
}

function collectStats(sf, x) {
  const { ir } = sf;
  const { dispatch, classification, tryPlan, loopPlan, switchPlan, built, g, elapsedMs, fellBack } = x;
  const sum = summarise(sf);

  // ---- metric 1: back edges that became a loop statement.
  // Counted against T6's back-edge set (18 201 corpus-wide), which is measured
  // on the IR graph BEFORE stage 1, because that is the number
  // ARCHITECTURE.md section 5's metric 1 names.
  let irBackEdges = 0, irBackEdgesInLoop = 0;
  const irBackEdgeMisses = [];
  for (const eid of ir.loopInfo.backEdges) {
    const e = ir.edges[eid];
    irBackEdges++;
    if (sum.loopHeaders.has(e.to)) irBackEdgesInLoop++;
    else if (irBackEdgeMisses.length < 3) irBackEdgeMisses.push({ edge: e.id, from: e.from, to: e.to });
  }
  // ... and the same question asked of every reachable JumpLoop, which is the
  // number that includes the 259 corpus edges whose cycle a suspend broke.
  let jumpLoops = 0, jumpLoopsInLoop = 0;
  const jumpLoopMisses = [];
  for (const e of ir.edges) {
    if (e.kind === 'exception') continue;
    const src = ir.blocks[e.from];
    if (!src.terminator?.isBackward) continue;
    if (!ir.dominators.reachable(e.from)) continue;
    jumpLoops++;
    if (sum.loopHeaders.has(e.to)) jumpLoopsInLoop++;
    else if (jumpLoopMisses.length < 3) jumpLoopMisses.push({ edge: e.id, from: e.from, to: e.to, removed: g.removedEdges.has(e.id) });
  }

  // ---- metric 2: handler ranges -> try, by prediction
  const tryByPrediction = {};
  const missedByPrediction = {};
  for (const r of classification.byIndex) {
    const became = sum.tryHandlerIndices.has(r.index);
    const k = r.prediction;
    if (became) tryByPrediction[k] = (tryByPrediction[k] ?? 0) + 1;
    else missedByPrediction[k] = (missedByPrediction[k] ?? 0) + 1;
  }

  const unstructuredWhy = {};
  for (const u of sf.unstructured) unstructuredWhy[u.why] = (unstructuredWhy[u.why] ?? 0) + 1;

  const reachable = ir.blocks.filter((b) => ir.dominators.reachable(b.id)).length;
  const removedBlockCount = g.removedBlocks.size + (sf.removed.loopTestBlocks?.length ?? 0);

  return {
    blocks: ir.blocks.length,
    reachableBlocks: reachable,
    structuringBlocks: reachable - g.removedBlocks.size,
    removedBlocks: removedBlockCount,
    placedBlocks: built.placedBlocks.size,
    consumedBlocks: built.consumedBlocks.size,
    regions: sum.regionCount,

    // stage 1
    ...dispatch.stats,
    irreducibleBeforeRemoval: ir.loopInfo.irreducible.length,
    irreducibleAfterRemoval: g.loopInfo.irreducible.length,
    irreducibleAfterRemovalDetail: g.loopInfo.irreducible.slice(0, 3),

    // metric 1
    irBackEdges, irBackEdgesInLoop, irBackEdgeMisses,
    jumpLoops, jumpLoopsInLoop, jumpLoopMisses,
    loopsFound: g.loops.length,
    loopRegions: sum.loopHeaders.size,
    loopForms: sum.loopForms,
    ...loopPlan.stats,

    // metric 2
    handlerRanges: ir.handlers.length,
    handlerRangesByPrediction: classification.byPrediction,
    asyncHandlerRanges: classification.asyncRanges.length,
    tryRangesPlanned: tryPlan.plans.size,
    tryPlanRounds: x.tryRounds,
    tryRegions: sum.tryHandlerIndices.size,
    tryByPrediction, missedByPrediction,
    skippedHandlerRanges: tryPlan.skipped.length,
    skippedHandlerWhy: tryPlan.skipped.reduce((a, s) => { a[s.why] = (a[s.why] ?? 0) + 1; return a; }, {}),
    finallyShapes: sf.finallyShapes.size,
    finallyShapeKinds: [...sf.finallyShapes.values()].reduce((a, s) => { a[s.dispatchKind] = (a[s.dispatchKind] ?? 0) + 1; return a; }, {}),

    // switches
    ...switchPlan.stats,
    switchRegions: sum.switchForms,

    // regions
    ...built.stats,
    labels: sf.labels.length,
    unstructuredRegions: sf.unstructured.length,
    unstructuredBlocks: sum.unstructuredBlocks.length,
    unstructuredWhy,
    fellBack: fellBack ? 1 : 0,
    fellBackWhy: fellBack?.why ?? null,

    singleBlockFunction: reachable === 1 ? 1 : 0,
    singleBlockTrivial: reachable === 1 && sf.root?.r === 'block' ? 1 : 0,

    warnings: sf.warnings.length,
    elapsedMs,
  };
}

/** Structure every unit of a module, collecting per-unit failures. */
export function structureAll(irs, opts = {}) {
  const results = [];
  const failures = [];
  for (const ir of irs) {
    try { results.push(structure(ir, opts)); }
    catch (e) {
      failures.push({
        unit: ir?.unit?.bytecodeId ?? null, name: ir?.unit?.name ?? null,
        error: e.message, stack: String(e.stack).split('\n').slice(0, 4),
      });
    }
  }
  return { results, failures };
}

export { verifyStructure, summarise } from './verify.mjs';
export default { structure, structureAll, StructureError };
