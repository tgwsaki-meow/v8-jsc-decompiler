// tools/recover/corpus_worker.mjs
//
// One child process, one .jsc file. Writes a JSON summary and exits, so the
// host gets the memory back (ARCHITECTURE.md's host limits: 4 GB, ~2 cores).
// Never writes to stdout.
//
//   node tools/recover/corpus_worker.mjs <file.jsc> <profileDir> <out.json>

import fs from 'node:fs';
import path from 'node:path';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover } from '../../src/recover/index.mjs';

const [file, profileDir, outPath] = process.argv.slice(2);
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };

/** One opcode's count in this function. `opcodeHistogram` is a Map. */
function histo(ir, op) {
  const h = ir.disasm?.stats?.opcodeHistogram;
  if (!h) return 0;
  if (typeof h.get === 'function') return h.get(op) ?? 0;
  return h[op] ?? 0;
}

const R = {
  file: path.basename(file), ok: false, error: null,
  units: 0, compiled: 0, recovered: 0, failed: 0, failures: [],
  functionsWithNoHoles: 0, singleBlock: 0, singleBlockNoHoles: 0,
  singleBlockHoles: 0, holes: 0, holesInStmts: 0, holesInExprs: 0,
  holesInUnusedExprs: 0, byHoleWhy: {}, byUnusedHoleWhy: {},
  statements: 0, exprs: 0, values: 0, dead: 0, movesDropped: 0,
  inlined: 0, materialised: 0, duplicable: 0,
  blockedByMultipleUses: 0, blockedByEffectOrder: 0, blockedByDominance: 0,
  allocationsMaterialised: 0, callsMaterialised: 0,
  violations: 0, byViolation: {}, violationSamples: [],
  duplicatedValues: 0, duplicatedAllocations: 0, duplicatedEffectful: 0,
  ctxIdentifiers: 0, undeclaredNames: 0,
  patternsByKind: {}, patternsByFamily: {}, patternsByConfidence: {},
  namesByOrigin: {}, declarationsByKind: {},
  slotOps: 0, slotResolved: 0, unresolvedSlots: 0, sanitisedNames: 0,
  suspendGenerator: 0, resumeGenerator: 0, switchOnGeneratorState: 0,
  awaitPatterns: 0, yieldPatterns: 0, yieldStarPatterns: 0,
  ctxSlotNamesByOrigin: {},
  handlerRanges: 0, asyncAwaitRanges: 0, consumedHandlerRanges: 0,
  consumedInstructions: 0, instructions: 0,
  warningKinds: {}, slowest: [], elapsedMs: 0,
};

const t0 = Date.now();
try {
  const { units, profile, scopeInfoById } = loadUnits(file, profileDir);
  const unitsBySfi = new Map(units.map((u) => [u.sfiId, u]));
  R.units = units.length;
  for (const u of units) {
    if (!u.bytecode) continue;
    R.compiled++;
    let ir = null, rec = null;
    try {
      ir = buildIR(u, { profile, scopeInfoById });
      rec = recover(ir, { unitsBySfi });
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
    R.recovered++;
    const s = rec.stats;
    R.instructions += ir.instructions.length;
    R.statements += s.emit.statements;
    R.exprs += rec.exprs.size;
    R.values += s.values;
    R.dead += s.dead;
    R.movesDropped += s.movesDropped;
    R.inlined += s.inline.inlinedTotal ?? s.inline.inlined;
    R.materialised += s.materialised;
    R.duplicable += s.duplicable;
    R.blockedByMultipleUses += s.inline.blockedByMultipleUses;
    R.blockedByEffectOrder += s.inline.blockedByEffectOrder;
    R.blockedByDominance += s.inline.blockedByDominance;
    R.allocationsMaterialised += s.inline.allocationsMaterialised;
    R.callsMaterialised += s.inline.callsMaterialised;
    R.holes += s.holes;
    R.holesInStmts += s.emit.holesInStmts;
    R.holesInExprs += s.emit.holesInExprs;
    R.holesInUnusedExprs += s.emit.holesInUnusedExprs;
    R.consumedInstructions += s.consumedInstructions;
    R.consumedHandlerRanges += s.consumedHandlerRanges;
    for (const [k, c] of Object.entries(s.emit.byHoleWhy)) bump(R.byHoleWhy, k, c);
    for (const [k, c] of Object.entries(s.emit.byUnusedHoleWhy)) bump(R.byUnusedHoleWhy, k, c);
    for (const [k, c] of Object.entries(s.patterns.byKind)) bump(R.patternsByKind, k, c);
    for (const [k, c] of Object.entries(s.patterns.byFamily)) bump(R.patternsByFamily, k, c);
    for (const [k, c] of Object.entries(s.patterns.byConfidence)) bump(R.patternsByConfidence, k, c);
    for (const [k, c] of Object.entries(s.names.byOrigin)) bump(R.namesByOrigin, k, c);
    for (const d of rec.names.declarations) bump(R.declarationsByKind, d.kind);
    R.slotOps += s.names.slotOps;
    R.slotResolved += s.names.slotResolved;
    R.unresolvedSlots += s.names.unresolvedSlots;
    R.sanitisedNames += s.names.sanitised;
    if (s.holes === 0) R.functionsWithNoHoles++;
    const isSingle = ir.dominators.rpo.length === 1;
    if (isSingle) {
      R.singleBlock++;
      if (s.holes === 0) R.singleBlockNoHoles++;
      R.singleBlockHoles += s.holes;
    }
    const v = rec.verification;
    R.violations += v.violationCount;
    R.duplicatedValues += v.counts.duplicatedValues;
    R.duplicatedAllocations += v.counts.duplicatedAllocations;
    R.duplicatedEffectful += v.counts.duplicatedEffectful;
    R.ctxIdentifiers += v.counts.ctxIdentifiers;
    R.undeclaredNames += v.counts.undeclaredNames;
    for (const x of v.violations) {
      bump(R.byViolation, x.code);
      if (R.violationSamples.length < 6) {
        R.violationSamples.push({ unit: u.bytecodeId ?? null, name: u.name ?? null, ...x });
      }
    }
    for (const w of rec.warnings) bump(R.warningKinds, w.code);
    // src/disasm's opcodeHistogram is a Map, not a plain object. Reading it
    // with `[op]` is what made the first trial report 0 SuspendGenerator
    // against 223 `await` claims -- an impossible pair, since the await
    // recogniser is anchored on SuspendGenerator.
    R.suspendGenerator += histo(ir, 'SuspendGenerator');
    R.resumeGenerator += histo(ir, 'ResumeGenerator');
    R.switchOnGeneratorState += histo(ir, 'SwitchOnGeneratorState');
    // 10.3's 98.726% is a rate over context-slot OPERANDS, so the origin
    // distribution over all named values cannot be compared with it. The
    // apples-to-apples number is the origin of each context-slot NAME.
    for (const [, r] of rec.names.byContextSlot) bump(R.ctxSlotNamesByOrigin, r.origin ?? 'unknown');
    R.awaitPatterns += s.patterns.byKind.await ?? 0;
    R.yieldPatterns += s.patterns.byKind.yield ?? 0;
    R.yieldStarPatterns += s.patterns.byKind.yieldStar ?? 0;
    R.handlerRanges += (ir.handlers ?? []).length;
    R.asyncAwaitRanges += (ir.handlers ?? []).filter((h) => {
      const p = h.predictionName ?? h.prediction;
      return p === 'ASYNC_AWAIT' || p === 'UNCAUGHT_ASYNC_AWAIT';
    }).length;
    if (s.elapsedMs > 150) {
      R.slowest.push({ unit: u.bytecodeId ?? null, name: u.name ?? null, ms: Math.round(s.elapsedMs), blocks: ir.blocks.length });
    }
  }
  R.ok = true;
} catch (e) {
  R.error = String(e.message).slice(0, 600);
}
R.elapsedMs = Date.now() - t0;
// Wall and CPU separately: the host runs two of these plus an IDE on two
// cores, so a wall number says more about contention than about this code.
const cpu = process.cpuUsage();
R.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
R.slowest.sort((a, b) => b.ms - a.ms);
R.slowest = R.slowest.slice(0, 5);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(R));
