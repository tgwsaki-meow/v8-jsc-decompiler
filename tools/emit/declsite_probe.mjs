// tools/emit/declsite_probe.mjs
//
// What docs/EMIT.md 9.11 is measured with: for one or more `.jsc` files, every
// context binding of the file with the clause that decided its declaration
// site, cross-tabulated against the thing the fix is for -- whether the
// ORIGINAL reads that binding with `LdaImmutable*ContextSlot`.
//
//   node tools/emit/declsite_probe.mjs --out <file.tsv> [--profile <dir>] <file.jsc>...
//
// Three questions it answers, none of which the O1 runner can:
//
//   1. of the bindings the original reads immutably, how many do we now
//      declare at their store (i.e. how much of `load-form` is reachable at
//      all), and what refuses the rest, by named reason;
//   2. whether clause 1 (the ScopeInfo's own maybe_assigned bit) is load-
//      bearing: `refusedForMaybeAssignedOnly` counts the bindings the
//      dominance clauses would have admitted and the original says are
//      assigned more than once at declaration -- declaring those would emit
//      the immutable opcode where the original emits the mutable one;
//   3. whether V8's TDZ initialisation really is a second store, which is why
//      clause 2 counts program stores and not stores (`holeInits`).
//
// Nothing from the corpus is executed; the file is read as data.

import fs from 'node:fs';
import path from 'node:path';
import { loadFor } from '../../src/emit/decompile.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover } from '../../src/recover/index.mjs';
import { structure } from '../../src/structure/index.mjs';
import { emit, buildUnitTree } from '../../src/emit/index.mjs';
import { planScopes } from '../../src/emit/scopes.mjs';
import { planDeclarationSites } from '../../src/emit/declsite.mjs';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const OUT = argOf('out', 'scratch/declsite_probe.tsv');
const PROFILE = argOf('profile', null);
const FILES = process.argv.slice(2).filter((a) => a.endsWith('.jsc'));

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };

/** IR + T7 + T8 for one file, in decompile.mjs's own order. */
function pipeline(file) {
  const loaded = loadFor(file, PROFILE ? { profile: PROFILE } : {});
  const { units, profile, scopeInfoById } = loaded;
  const recs = [];
  const sfs = [];
  for (const u of units) {
    if (!u.bytecode) continue;
    try {
      const ir = buildIR(u, { profile, scopeInfoById });
      const rec = recover(ir, {});
      const sf = structure(ir, { profile });
      recs.push(rec); sfs.push(sf);
    } catch { /* a unit that fails is a `failures[]` row in emit; not this probe's subject */ }
  }
  return { units, recs, sfs };
}

const TOTAL = {
  files: 0, bindings: 0, atStore: 0, refused: 0, byWhy: {},
  atStoreByDeclKind: {}, refusedForMaybeAssignedOnly: 0,
  immutableBindings: 0, immutableAtStore: 0, immutableByWhy: {},
  mutableBindings: 0, mutableAtStore: 0,
  holeInitHistogram: {}, programStoreHistogram: {},
  modeAtStore: {}, modeRefused: {},
  report: {
    functions: 0, declaredAtStoreSite: 0, reverted: 0, revertsByWhy: {},
    constAsLet: 0, byKeyword: {}, differentSpelling: 0, emittedTwice: 0,
    invariantViolations: 0, holes: 0, codeBytes: 0,
  },
  perFile: [],
};

for (const file of FILES) {
  const t0 = Date.now();
  let p;
  try { p = pipeline(file); } catch (e) {
    TOTAL.perFile.push({ file: path.basename(file), error: String(e.message).slice(0, 120) });
    continue;
  }
  TOTAL.files++;

  const byId = new Map();
  const order = [];
  for (let i = 0; i < p.recs.length; i++) {
    const unit = p.recs[i].ir.unit;
    if (byId.has(unit.sfiId)) continue;
    const row = { sfiId: unit.sfiId, unit, rec: p.recs[i], sf: p.sfs[i], failure: null };
    byId.set(unit.sfiId, row); order.push(row);
  }
  const { childrenOf, roots } = buildUnitTree(order, byId);
  const scopes = planScopes({ order, childrenOf, roots, reserved: [] });
  const plan = planDeclarationSites({ order, scopes });

  // --- how the ORIGINAL reads each binding: the immutable opcode or not.
  //     `v.contextSlot.immutable` is set for Lda{Immutable,}* by
  //     src/ir/index.mjs off the opcode's own semantics, so this is the
  //     original's answer and not an inference.
  const immutableOf = new Map();          // Binding -> {immutable, mutable}
  for (const r of order) {
    const sc = scopes.forUnit(r.sfiId);
    const ir = r.rec.ir;
    for (const [slotId, b] of sc.slotBinding) {
      const loc = ir.values[slotId];
      if (!loc) continue;
      let c = immutableOf.get(b);
      if (!c) { c = { immutable: 0, mutable: 0 }; immutableOf.set(b, c); }
      for (const opId of loc.loads ?? []) {
        const v = ir.values[opId];
        if (!v?.contextSlot) continue;
        if (v.contextSlot.immutable) c.immutable++; else c.mutable++;
      }
    }
  }

  const F = {
    file: path.basename(file), units: order.length,
    bindings: plan.stats.bindings, atStore: plan.stats.atStore, refused: plan.stats.refused,
    immutableBindings: 0, immutableAtStore: 0,
    refusedForMaybeAssignedOnly: plan.stats.refusedForMaybeAssignedOnly,
    ms: 0,
  };
  for (const [b, row] of plan.rows) {
    const at = plan.sites.has(b);
    const c = immutableOf.get(b) ?? { immutable: 0, mutable: 0 };
    const isImmutable = c.immutable > 0;
    bump(TOTAL.holeInitHistogram, String(row.holeInits));
    bump(TOTAL.programStoreHistogram, String(row.programStores.length));
    if (isImmutable) {
      TOTAL.immutableBindings++; F.immutableBindings++;
      if (at) { TOTAL.immutableAtStore++; F.immutableAtStore++; }
      else bump(TOTAL.immutableByWhy, row.why ?? 'unknown');
    } else {
      TOTAL.mutableBindings++;
      if (at) TOTAL.mutableAtStore++;
    }
    if (at) bump(TOTAL.modeAtStore, b.declKind); else bump(TOTAL.modeRefused, b.declKind);
  }
  TOTAL.bindings += plan.stats.bindings;
  TOTAL.atStore += plan.stats.atStore;
  TOTAL.refused += plan.stats.refused;
  TOTAL.refusedForMaybeAssignedOnly += plan.stats.refusedForMaybeAssignedOnly;
  for (const [k, v] of Object.entries(plan.stats.byWhy)) bump(TOTAL.byWhy, k, v);
  for (const [k, v] of Object.entries(plan.stats.atStoreByDeclKind)) bump(TOTAL.atStoreByDeclKind, k, v);

  // --- and what the emitter then did with them
  const out = emit(p.recs, p.sfs, { file, units: p.units, failures: [], sourceMaps: false });
  const rep = out.report;
  TOTAL.report.functions += rep.functionsEmitted;
  TOTAL.report.declaredAtStoreSite += rep.contextBindingsDeclaredAtTheStoreSite;
  TOTAL.report.reverted += rep.declarationSitesRevertedAfterEmission;
  TOTAL.report.constAsLet += rep.constBindingsEmittedAsLet;
  TOTAL.report.differentSpelling += rep.declarationSitesWithADifferentSpelling;
  TOTAL.report.emittedTwice += rep.declarationSitesEmittedTwice;
  TOTAL.report.invariantViolations += rep.invariants.violations;
  TOTAL.report.holes += rep.holes.total;
  TOTAL.report.codeBytes += rep.codeBytes;
  for (const [k, v] of Object.entries(rep.declarationSiteRevertsByWhy ?? {})) bump(TOTAL.report.revertsByWhy, k, v);
  for (const [k, v] of Object.entries(rep.declarationSitesByKeyword ?? {})) bump(TOTAL.report.byKeyword, k, v);
  F.declaredAtStoreSite = rep.contextBindingsDeclaredAtTheStoreSite;
  F.reverted = rep.declarationSitesRevertedAfterEmission;
  F.constAsLet = rep.constBindingsEmittedAsLet;
  F.invariantViolations = rep.invariants.violations;
  F.ms = Date.now() - t0;
  TOTAL.perFile.push(F);
}

const L = [];
const section = (s) => { L.push(''); L.push(`== ${s}`); };
L.push(`files\t${TOTAL.files}`);
L.push(`bindings\t${TOTAL.bindings}`);
L.push(`declaredAtStoreSite(planned)\t${TOTAL.atStore}`);
L.push(`refused\t${TOTAL.refused}`);
section('the population the fix is for: bindings the ORIGINAL reads immutably');
L.push(`immutableBindings\t${TOTAL.immutableBindings}`);
L.push(`immutableBindingsDeclaredAtStore\t${TOTAL.immutableAtStore}`);
L.push(`mutableBindings\t${TOTAL.mutableBindings}`);
L.push(`mutableBindingsDeclaredAtStore\t${TOTAL.mutableAtStore}`);
section('why an immutably-read binding was refused');
for (const [k, v] of Object.entries(TOTAL.immutableByWhy).sort((a, b) => b[1] - a[1])) L.push(`${k}\t${v}`);
section('why ANY binding was refused');
for (const [k, v] of Object.entries(TOTAL.byWhy).sort((a, b) => b[1] - a[1])) L.push(`${k}\t${v}`);
L.push(`refusedForMaybeAssignedOnly\t${TOTAL.refusedForMaybeAssignedOnly}`);
section('declaration keyword, planned');
for (const [k, v] of Object.entries(TOTAL.atStoreByDeclKind)) L.push(`${k}\t${v}`);
section('ScopeInfo mode: at store / refused');
for (const k of new Set([...Object.keys(TOTAL.modeAtStore), ...Object.keys(TOTAL.modeRefused)])) {
  L.push(`${k}\t${TOTAL.modeAtStore[k] ?? 0}\t${TOTAL.modeRefused[k] ?? 0}`);
}
section('stores per binding: V8 TDZ initialisations / program stores');
for (const [k, v] of Object.entries(TOTAL.holeInitHistogram).sort()) L.push(`holeInits=${k}\t${v}`);
for (const [k, v] of Object.entries(TOTAL.programStoreHistogram).sort()) L.push(`programStores=${k}\t${v}`);
section('what the emitter did');
for (const [k, v] of Object.entries(TOTAL.report)) {
  L.push(`${k}\t${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
section('per file');
L.push('file\tunits\tbindings\tatStore\trefused\timmutable\timmutableAtStore\tdeclaredAtStoreSite\treverted\tconstAsLet\tviolations\tms');
for (const f of TOTAL.perFile) {
  if (f.error) { L.push(`${f.file}\tERROR ${f.error}`); continue; }
  L.push([f.file, f.units, f.bindings, f.atStore, f.refused, f.immutableBindings,
    f.immutableAtStore, f.declaredAtStoreSite, f.reverted, f.constAsLet,
    f.invariantViolations, f.ms].join('\t'));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n'));
process.stdout.write(`${OUT}: ${TOTAL.files} file(s), ${TOTAL.bindings} bindings, ${TOTAL.atStore} at store\n`);
