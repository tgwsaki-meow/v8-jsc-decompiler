#!/usr/bin/env node
// tools/ir/corpus_worker.mjs
//
// One .jsc, in a child process, with its own heap cap. Builds the IR of every
// function, asserts every structural invariant from src/ir/verify.mjs, and
// writes one JSON result file. Nothing is retained between functions, so peak
// memory is one function's IR plus one file's object graph.
//
//   node --max-old-space-size=1200 tools/ir/corpus_worker.mjs <file.jsc> <profileDir> <out.json> [opts]
//
//     --brute-force-budget N   run the slow dominator/post-dominator oracles on
//                              up to N small functions of this file
//     --exception-model instruction|block

import fs from 'node:fs';
import path from 'node:path';
import { unitsFromCache } from './units.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { verifyIR } from '../../src/ir/verify.mjs';

const [, , file, profileDir, out] = process.argv;
if (!file || !profileDir || !out) {
  console.error('usage: corpus_worker.mjs <file.jsc> <profileDir> <out.json> [--brute-force-budget N]');
  process.exit(2);
}
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const BRUTE_BUDGET = Number(argOf('brute-force-budget', '3'));
const BRUTE_MAX_BLOCKS = Number(argOf('brute-force-max-blocks', '80'));
const EXCEPTION_MODEL = argOf('exception-model', 'instruction');
const SCOPE_INFOS = argOf('scope-infos', '1') !== '0';

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
/** log2-ish buckets, so a distribution fits in a table. */
function bucket(n) {
  if (n <= 0) return '0';
  if (n <= 8) return String(n);
  if (n <= 16) return '9-16';
  if (n <= 32) return '17-32';
  if (n <= 64) return '33-64';
  if (n <= 128) return '65-128';
  if (n <= 256) return '129-256';
  if (n <= 512) return '257-512';
  if (n <= 1024) return '513-1024';
  if (n <= 4096) return '1025-4096';
  return '4097+';
}

const R = {
  file: path.basename(file), profile: profileDir, ok: true, error: null,
  units: 0, compiled: 0, failed: 0, instructions: 0,
  blocks: 0, reachableBlocks: 0, unreachableBlocks: 0, edges: 0,
  edgesByKind: {}, blockKinds: {},
  loops: 0, backEdges: 0, retreatingEdges: 0, irreducibleFunctions: 0, irreducibleEdges: 0,
  irreducibleAsync: 0, irreducibleGenerator: 0, irreducibleNeither: 0,
  irreducibleEvenWithoutResumeFunctions: 0, irreducibleEvenWithoutResumeEdges: 0,
  generatorResumeEdges: 0, generatorDispatchBlocks: 0,
  jumpLoopEdges: 0, jumpLoopBackEdges: 0, jumpLoopIrreducible: 0,
  jumpLoopCycleBrokenBySuspend: 0, jumpLoopUnclassified: 0, functionsWithLoopBrokenBySuspend: 0,
  irreducibleTerminators: {}, irreducibleExamples: [], irreducibleHardExamples: [],
  endlessLoops: 0, multiLatchLoops: 0, multiExitLoops: 0, virtualExitEdges: 0,
  phis: 0, maxPhiArity: 0, values: 0, projections: 0, caughtExceptionDefs: 0,
  effectChainOps: 0, effectPhis: 0, effectfulOps: 0, allocatingOps: 0, effectKindCounts: {},
  handlers: 0, handlerBlocks: 0, exceptionEdges: 0, switchEdges: 0, switchDispatchBlocks: 0,
  rangesWithoutThrowingInstruction: 0, handlerNotInsideEnclosingRange: 0,
  liveInWrittenByThrowingTerminator: 0, accumulatorLiveInAtHandler: 0, clobberedUses: 0,
  contextSlotOps: 0, contextSlotResolved: 0, contextSlotUnresolved: 0, contextSlotWhy: {},
  contextSlotDepthHist: {}, contextFrames: 0, contextHeaderSource: null,
  functionsWithExceptionEdges: 0, functionsWithGeneratorDispatcher: 0,
  functionsWithSwitchStatementTable: 0, functionsWithLoops: 0, functionsIrreducible: 0,
  generatorDispatchers: 0, smiSwitchTables: 0,
  dist: { blocksPerFunction: {}, edgesPerBlock: {}, instructionsPerBlock: {}, loopDepth: {}, phisPerFunction: {}, phiArity: {}, predsPerBlock: {}, exceptionPredsPerHandler: {}, valuesPerFunction: {} },
  checks: {}, checkSamples: {}, bruteForceChecked: 0,
  warningKinds: {},
  crossCheck: { backEdgeVsJumpLoop: 0, switchVsEntries: 0, handlerUnaccounted: 0 },
  elapsedMs: 0,
};

const t0 = process.hrtime.bigint();
let loaded;
try {
  loaded = unitsFromCache(file, profileDir, { scopeInfos: SCOPE_INFOS });
} catch (e) {
  R.ok = false; R.error = `read: ${e.message}`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(R));
  process.exit(0);
}
const { units, scopeInfoById, profile } = loaded;
R.units = units.length;

let bruteLeft = BRUTE_BUDGET;
for (let i = 0; i < units.length; i++) {
  const u = units[i];
  if (!u.bytecode) continue;
  R.compiled++;
  let ir;
  try {
    ir = buildIR(u, { profile, scopeInfoById, exceptionPrecision: EXCEPTION_MODEL });
  } catch (e) {
    R.failed++;
    if (R.checkSamples.buildFailure === undefined) R.checkSamples.buildFailure = [];
    if (R.checkSamples.buildFailure.length < 3) {
      R.checkSamples.buildFailure.push({ file: R.file, index: i, bytecodeId: u.bytecodeId, error: e.message, stack: String(e.stack).split('\n').slice(0, 4) });
    }
    continue;
  }
  const s = ir.stats;
  R.instructions += ir.instructions.length;
  R.blocks += ir.blocks.length;
  R.reachableBlocks += s.reachableBlocks;
  R.unreachableBlocks += s.unreachableBlocks;
  R.edges += ir.edges.length;
  for (const [k, v] of Object.entries(s.byKind ?? {})) bump(R.edgesByKind, k, v);
  for (const b of ir.blocks) {
    bump(R.blockKinds, b.kind);
    bump(R.dist.edgesPerBlock, bucket(b.succs.length));
    bump(R.dist.predsPerBlock, bucket(b.preds.length));
    bump(R.dist.instructionsPerBlock, bucket(b.instructions.length));
    if (b.isHandlerEntryFor.length) bump(R.dist.exceptionPredsPerHandler, bucket(b.exceptionPreds.length));
  }
  R.loops += ir.loops.length;
  R.backEdges += s.backEdges;
  R.retreatingEdges += s.retreatingEdges;
  R.jumpLoopEdges += s.jumpLoopEdges;
  R.jumpLoopBackEdges += s.jumpLoopBackEdges;
  R.jumpLoopIrreducible += s.jumpLoopIrreducible;
  R.jumpLoopCycleBrokenBySuspend += s.jumpLoopCycleBrokenBySuspend;
  R.jumpLoopUnclassified += s.jumpLoopUnclassified;
  if (s.jumpLoopCycleBrokenBySuspend) R.functionsWithLoopBrokenBySuspend++;
  R.endlessLoops += s.endlessLoops;
  R.multiLatchLoops += s.multiLatchLoops;
  R.multiExitLoops += s.multiExitLoops;
  R.virtualExitEdges += s.virtualExitEdges;
  for (const l of ir.loops) bump(R.dist.loopDepth, String(l.depth));
  if (ir.loops.length) R.functionsWithLoops++;
  if (s.irreducibleBackEdges) {
    R.irreducibleFunctions++;
    R.irreducibleEdges += s.irreducibleBackEdges;
    R.irreducibleAsync += (u.isAsync ? 1 : 0);
    R.irreducibleGenerator += (u.isGenerator ? 1 : 0);
    R.irreducibleNeither += (!u.isAsync && !u.isGenerator ? 1 : 0);
    for (const x of ir.loopInfo.irreducible) bump(R.irreducibleTerminators, x.terminator ?? '?');
    if (s.irreducibleWithoutGeneratorResume) {
      R.irreducibleEvenWithoutResumeFunctions++;
      R.irreducibleEvenWithoutResumeEdges += s.irreducibleWithoutGeneratorResume;
      if (R.irreducibleHardExamples.length < 8) {
        R.irreducibleHardExamples.push({
          file: R.file, index: i, bytecodeId: u.bytecodeId, name: u.name,
          isAsync: u.isAsync, isGenerator: u.isGenerator, kind: u.kind,
          blocks: ir.blocks.length, removedResumeEdges: s.generatorResumeEdgesRemoved,
          detail: ir.reducibilityWithoutGeneratorResume.irreducible.slice(0, 4),
        });
      }
    }
    if (R.irreducibleExamples.length < 5) {
      R.irreducibleExamples.push({
        file: R.file, index: i, bytecodeId: u.bytecodeId, name: u.name,
        isAsync: u.isAsync, isGenerator: u.isGenerator, kind: u.kind,
        blocks: ir.blocks.length, edges: ir.edges.length,
        generatorResumeEdges: s.generatorResumeEdges,
        irreducibleWithoutGeneratorResume: s.irreducibleWithoutGeneratorResume,
        detail: ir.loopInfo.irreducible.slice(0, 4),
      });
    }
  }
  R.phis += ir.phis.length;
  if (s.maxPhiArity > R.maxPhiArity) R.maxPhiArity = s.maxPhiArity;
  for (const p of ir.phis) bump(R.dist.phiArity, bucket(ir.values[p].operands.length));
  R.values += ir.values.length;
  R.projections += s.projections;
  R.caughtExceptionDefs += s.caughtExceptionDefs;
  R.effectChainOps += s.effectChainOps;
  R.effectPhis += s.effectPhis;
  R.effectfulOps += s.effectfulOps;
  R.allocatingOps += s.allocatingOps;
  for (const [k, v] of Object.entries(s.effectKindCounts ?? {})) bump(R.effectKindCounts, k, v);
  R.handlers += ir.handlers.length;
  R.handlerBlocks += s.handlerBlocks;
  R.exceptionEdges += s.exceptionEdges;
  R.switchEdges += s.switchEdges;
  R.switchDispatchBlocks += s.switchDispatchBlocks;
  R.generatorResumeEdges += s.generatorResumeEdges;
  R.generatorDispatchBlocks += s.generatorDispatchBlocks;
  R.rangesWithoutThrowingInstruction += s.rangesWithoutThrowingInstruction;
  R.handlerNotInsideEnclosingRange += s.handlerNotInsideEnclosingRange;
  R.liveInWrittenByThrowingTerminator += s.liveInWrittenByThrowingTerminator;
  R.accumulatorLiveInAtHandler += s.accumulatorLiveInAtHandler;
  R.clobberedUses += s.clobberedUses;

  const cs = s.contextSlots;
  R.contextSlotOps += cs.ops;
  R.contextSlotResolved += cs.resolved;
  R.contextSlotUnresolved += cs.unresolved;
  for (const [k, v] of Object.entries(cs.byWhy)) bump(R.contextSlotWhy, k, v);
  if (cs.ops) bump(R.contextSlotDepthHist, String(Math.min(cs.maxDepth, 12)));
  R.contextFrames += s.contextFrames;
  R.contextHeaderSource = s.contextHeader.source;

  bump(R.dist.blocksPerFunction, bucket(ir.blocks.length));
  bump(R.dist.phisPerFunction, bucket(ir.phis.length));
  bump(R.dist.valuesPerFunction, bucket(ir.values.length));
  if (s.exceptionEdges) R.functionsWithExceptionEdges++;

  // generator dispatcher vs real switch: both are jump tables, told apart by
  // whether the switch opcode also installs a context (src/ir/cfg.mjs)
  let gen = 0, smi = 0;
  for (const b of ir.blocks) {
    if (!b.kinds.includes('switchDispatch')) continue;
    if (b.isGeneratorDispatch) gen++; else smi++;
  }
  R.generatorDispatchers += gen;
  R.smiSwitchTables += smi;
  if (gen) R.functionsWithGeneratorDispatcher++;
  if (smi) R.functionsWithSwitchStatementTable++;

  for (const w of ir.warnings) bump(R.warningKinds, `${w.stage}:${w.code}`);

  // ------------------------------------------------------------ invariants
  const brute = bruteLeft > 0 && ir.blocks.length >= 3 && ir.blocks.length <= BRUTE_MAX_BLOCKS;
  if (brute) { bruteLeft--; R.bruteForceChecked++; }
  const rep = verifyIR(ir, { bruteForce: brute });
  for (const c of rep.checks) {
    const e = R.checks[c.name] ?? (R.checks[c.name] = { violations: 0, total: 0, functions: 0 });
    e.violations += c.violations;
    e.total += c.total;
    if (c.violations) {
      e.functions++;
      const samples = R.checkSamples[c.name] ?? (R.checkSamples[c.name] = []);
      if (samples.length < 3) {
        samples.push({ file: R.file, index: i, bytecodeId: u.bytecodeId, name: u.name, kind: u.kind, isAsync: u.isAsync, isGenerator: u.isGenerator, samples: c.samples });
      }
    }
  }
}

R.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(R));
