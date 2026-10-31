// tools/emit/corpus_worker.mjs
//
// One child process, one .jsc file: the whole back end through src/emit, with
// a JSON summary written to a file and nothing on stdout. The host has 4 GB
// and about two cores, so a forked child per file is what gives the memory
// back and lets one pathological input be killed on a timeout instead of
// taking the run with it.
//
//   node tools/emit/corpus_worker.mjs <file.jsc> <profileDir> <out.json> [--keep-code <path>]
//
// Nothing from the corpus is ever executed; the file is read as data.

import fs from 'node:fs';
import path from 'node:path';
import { decompile } from '../../src/emit/decompile.mjs';

const [file, profileDir, outPath] = process.argv.slice(2);
const keepAt = process.argv.indexOf('--keep-code');
const keepCode = keepAt >= 0 ? process.argv[keepAt + 1] : null;

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const t0 = Date.now();

const R = {
  file: path.basename(file), ok: false, error: null,
  inputBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
  codeBytes: 0, elapsedMs: 0, stageMs: null,

  // ---- 11.5's first number: every function in the output
  units: 0, compiledUnits: 0, functionsEmitted: 0, functionsClaimedInline: 0,
  functionsFailed: 0, orphans: 0, failuresByStage: {},

  // ---- 11.3, the six invariants
  invariantViolations: 0, byInvariant: {}, violationSamples: [],

  // ---- 7: holes, never hidden
  holes: 0, holesByWhy: {}, holesByKind: {},
  unstructuredRegions: 0, unstructuredBlocks: 0, unstructuredWhy: {},

  // ---- 11.3 invariant 5
  ctxIdentifiers: 0, ctxProperties: 0, holeIdentifiers: 0,

  // ---- 11.3 invariant 4
  duplicatedValues: 0, unresolvedJoins: 0,

  // ---- what the join had to decide
  loops: 0, loopForms: {}, loopIdioms: {}, forInRebuilt: 0, forInNotRebuilt: 0,
  tries: 0, triesByPrediction: {}, finallyShapes: 0, finallyShapeKinds: {},
  switches: 0, switchForms: {}, switchGuardBlocks: 0,
  ifs: 0, breaks: 0, continues: 0, labels: 0,
  loopTestChainsMaterialised: 0, loopTestChainStatements: 0,
  catchContextBindings: 0, catchContextBindingsAmbiguous: 0,
  droppedStatementsOnRemovedBlocks: 0, droppedStatementBlocks: 0,
  droppedByRemovedKind: {}, droppedByStatementTag: {},
  topLevelReturns: 0, forcedAsync: 0, forcedGenerator: 0,
  localsRenamed: 0, outerSlotDeclaredLocally: 0, declarations: 0,
  namesReadButNeverWritten: 0, namesDeclared: 0, unwrittenSamples: [],
  unresolvedNames: 0, globalReads: 0, blocksWithoutStatements: 0,
  regionKindsNot112: {}, unknownRegionKinds: {},
  monotonicity: { functions: 0, monotone: 0, inversions: 0 },
  unitTree: {},

  // ---- the dashboard's raw counts
  bytecode: {}, metrics: {},
};

try {
  const r = decompile(file, { profile: profileDir, sourceMaps: false });
  const rep = r.report;
  R.ok = true;
  R.codeBytes = rep.codeBytes;
  R.stageMs = rep.stageMs;
  R.units = rep.unitsInTheFile ?? rep.units;
  R.compiledUnits = rep.compiledUnits;
  R.functionsEmitted = rep.functionsEmitted;
  R.functionsClaimedInline = rep.functionsClaimedInline;
  R.functionsFailed = rep.functionsFailed;
  R.orphans = rep.orphans;
  R.failuresByStage = rep.failuresByStage ?? {};
  R.holes = rep.holes.total;
  R.holesByWhy = rep.holes.byWhy;
  R.holesByKind = rep.holes.byKind;
  R.unstructuredRegions = rep.unstructuredRegions;
  R.unstructuredBlocks = rep.unstructuredBlocks;
  R.ctxIdentifiers = rep.ctxIdentifiersInTheOutput;
  R.ctxProperties = rep.ctxPropertyNamesInTheOutput ?? 0;
  R.holeIdentifiers = rep.holeIdentifiersInTheOutput;
  R.duplicatedValues = rep.duplicatedValues;
  R.unresolvedJoins = rep.unresolvedJoins;
  for (const k of ['loops', 'tries', 'finallyShapes', 'switches', 'switchGuardBlocks',
    'ifs', 'breaks', 'continues', 'labels', 'forInRebuilt', 'forInNotRebuilt',
    'loopTestChainsMaterialised', 'loopTestChainStatements', 'catchContextBindings',
    'catchContextBindingsAmbiguous', 'droppedStatementsOnRemovedBlocks',
    'droppedStatementBlocks', 'topLevelReturns', 'forcedAsync', 'forcedGenerator',
    'localsRenamed', 'outerSlotDeclaredLocally', 'declarations',
    'namesReadButNeverWritten', 'namesDeclared', 'unresolvedNames', 'globalReads',
    'blocksWithoutStatements']) {
    R[k] = rep[k] ?? 0;
  }
  R.loopForms = rep.loopForms;
  R.loopIdioms = rep.loopIdioms;
  R.triesByPrediction = rep.triesByPrediction;
  R.finallyShapeKinds = rep.finallyShapeKinds;
  R.switchForms = rep.switchForms;
  R.regionKindsNot112 = rep.regionKindsNot112;
  R.unknownRegionKinds = rep.unknownRegionKinds;
  R.droppedByRemovedKind = rep.droppedByRemovedKind ?? {};
  R.droppedByStatementTag = rep.droppedByStatementTag ?? {};
  R.measurements = rep.invariants.measurements ?? 0;
  R.byMeasurement = rep.invariants.byMeasurement ?? {};
  R.monotonicity = rep.monotonicity;
  R.unitTree = rep.unitTree ?? {};
  R.bytecode = rep.bytecode;
  R.metrics = rep.metrics;
  R.unwrittenSamples = (rep.unwrittenSamples ?? []).slice(0, 4);

  for (const [k, v] of Object.entries(rep.invariants.byInvariant)) {
    if (!v) continue;
    bump(R.byInvariant, k, v);
    R.invariantViolations += v;
  }
  R.violationSamples = rep.invariants.samples.slice(0, 6);
  for (const f of r.perFunction) {
    for (const u of f.unstructuredRegions ? [f] : []) void u;
  }
  if (keepCode) {
    fs.mkdirSync(path.dirname(keepCode), { recursive: true });
    fs.writeFileSync(keepCode, r.code);
  }
} catch (e) {
  R.error = `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 600)}`;
  R.errorAt = String(e?.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? null;
}

R.elapsedMs = Date.now() - t0;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(R));
