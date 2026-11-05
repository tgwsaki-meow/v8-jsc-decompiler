#!/usr/bin/env node
// Metric 9: unresolved read-only references.
//
// A kReadOnlyHeapRef in a constant pool is a pointer into V8's read-only heap,
// addressed as (chunkIndex, chunkOffset). The decompiler has to turn it back
// into a value -- usually a string -- and `legacy/src/dataflow.js` throws
// UnknownReadOnlyHeapRefError when it cannot (correctly: ARCHITECTURE.md 3.6
// forbids guessing). So "unresolved RO refs" is measured as hit rate against a
// table, for both tables that exist:
//
//   legacy  rules/v8-ro-heap.json           scraped from a binary that no
//                                           longer exists (3182 strings only)
//   T2      profiles/14.4.258.16/ro-heap.json  10299 objects, walked out of
//                                           Electron 40's v8_context_snapshot
//
// Scope: refs reachable in the decoded constant pools of the sampled .jsc,
// which is where the decompiler consumes them. A whole-heap-graph count needs
// T4's typed object model; this measures what the pipeline actually hits.
//
// Usage: node tools/metrics/collect/ro_refs.mjs --mode quick --out <json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const AUTHORITY = 'profiles/14.4.258.16/ro-heap.json';

if (argv.includes('--child')) {
  const jscPath = val('--file');
  const outPath = val('--child');
  const row = { jsc: path.basename(jscPath), inputBytes: fs.statSync(jscPath).size };
  try {
    const { JSCDeserializer } = await import('../../../legacy/src/deserializer.js');
    const { V8Profile } = await import('../../../legacy/src/profile.js');
    const profile = new V8Profile();
    const des = new JSCDeserializer(profile);
    const res = des.deserializeFile(jscPath);
    const authority = fs.existsSync(AUTHORITY) ? JSON.parse(fs.readFileSync(AUTHORITY, 'utf8')).objects : null;

    const occ = new Map();   // "chunk:offset" -> count
    let constants = 0;
    for (const fn of res.functions) {
      for (const c of fn.constants ?? []) {
        constants++;
        if (c && typeof c === 'object' && c.type === 'ReadOnlyHeapRef') {
          const k = `${c.chunkIndex}:${c.chunkOffset}`;
          occ.set(k, (occ.get(k) ?? 0) + 1);
        }
      }
    }
    let legacyHitDistinct = 0, legacyHitOcc = 0, authHitDistinct = 0, authHitOcc = 0, occTotal = 0;
    const unresolved = [];
    for (const [k, n] of occ) {
      occTotal += n;
      const [ci, co] = k.split(':').map(Number);
      const legacy = profile.getReadOnlyRef(ci, co);
      if (legacy !== null && legacy !== undefined) { legacyHitDistinct++; legacyHitOcc += n; }
      const auth = authority ? authority[k] : undefined;
      if (auth) { authHitDistinct++; authHitOcc += n; }
      else if (unresolved.length < 20) unresolved.push({ ref: k, occurrences: n });
    }
    Object.assign(row, {
      ok: true,
      functions: res.functions.length,
      constants,
      distinctRefs: occ.size,
      refOccurrences: occTotal,
      legacyHitDistinct, legacyHitOcc,
      authorityHitDistinct: authHitDistinct, authorityHitOcc: authHitOcc,
      authorityPresent: Boolean(authority),
      unresolvedExamples: unresolved,
    });
  } catch (e) {
    row.ok = false;
    row.error = `${e?.constructor?.name}: ${String(e?.message).slice(0, 200)}`;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(row));
  process.exit(0);
}

const mode = val('--mode', 'quick');
const outPath = val('--out', `scratch/t3/metrics/ro_refs.${mode}.json`);
const { controlFlowSample } = await import('../samples.mjs');
const sample = controlFlowSample(mode);
const work = 'scratch/t3/work/metrics-ro';
fs.mkdirSync(work, { recursive: true });

const rows = [];
for (const f of sample.files) {
  const childOut = path.join(work, f.name + '.ro.json');
  fs.rmSync(childOut, { force: true });
  const fd = fs.openSync(path.join(work, f.name + '.ro.log'), 'w');
  try {
    spawnSync(process.execPath, ['--max-old-space-size=1400', process.argv[1], '--file', f.path, '--child', childOut],
      { stdio: ['ignore', fd, fd], timeout: 300_000, windowsHide: true });
  } finally { fs.closeSync(fd); }
  rows.push(fs.existsSync(childOut) ? JSON.parse(fs.readFileSync(childOut, 'utf8'))
                                    : { jsc: f.name, inputBytes: f.size, ok: false, error: 'child produced no result' });
  const r = rows[rows.length - 1];
  process.stderr.write(`${r.jsc.padEnd(40)} refs=${r.distinctRefs ?? '-'}/${r.refOccurrences ?? '-'} legacy=${r.legacyHitDistinct ?? '-'} authority=${r.authorityHitDistinct ?? '-'}\n`);
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const result = {
  collector: 'ro_refs',
  generatedAt: new Date().toISOString(),
  mode,
  authorityTable: AUTHORITY,
  authorityPresent: rows.some((r) => r.authorityPresent),
  sample: { ...sample, files: sample.files.map((f) => ({ name: f.name, size: f.size })) },
  files: rows.length,
  filesOk: rows.filter((r) => r.ok).length,
  constants: sum('constants'),
  distinctRefs: sum('distinctRefs'),
  refOccurrences: sum('refOccurrences'),
  legacy: { distinctHits: sum('legacyHitDistinct'), occurrenceHits: sum('legacyHitOcc') },
  authority: { distinctHits: sum('authorityHitDistinct'), occurrenceHits: sum('authorityHitOcc') },
  metrics: {
    m9_unresolvedRoRefs: {
      distinctUnresolvedWithAuthorityTable: sum('distinctRefs') - sum('authorityHitDistinct'),
      occurrencesUnresolvedWithAuthorityTable: sum('refOccurrences') - sum('authorityHitOcc'),
      distinctUnresolvedWithLegacyTable: sum('distinctRefs') - sum('legacyHitDistinct'),
      distinctRefs: sum('distinctRefs'),
      refOccurrences: sum('refOccurrences'),
      note: 'distinct refs are counted per file, so the same ref in two files counts twice',
    },
  },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
