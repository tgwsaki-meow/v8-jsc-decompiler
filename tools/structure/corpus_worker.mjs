// tools/structure/corpus_worker.mjs
//
// One child process, one .jsc file. Writes a JSON summary and exits, so the
// host gets the memory back (ARCHITECTURE.md's host limits: 4 GB, ~2 cores).
// Never writes to stdout.
//
//   node tools/structure/corpus_worker.mjs <file.jsc> <profileDir> <out.json>
//
// Nothing from the corpus is executed; the file is read as data.

import fs from 'node:fs';
import path from 'node:path';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { structure } from '../../src/structure/index.mjs';

const [file, profileDir, outPath] = process.argv.slice(2);
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };

const R = {
  file: path.basename(file), ok: false, error: null,
  units: 0, compiled: 0, structured: 0, failed: 0, failures: [],

  // ---- coverage (11.3 invariant 1)
  blocks: 0, reachableBlocks: 0, placedBlocks: 0, consumedBlocks: 0,
  removedBlocks: 0, regions: 0,
  coverageViolations: 0, invariantViolations: 0, byInvariant: {},
  violationSamples: [],

  // ---- metric 1: back edges -> loop statement
  irBackEdges: 0, irBackEdgesInLoop: 0,
  jumpLoops: 0, jumpLoopsInLoop: 0, backEdgeMisses: [],
  loopsFound: 0, loopRegions: 0, loopForms: {},
  loopPlanForms: {}, testInHeader: 0, testBelowHeader: 0, testChainBlocks: 0,
  testChainNotConsumed: 0, testBlockNotConsumed: 0, followAfterBody: 0,
  multiExitLoops: 0, multiLatchLoops: 0, endlessLoops: 0, loopsWithoutFollow: 0,
  forInLoops: 0, forOfLoops: 0, loopTestBlocks: 0,

  // ---- metric 2: handler ranges -> try
  handlerRanges: 0, rangesByPrediction: {}, tryByPrediction: {},
  missedByPrediction: {}, tryRangesPlanned: 0, tryRegions: 0,
  skippedHandlerRanges: 0, skippedHandlerWhy: {},
  asyncHandlerRanges: 0, asyncHandlerBlocks: 0, asyncTryViolations: 0,
  finallyShapes: 0, finallyShapeKinds: {}, normalCompletionTailBlocks: 0,

  // ---- stage 1: the generator dispatcher
  dispatchers: 0, dispatcherBlocksRemoved: 0, dispatcherBlocksKept: 0,
  resumeEdgesRemoved: 0, splices: 0, unsplicedResumeEdges: 0,
  suspendPoints: 0,
  irreducibleBefore: 0, irreducibleAfter: 0, functionsIrreducibleBefore: 0,
  functionsIrreducibleAfter: 0, irreducibleSamples: 0,

  // ---- switches
  jumpTables: 0, generatorDispatchTables: 0, compareChains: 0,
  compareChainLinks: 0, switchRegions: {}, guardBlocks: 0,

  // ---- the fall-back, never hidden
  unstructuredRegions: 0, unstructuredBlocks: 0, unstructuredWhy: {},
  fellBack: 0, fellBackWhy: {}, fellBackSamples: [],

  // ---- shape
  singleBlockFunctions: 0, singleBlockTrivial: 0,
  ifs: 0, seqs: 0, breaks: 0, continues: 0, labels: 0,
  labelledBreaks: 0, labelledContinues: 0,
  followFromDomChildren: 0, followFromIpdom: 0, followNull: 0,

  warnings: 0, warningKinds: {}, slowest: [], elapsedMs: 0,
};

const t0 = Date.now();
try {
  const { units, profile, scopeInfoById } = loadUnits(file, profileDir);
  R.units = units.length;
  for (const u of units) {
    if (!u.bytecode) continue;
    R.compiled++;
    let ir = null, sf = null;
    try {
      ir = buildIR(u, { profile, scopeInfoById });
      sf = structure(ir, { verify: true });
    } catch (e) {
      R.failed++;
      if (R.failures.length < 8) {
        R.failures.push({
          unit: u.bytecodeId ?? null, name: u.name ?? null,
          error: String(e.message).slice(0, 400),
          at: (e.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? null,
        });
      }
      continue;
    }
    R.structured++;
    const s = sf.stats;

    R.blocks += s.blocks;
    R.reachableBlocks += s.reachableBlocks;
    R.placedBlocks += s.placedBlocks;
    R.consumedBlocks += s.consumedBlocks;
    R.removedBlocks += s.removedBlocks;
    R.regions += s.regions;

    R.irBackEdges += s.irBackEdges;
    R.irBackEdgesInLoop += s.irBackEdgesInLoop;
    R.jumpLoops += s.jumpLoops;
    R.jumpLoopsInLoop += s.jumpLoopsInLoop;
    for (const m of s.irBackEdgeMisses ?? []) {
      if (R.backEdgeMisses.length < 6) R.backEdgeMisses.push({ unit: u.bytecodeId ?? null, name: u.name ?? null, ...m });
    }
    R.loopsFound += s.loopsFound;
    R.loopRegions += s.loopRegions;
    for (const [k, c] of Object.entries(s.loopForms ?? {})) bump(R.loopForms, k, c);
    for (const f of ['while', 'doWhile', 'for', 'forever']) bump(R.loopPlanForms, f, s[f] ?? 0);
    R.testInHeader += s.testInHeader ?? 0;
    R.testBelowHeader += s.testBelowHeader ?? 0;
    R.testChainBlocks += s.testChainBlocks ?? 0;
    R.testChainNotConsumed += s.testChainNotConsumed ?? 0;
    R.testBlockNotConsumed += s.testBlockNotConsumed ?? 0;
    R.followAfterBody += s.followAfterBody ?? 0;
    R.multiExitLoops += s.multiExit ?? 0;
    R.multiLatchLoops += s.multiLatch ?? 0;
    R.endlessLoops += s.endless ?? 0;
    R.loopsWithoutFollow += s.noFollow ?? 0;
    R.forInLoops += s.forIn ?? 0;
    R.forOfLoops += s.forOf ?? 0;
    R.loopTestBlocks += (sf.removed.loopTestBlocks ?? []).length;

    R.handlerRanges += s.handlerRanges;
    for (const [k, c] of Object.entries(s.handlerRangesByPrediction ?? {})) bump(R.rangesByPrediction, k, c);
    for (const [k, c] of Object.entries(s.tryByPrediction ?? {})) bump(R.tryByPrediction, k, c);
    for (const [k, c] of Object.entries(s.missedByPrediction ?? {})) bump(R.missedByPrediction, k, c);
    R.tryRangesPlanned += s.tryRangesPlanned;
    R.tryRegions += s.tryRegions;
    R.skippedHandlerRanges += s.skippedHandlerRanges;
    for (const [k, c] of Object.entries(s.skippedHandlerWhy ?? {})) bump(R.skippedHandlerWhy, k, c);
    R.asyncHandlerRanges += s.asyncHandlerRanges;
    R.asyncHandlerBlocks += (sf.removed.asyncHandlerBlocks ?? []).length;
    R.finallyShapes += s.finallyShapes;
    for (const [k, c] of Object.entries(s.finallyShapeKinds ?? {})) bump(R.finallyShapeKinds, k, c);
    for (const [, p] of sf.tryPlans) R.normalCompletionTailBlocks += (p.normalCompletionTail ?? []).length;

    R.dispatchers += s.dispatchers ?? 0;
    R.dispatcherBlocksRemoved += s.dispatcherBlocksRemoved ?? 0;
    R.dispatcherBlocksKept += s.dispatcherBlocksKept ?? 0;
    R.resumeEdgesRemoved += s.resumeEdgesRemoved ?? 0;
    R.splices += s.splices ?? 0;
    R.unsplicedResumeEdges += s.unsplicedResumeEdges ?? 0;
    R.suspendPoints += s.suspendPoints ?? 0;
    R.irreducibleBefore += s.irreducibleBeforeRemoval;
    R.irreducibleAfter += s.irreducibleAfterRemoval;
    if (s.irreducibleBeforeRemoval) R.functionsIrreducibleBefore++;
    if (s.irreducibleAfterRemoval) {
      R.functionsIrreducibleAfter++;
      if (R.irreducibleSamples < 4) {
        R.irreducibleSamples++;
        R.violationSamples.push({
          unit: u.bytecodeId ?? null, name: u.name ?? null, code: 'irreducibleAfterRemoval',
          detail: s.irreducibleAfterRemovalDetail,
        });
      }
    }

    R.jumpTables += s.jumpTables ?? 0;
    R.generatorDispatchTables += s.generatorDispatchers ?? 0;
    R.compareChains += s.compareChains ?? 0;
    R.compareChainLinks += s.compareChainLinks ?? 0;
    R.guardBlocks += s.guardBlocks ?? 0;
    for (const [k, c] of Object.entries(s.switchRegions ?? {})) bump(R.switchRegions, k, c);

    R.unstructuredRegions += s.unstructuredRegions;
    R.unstructuredBlocks += s.unstructuredBlocks;
    for (const [k, c] of Object.entries(s.unstructuredWhy ?? {})) bump(R.unstructuredWhy, k, c);
    if (s.fellBack) {
      R.fellBack++;
      bump(R.fellBackWhy, s.fellBackWhy ?? 'unknown');
      if (R.fellBackSamples.length < 6) {
        R.fellBackSamples.push({
          unit: u.bytecodeId ?? null, name: u.name ?? null, why: s.fellBackWhy,
          blocks: s.reachableBlocks, detail: JSON.stringify(sf.fellBack?.detail ?? {}).slice(0, 300),
        });
      }
    }

    R.singleBlockFunctions += s.singleBlockFunction;
    R.singleBlockTrivial += s.singleBlockTrivial;
    R.ifs += s.ifs ?? 0;
    R.seqs += s.seqs ?? 0;
    R.breaks += s.breaks ?? 0;
    R.continues += s.continues ?? 0;
    R.labels += s.labels ?? 0;
    R.labelledBreaks += s.labelledBreaks ?? 0;
    R.labelledContinues += s.labelledContinues ?? 0;
    R.followFromDomChildren += s.followFromDomChildren ?? 0;
    R.followFromIpdom += s.followFromIpdom ?? 0;
    R.followNull += s.followNull ?? 0;

    for (const c of sf.verification?.checks ?? []) {
      if (!c.violations) continue;
      R.invariantViolations += c.violations;
      bump(R.byInvariant, c.name, c.violations);
      if (c.name.startsWith('every reachable')) R.coverageViolations += c.violations;
      if (R.violationSamples.length < 12) {
        R.violationSamples.push({
          unit: u.bytecodeId ?? null, name: u.name ?? null, code: c.name,
          violations: c.violations, samples: c.samples,
        });
      }
    }
    // 11.2 constraint 3, asserted here as well as in src/structure/verify.mjs
    // so the corpus number cannot come from the same code path that is
    // supposed to guarantee it
    const asyncIdx = new Set(sf.removed.asyncHandlerRanges);
    for (const [i] of sf.tryPlans) if (asyncIdx.has(i)) R.asyncTryViolations++;

    R.warnings += sf.warnings.length;
    for (const w of sf.warnings) bump(R.warningKinds, `${w.stage}:${w.code}`);
    if (s.elapsedMs > 150) {
      R.slowest.push({ unit: u.bytecodeId ?? null, name: u.name ?? null, ms: Math.round(s.elapsedMs), blocks: s.blocks });
    }
  }
  R.ok = true;
} catch (e) {
  R.error = String(e.message).slice(0, 600);
}
R.elapsedMs = Date.now() - t0;
R.slowest.sort((a, b) => b.ms - a.ms);
R.slowest = R.slowest.slice(0, 5);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(R));
