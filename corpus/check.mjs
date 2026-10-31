#!/usr/bin/env node
// Corpus self-check: is the corpus itself sound, before anything is measured
// with it?
//
//   1. manifest <-> directory agree (no stray file, no missing file, hashes)
//   2. every file parses, with the sourceType the manifest claims
//   3. every file COMPILES under the minter that produces the .jsc for O1/O2
//   4. every behavioural file produces a non-empty trace and does not throw
//      out of its own body (a file that throws cannot discriminate anything)
//   5. group / mode / kind census
//
// Usage:
//   node corpus/check.mjs                 # everything
//   node corpus/check.mjs --no-exec       # skip 3 and 4 (parse + manifest only)
//   node corpus/check.mjs --grep '^try-'

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';
import { loadManifest, loadEntries, CORPUS_DIR } from '../src/verify/corpus.mjs';
import { mintJsc, resolveMinter } from '../src/verify/mint.mjs';
import { runTraced } from '../src/verify/o3_behaviour.mjs';

const argv = process.argv.slice(2);
const noExec = argv.includes('--no-exec');
const grep = argv.includes('--grep') ? argv[argv.indexOf('--grep') + 1] : undefined;
const WORK = 'scratch/t3/work/corpus-check';
fs.mkdirSync(WORK, { recursive: true });

const doc = loadManifest();
const entries = loadEntries({ grep });
const minter = resolveMinter('auto');

const problems = [];
const rows = [];

// 1. manifest <-> directory
const declared = new Set(doc.entries.map((e) => path.basename(e.file)));
const onDisk = fs.readdirSync(CORPUS_DIR).filter((f) => /\.m?js$/.test(f));
for (const f of onDisk) if (!declared.has(f)) problems.push(`undeclared file: ${f}`);
for (const e of doc.entries) if (!fs.existsSync(e.abs)) problems.push(`missing file: ${e.file}`);

for (const e of entries) {
  const row = { id: e.id, group: e.group, kind: e.scriptOrModule, mode: e.sloppyOrStrict };
  const src = fs.readFileSync(e.abs, 'utf8');
  row.bytes = Buffer.byteLength(src, 'utf8');
  row.sha256 = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  if (row.sha256 !== e.sha256) problems.push(`${e.id}: content changed since the manifest was written (run scratch/t3/gen_corpus.mjs)`);

  // 2. parse
  try {
    parse(src, { sourceType: e.scriptOrModule === 'module' ? 'module' : 'script', allowReturnOutsideFunction: false });
    row.parses = true;
  } catch (err) {
    row.parses = false;
    row.parseError = `${err.constructor.name}: ${err.message}`;
    problems.push(`${e.id}: does not parse -- ${row.parseError}`);
  }

  if (!noExec && row.parses) {
    // 3. compiles under the minter (this is what O1/O2 feed the decompiler)
    const m = mintJsc({ source: src, outPath: path.join(WORK, e.id + '.jsc'), minter, isModule: e.scriptOrModule === 'module' });
    row.mints = m.ok;
    row.jscBytes = m.bytes ?? null;
    if (!m.ok) { row.mintError = m.error; problems.push(`${e.id}: will not compile to a .jsc -- ${m.error}`); }

    // 4. traces
    if (e.behavioural) {
      const t = runTraced(e.abs, { kind: e.scriptOrModule, workDir: WORK });
      row.traceStatus = t.status;
      row.records = t.records.length;
      row.effects = t.records.filter((r) => ['T', 'write', 'call', 'log'].includes(r.k)).length;
      const escaped = t.records.find((r) => r.k === 'throw');
      row.escapedThrow = escaped ? escaped.value : null;
      if (t.status !== 'ok') problems.push(`${e.id}: trace run ${t.status} -- ${String(t.error ?? '').slice(0, 160)}`);
      else if (row.effects === 0) problems.push(`${e.id}: produced no observable effects, so O3 cannot use it`);
      else if (escaped) problems.push(`${e.id}: threw out of its own body -- ${escaped.value}`);
    }
  }
  rows.push(row);
  process.stderr.write(`${e.id.padEnd(32)} parse=${row.parses} mint=${row.mints ?? '-'} records=${row.records ?? '-'} effects=${row.effects ?? '-'}${row.escapedThrow ? ' THREW ' + row.escapedThrow : ''}\n`);
}

const census = {};
for (const r of rows) {
  census[r.group] ??= { entries: 0, bytes: 0, effects: 0, parses: 0, mints: 0, traced: 0 };
  const c = census[r.group];
  c.entries++; c.bytes += r.bytes; c.effects += r.effects ?? 0;
  if (r.parses) c.parses++;
  if (r.mints) c.mints++;
  if (r.traceStatus === 'ok') c.traced++;
}

const summary = {
  generatedAt: new Date().toISOString(),
  minter: { label: minter.label, v8: minter.v8 },
  entries: rows.length,
  parses: rows.filter((r) => r.parses).length,
  mints: rows.filter((r) => r.mints).length,
  traced: rows.filter((r) => r.traceStatus === 'ok').length,
  withEffects: rows.filter((r) => (r.effects ?? 0) > 0).length,
  totalRecords: rows.reduce((a, r) => a + (r.records ?? 0), 0),
  totalBytes: rows.reduce((a, r) => a + r.bytes, 0),
  problems,
  census,
};

fs.mkdirSync('scratch/t3/out', { recursive: true });
fs.writeFileSync('scratch/t3/out/corpus_check.json', JSON.stringify({ summary, rows }, null, 1));

console.log('\n=== corpus/features self-check ===');
console.log(`entries           : ${summary.entries}`);
console.log(`parse             : ${summary.parses}/${summary.entries}`);
if (!noExec) {
  console.log(`compile to .jsc   : ${summary.mints}/${summary.entries}  (minter ${minter.label}, V8 ${minter.v8 ?? '?'})`);
  console.log(`trace run ok      : ${summary.traced}/${summary.entries}`);
  console.log(`with observable effects: ${summary.withEffects}/${summary.entries}  (${summary.totalRecords} trace records total)`);
}
console.log(`total size        : ${(summary.totalBytes / 1024).toFixed(1)} KB`);
console.log('');
console.log('| group | entries | KB | trace records |');
console.log('|---|---:|---:|---:|');
for (const [g, c] of Object.entries(census).sort()) {
  console.log(`| ${g} | ${c.entries} | ${(c.bytes / 1024).toFixed(1)} | ${c.effects} |`);
}
console.log('');
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`);
  for (const p of problems.slice(0, 60)) console.log(`  - ${p}`);
  if (problems.length > 60) console.log(`  ... and ${problems.length - 60} more`);
} else {
  console.log('no problems');
}
console.log('wrote scratch/t3/out/corpus_check.json');
process.exitCode = problems.length ? 1 : 0;
