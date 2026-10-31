// src/ir/index.mjs
//
// Stage B of ARCHITECTURE.md 4.2: Instruction[] (8.2) -> the IR of 8.4.
//
//   src/ir/
//     index.mjs           buildIR(unit, {profile}) -> IRFunction
//     opcode_effects.mjs  what one bytecode does: registers, effects, allocation
//     vars.mjs            the variable space and one instruction's read/write set
//     cfg.mjs             leaders -> blocks -> edges, including jump-table and
//                         exception edges
//     dominators.mjs      Cooper-Harvey-Kennedy dominators + frontiers, the
//                         same on the reverse graph for post-dominators, and a
//                         brute-force oracle for both
//     loops.mjs           back edges, natural loops, the nesting forest, and
//                         the reducibility measurement
//     ssa.mjs             Cytron phi placement + renaming, pruned
//     context.mjs         ContextSlot(depth,index) -> a real name
//     effects.mjs         the effect graph (memory SSA over effect kinds)
//     verify.mjs          the structural invariants
//     dot.mjs             Graphviz
//
// What replaces what:
//
//   src/decompiler.js:70-76   "first predecessor wins", no phis, no fixpoint,
//                             layout-order traversal        -> ssa.mjs
//   src/lifter.js:buildCFG    handler offsets as leaders but zero exception
//                             edges, no jump-table successors -> cfg.mjs
//   src/relooper.js
//     :_findMergeBlock        "lowest block id reachable from both branches"
//                             -> dominators.mjs's ipdom
//
// Nothing here is version-specific. Opcode numbering, operand widths, operand
// roles, prefixes, the jump family and the switch family all come from
// profiles/<tag>/*.json through src/profile and src/disasm; the only names
// written down are opcode names, in the declared tables of
// opcode_effects.mjs, and every profile's opcode set is checked against them.

import { disassemble } from '../disasm/index.mjs';
import { opcodeSemantics } from './opcode_effects.mjs';
import { buildCFG, resolveKind } from './cfg.mjs';
import { dominators, postDominators } from './dominators.mjs';
import { findLoops, reducibilityWithoutGeneratorResume } from './loops.mjs';
import { buildSSA } from './ssa.mjs';
import { contextChain } from './context.mjs';
import { buildEffects } from './effects.mjs';
import { VAR_ACCUMULATOR, VAR_CONTEXT } from './vars.mjs';

export class IRError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

/**
 * @param {object} unit  an 8.1 FunctionUnit
 * @param {{profile: object, disasm?: object, scopeInfoById?: Map,
 *          exceptionPrecision?: 'instruction'|'block', strict?: boolean}} opts
 */
export function buildIR(unit, opts) {
  const profile = opts?.profile;
  if (!profile) throw new IRError('buildIR() needs { profile }');
  const t0 = process.hrtime.bigint();

  const dis = opts.disasm ?? disassemble(unit, { profile, strict: false });
  const sem = opcodeSemantics(profile);
  const warnings = [...(opts.disasm ? [] : dis.warnings.map((w) => ({ stage: 'disasm', ...w })))];

  const cfg = buildCFG(dis, { exceptionPrecision: opts.exceptionPrecision });
  for (const w of cfg.warnings) warnings.push({ stage: 'cfg', ...w });

  const graph = {
    n: cfg.blocks.length,
    entry: cfg.entry,
    succs: (i) => cfg.blocks[i].succs,
    preds: (i) => cfg.blocks[i].preds,
  };
  const dom = dominators(graph);
  const pdom = postDominators(graph);
  const loopInfo = findLoops(cfg, dom);
  for (const b of cfg.blocks) resolveKind(b);

  // Only worth the second dominator run when there is something to explain.
  const withoutResume = loopInfo.irreducible.length
    ? reducibilityWithoutGeneratorResume(cfg, dominators)
    : { irreducible: [], removedEdges: 0, unchanged: true };

  const ssa = buildSSA({ cfg, dom, unit, profile, sem });
  for (const w of ssa.warnings) warnings.push({ stage: 'ssa', ...w });

  // ------------------------------------------------------- context slots
  const ctx = contextChain({
    unit, profile, values: ssa.values, cfg, dom,
    instructionValue: ssa.instructionValue, vs: ssa.vs,
    scopeInfoById: opts.scopeInfoById ?? null,
  });
  for (const n of ctx.notes) warnings.push({ stage: 'context', code: 'contextChainNote', message: n });

  // One ContextSlot value per distinct (context frame, local index), so that a
  // load and a store of the same variable point at the same location node.
  const slotValues = new Map();
  const contextSlotStats = {
    ops: 0, resolved: 0, unresolved: 0, byWhy: {}, immutableLoads: 0,
    dynamicFallback: 0, distinctSlots: 0, nonZeroDepth: 0, maxDepth: 0,
  };
  for (const v of ssa.values) {
    if (v.kind !== 'Op') continue;
    const cs = v.sem?.contextSlot;
    if (!cs) continue;
    contextSlotStats.ops++;
    const ins = cfg.instructions[v.instruction];
    const slotOperand = ins.operands.find((o) => o.type === 'kContextSlot');
    const depthOperand = ins.operands.find((o) => o.type === 'kUImm');
    const slot = slotOperand ? slotOperand.slot : null;
    const depth = depthOperand ? depthOperand.value : 0;
    // For the <context> operand form the base is that register's SSA value.
    // For the Current* form it is whatever the frame's context register holds
    // at this instruction, which only the per-instruction dataflow knows -- so
    // baseValue stays null and resolve() uses insFrame.
    let baseValue = null;
    if (cs.base === 'operand') {
      // inputs are in read order: the accumulator first when read, then the
      // operands, so the <context> register is the first operand read.
      const k = v.sem.accumulator.read ? 1 : 0;
      baseValue = v.inputs[k] ?? null;
    }
    const r = slot === null
      ? { resolved: false, why: 'noContextSlotOperand', chain: [] }
      : ctx.resolve(v.instruction, baseValue, depth, slot);
    if (depth > 0) contextSlotStats.nonZeroDepth++;
    if (depth > contextSlotStats.maxDepth) contextSlotStats.maxDepth = depth;
    if (cs.immutable) contextSlotStats.immutableLoads++;
    if (cs.dynamicFallback) contextSlotStats.dynamicFallback++;
    if (r.resolved) contextSlotStats.resolved++;
    else {
      contextSlotStats.unresolved++;
      contextSlotStats.byWhy[r.why] = (contextSlotStats.byWhy[r.why] ?? 0) + 1;
    }

    let node = null;
    if (r.resolved || r.frame !== undefined) {
      const key = `${r.frame}:${r.localIndex ?? `slot${slot}`}`;
      node = slotValues.get(key);
      if (node === undefined) {
        node = ssa.values.length;
        ssa.values.push({
          id: node, kind: 'ContextSlot',
          frame: r.frame, depthFromUse: depth, slot, localIndex: r.localIndex ?? null,
          name: r.name ?? null, mode: r.mode ?? null, maybeAssigned: r.maybeAssigned ?? null,
          scopeType: r.scopeType ?? null, scopeInfoId: r.scopeInfoId ?? null,
          resolved: !!r.resolved, why: r.resolved ? null : r.why,
          loads: [], stores: [],
        });
        slotValues.set(key, node);
      }
      (cs.mode === 'store' ? ssa.values[node].stores : ssa.values[node].loads).push(v.id);
    }
    v.contextSlot = {
      mode: cs.mode, base: cs.base, immutable: cs.immutable, cell: cs.cell,
      dynamicFallback: !!cs.dynamicFallback,
      depth, index: slot, localIndex: r.localIndex ?? null,
      name: r.resolved ? r.name : null,
      resolved: !!r.resolved, why: r.resolved ? null : r.why,
      frame: r.frame ?? null, chain: r.chain ?? [], slotValue: node,
      header: r.header ?? null,
    };
  }
  contextSlotStats.distinctSlots = slotValues.size;

  const effects = buildEffects({ cfg, dom, ssa });

  // ----------------------------------------------------- assemble 8.4
  for (const b of cfg.blocks) {
    b.effects = effects.blockEffects[b.id] ?? [];
    b.phis = (ssa.phiValues[b.id] ?? []).map((p) => p.id);
    b.idom = dom.idom[b.id];
    b.ipdom = pdom.ipdom[b.id];
    b.domFrontier = dom.domFrontier[b.id] ?? [];
    b.loop = loopInfo.loopOf[b.id];
    b.loopDepth = loopInfo.loopDepth[b.id];
    b.caughtException = ssa.caughtException.get(b.id) ?? null;
    b.rpo = dom.rpoNum[b.id];
  }

  // The one imprecision of the invoke-style exception model: the throwing
  // terminator's own register writes are visible on the exception edge even
  // though the machine would not have performed them. Counted, not assumed
  // away.
  let liveInWrittenByThrowingTerminator = 0;
  for (const b of cfg.blocks) {
    if (!b.isHandlerEntryFor.length || !dom.reachable(b.id)) continue;
    for (const p of b.exceptionPreds) {
      const pb = cfg.blocks[p];
      const term = ssa.values[ssa.instructionValue[pb.last]];
      if (!term || term.kind !== 'Op') continue;
      for (const d of term.defs) {
        if (d.var === VAR_ACCUMULATOR) continue;       // dead at a handler
        if (ssa.bsGet(ssa.liveIn[b.id], d.var)) liveInWrittenByThrowingTerminator++;
      }
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const ir = {
    // --- identity
    unit, profile, instructions: cfg.instructions, disasm: dis,

    // --- 8.4
    blocks: cfg.blocks,
    entry: cfg.entry,
    dominators: dom,
    idom: dom.idom,
    domFrontier: dom.domFrontier,
    postDominators: pdom,
    ipdom: pdom.ipdom,
    loops: loopInfo.loops,
    values: ssa.values,
    effects: effects.effectOrder,
    defUse: ssa.defUse,

    // --- additive, documented in docs/IR.md
    edges: cfg.edges,
    handlers: cfg.handlers,
    cfg,
    cfgFacts: cfg.facts,
    exit: pdom.exit,
    vs: ssa.vs,
    sem,
    phis: ssa.phis,
    loopInfo,
    reducibilityWithoutGeneratorResume: withoutResume,
    effectGraph: effects,
    contextChain: ctx,
    contextSlotValues: slotValues,
    liveIn: ssa.liveIn,
    liveOut: ssa.liveOut,
    bsGet: ssa.bsGet,
    instructionValue: ssa.instructionValue,
    blockEntryVersion: ssa.blockEntryVersion,
    blockExitVersion: ssa.blockExitVersion,
    caughtException: ssa.caughtException,
    warnings,

    stats: {
      ...cfg.stats,
      ...ssa.stats,
      ...loopInfo.stats,
      ...effects.stats,
      contextSlots: contextSlotStats,
      contextHeader: ctx.headerConstants,
      contextFrames: ctx.frames.length,
      contextFixpointRounds: ctx.rounds,
      domRounds: dom.rounds,
      irreducibleWithoutGeneratorResume: withoutResume.irreducible.length,
      generatorResumeEdgesRemoved: withoutResume.removedEdges,
      virtualExitEdges: pdom.virtualExitEdges.length,
      liveInWrittenByThrowingTerminator,
      instructions: cfg.instructions.length,
      reachableBlocks: dom.rpo.length,
      elapsedMs,
      warnings: warnings.length,
    },
  };
  return ir;
}

/** Build the IR of every unit of a module, collecting per-unit failures. */
export function buildAllIR(units, opts) {
  const results = [];
  const failures = [];
  for (const unit of units) {
    if (!unit.bytecode) continue;
    try {
      results.push(buildIR(unit, opts));
    } catch (e) {
      failures.push({
        unit: unit.bytecodeId ?? unit.sfiId ?? null, name: unit.name ?? null,
        error: e.message, stack: e.stack,
      });
    }
  }
  return { results, failures };
}

export { VAR_ACCUMULATOR, VAR_CONTEXT };
export default { buildIR, buildAllIR, IRError };
