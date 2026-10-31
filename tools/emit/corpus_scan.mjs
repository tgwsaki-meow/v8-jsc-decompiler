#!/usr/bin/env node
// tools/emit/corpus_scan.mjs
//
// src/emit over the corpus, ONE FORKED CHILD PER FILE, results to files.
//
//   node tools/emit/corpus_scan.mjs --jobs 2
//   node tools/emit/corpus_scan.mjs --stride 8            # every 8th file
//   node tools/emit/corpus_scan.mjs --max-files 200
//   node tools/emit/corpus_scan.mjs --merge-only          # report what exists
//
// Why a child per file (the same reasoning as T7's and T8's scans): the host
// has 4 GB and about two cores, a long-lived process accumulates fragmentation
// it never gives back, a forked child returns its memory on exit, and a
// pathological file can be killed on a timeout instead of taking the whole run
// with it. One JSON per file, so the run is RESUMABLE and nothing goes through
// a pipe.
//
// `--stride N` takes every Nth file, which is a sample spread across the
// corpus rather than its alphabetical head -- the head is all browser-
// extension service workers and is not representative.
//
// Nothing from the corpus is ever executed. The emitted text is kept only when
// `--keep-code` is given, and it is never run.
//
// A full 1039-file run takes hours on this host. The sharded cloud run is
// .github/workflows/corpus-scan.yml with tools/ci/shard_corpus.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const CORPUS = val('--corpus', 'extracted_jsc');
const WORK = val('--work', 'scratch/t9/corpus');
const OUT = val('--out', 'scratch/t9/EMIT_CORPUS.md');
const PROFILE = val('--profile', path.join('profiles', '14.4.258.16'));
const JOBS = Math.max(1, Number(val('--jobs', '2')));
const TIMEOUT = Number(val('--timeout', '300000'));
const HEAP = Number(val('--heap', '1200'));
const STRIDE = Number(val('--stride', '1'));
const MAX = Number(val('--max-files', '0'));
/**
 * `--max-bytes N` keeps only inputs of at most N bytes.
 *
 * Not a convenience: on this host (4 GB, ~2 cores) the handful of multi-MB
 * bundles cost minutes each and would dominate a locally-affordable run, so a
 * sample that excludes them covers far more of the corpus per hour. The report
 * states the cap and how many files it excluded, because a sample with the
 * expensive inputs removed is a different sample.
 */
const MAX_BYTES = Number(val('--max-bytes', '0'));
const KEEP = has('--keep-code') ? val('--keep-code', 'scratch/t9/code') : null;
const WORKER = path.resolve('tools/emit/corpus_worker.mjs');

fs.mkdirSync(WORK, { recursive: true });

let files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort();
const corpusFiles = files.length;
let excludedBySize = 0;
if (MAX_BYTES > 0) {
  const before = files.length;
  files = files.filter((f) => fs.statSync(path.join(CORPUS, f)).size <= MAX_BYTES);
  excludedBySize = before - files.length;
}
if (STRIDE > 1) files = files.filter((_, i) => i % STRIDE === 0);
if (MAX > 0) files = files.slice(0, MAX);

const resultPath = (f) => path.join(WORK, f.replace(/\.jsc$/, '.emit.json'));

async function runOne(f) {
  const out = resultPath(f);
  if (fs.existsSync(out) && !has('--force')) return 'skipped';
  const args = [`--max-old-space-size=${HEAP}`, WORKER, path.join(CORPUS, f), PROFILE, out];
  if (KEEP) args.push('--keep-code', path.join(KEEP, f.replace(/\.jsc$/, '.js')));
  const logPath = path.join(WORK, f.replace(/\.jsc$/, '.log.txt'));
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, TIMEOUT);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      const wall = Date.now() - t0;
      if (!fs.existsSync(out)) {
        fs.writeFileSync(out, JSON.stringify({
          file: f, ok: false,
          error: signal ? `killed by ${signal} after ${wall} ms` : `child exited ${code}`,
          inputBytes: fs.statSync(path.join(CORPUS, f)).size,
          elapsedMs: wall, childLogTail: fs.readFileSync(logPath, 'utf8').slice(-400),
        }));
      }
      resolve('done');
    });
  });
}

if (!has('--merge-only')) {
  process.stderr.write(`emit corpus scan: ${files.length} files, ${JOBS} job(s), `
    + `profile ${PROFILE}, work ${WORK}\n`);
  let next = 0;
  let finished = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      const state = await runOne(f);
      finished++;
      const r = fs.existsSync(resultPath(f)) ? JSON.parse(fs.readFileSync(resultPath(f), 'utf8')) : null;
      const rate = (Date.now() - t0) / 1000 / Math.max(1, finished);
      process.stderr.write(`[${finished}/${files.length}] ${f.padEnd(38)} `
        + `${state === 'skipped' ? 'cached' : 'done  '} `
        + `fn=${r?.functionsEmitted ?? '-'}/${r?.compiledUnits ?? '-'} `
        + `viol=${r?.invariantViolations ?? '-'} holes=${r?.holes ?? '-'} `
        + `unstr=${r?.unstructuredRegions ?? '-'} ctx=${r?.ctxIdentifiers ?? '-'} `
        + `${r?.elapsedMs ?? '-'}ms ${rate.toFixed(1)}s/file\n`);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
}

// ------------------------------------------------------------------- merge
const rows = [];
for (const f of files) {
  const p = resultPath(f);
  if (!fs.existsSync(p)) continue;
  try { rows.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* partial write */ }
}

const ok = rows.filter((r) => r.ok);
const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const sumIn = (outer, k) => rows.reduce((a, r) => a + (Number(r[outer]?.[k]) || 0), 0);
const merge = (k) => {
  const o = {};
  for (const r of rows) for (const [kk, v] of Object.entries(r[k] ?? {})) o[kk] = (o[kk] ?? 0) + v;
  return o;
};
const mergeMetric = (name, part) => rows.reduce((a, r) => a + (Number(r.metrics?.[name]?.[part]) || 0), 0);

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(2)}%` : 'n/a');
const tbl = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ${v}`).join(', ') || '(none)';

const childMs = sum('elapsedMs');
const inputKB = sum('inputBytes') / 1024;
const lines = [];
const L = (s = '') => lines.push(s);

L('<!-- generated by tools/emit/corpus_scan.mjs -->');
L('');
L(`# \`src/emit\` over ${rows.length} corpus files`);
L('');
L(`generated ${new Date().toISOString()} · profile \`${PROFILE}\` · `
  + `${files.length} of ${corpusFiles} corpus file(s) selected`
  + `${MAX_BYTES ? ` (at most ${(MAX_BYTES / 1024).toFixed(0)} KB, which excluded ${excludedBySize})` : ''}`
  + `${STRIDE > 1 ? `, every ${STRIDE}th` : ''} · `
  + `${rows.length} with a result · ${ok.length} without an error`);
L('');
L(`sample: \`node tools/emit/corpus_scan.mjs --jobs ${JOBS} --stride ${STRIDE}`
  + `${MAX_BYTES ? ` --max-bytes ${MAX_BYTES}` : ''}\``);
L('');
L('| metric | value |');
L('|---|---:|');
L(`| files with a result | ${rows.length} |`);
L(`| files that threw or were killed | ${rows.length - ok.length} |`);
L(`| input | ${(inputKB / 1024).toFixed(1)} MB |`);
L(`| emitted JavaScript | ${(sum('codeBytes') / 1048576).toFixed(1)} MB |`);
L(`| compiled functions (SFI with bytecode) | ${sum('compiledUnits')} |`);
L(`| **functions emitted** | **${sum('functionsEmitted') + sum('functionsClaimedInline')}** `
  + `= ${pct(sum('functionsEmitted') + sum('functionsClaimedInline'), sum('compiledUnits'))} (metric 6, baseline 38.76%) |`);
L(`| of those, emitted as a stub because a layer threw | ${sum('functionsFailed')} |`);
L(`| functions emitted inline (a class constructor, an accessor) | ${sum('functionsClaimedInline')} |`);
L(`| functions emitted at the top level because their parent is missing | ${sum('orphans')} |`);
L(`| **11.3 invariant violations** | **${sum('invariantViolations')}** |`);
L(`| **the identifier \`ctx\` as a variable** | **${sum('ctxIdentifiers')}** (baseline 1 710 336) |`);
L(`| \`ctx\` as a property name (recovered source, not the banned identifier) | ${sum('ctxProperties')} |`);
L(`| **values emitted twice outside \`duplicable\`** | **${sum('duplicatedValues')}** (metric 7, baseline 12.93%) |`);
L(`| Test/Target values with no \`exprs\` entry | ${sum('unresolvedJoins')} |`);
L(`| **holes** | **${sum('holes')}** |`);
L(`| **\`unstructured\` regions** | **${sum('unstructuredRegions')}** (metric 10) |`);
L(`| blocks inside them | ${sum('unstructuredBlocks')} |`);
L(`| throughput | ${(childMs / 1000).toFixed(0)} s child CPU, `
  + `${rows.length ? (childMs / rows.length / 1000).toFixed(1) : '-'} s/file, `
  + `${inputKB ? (childMs / inputKB).toFixed(1) : '-'} ms per input KB (metric 11, baseline 4-5975) |`);
L('');
L('## the dashboard\'s raw counts');
L('');
L('| metric | numerator / denominator | share |');
L('|---|---:|---:|');
L(`| 1 — loop statements per back edge | ${sum('loops')} / ${sumIn('bytecode', 'backEdges')} `
  + `| ${pct(sum('loops'), sumIn('bytecode', 'backEdges'))} (baseline 0 / 167) |`);
L(`| 2 — \`try\` per handler range | ${sum('tries')} / ${sumIn('bytecode', 'handlerRanges')} `
  + `| ${pct(sum('tries'), sumIn('bytecode', 'handlerRanges'))} (baseline 0 / 667 exception opcodes) |`);
L(`| 3 — \`switch\` per switch-dispatch opcode | ${sum('switches')} / ${sumIn('bytecode', 'switchDispatchOpcodes')} `
  + `| ${pct(sum('switches'), sumIn('bytecode', 'switchDispatchOpcodes'))} (baseline 0 / 160) |`);
L(`| 6 — functions emitted / deserialized | ${sum('functionsEmitted') + sum('functionsClaimedInline')} / ${sum('compiledUnits')} `
  + `| ${pct(sum('functionsEmitted') + sum('functionsClaimedInline'), sum('compiledUnits'))} |`);
L(`| 7 — values emitted twice | ${sum('duplicatedValues')} | — |`);
L(`| 9 — unresolved constant-pool entries | ${mergeMetric('m9_unresolvedConstants', 'value')} | — |`);
L(`| 10 — \`unstructured\` regions | ${sum('unstructuredRegions')} | — |`);
L('');
L(`handler ranges by prediction: ${tbl(merge('triesByPrediction'))} became a \`try\`, `
  + `out of ${tbl(mergeBytecode(rows, 'handlerRangesByPrediction'))}`);
L('');
L('## what the join had to decide');
L('');
L('| | count |');
L('|---|---:|');
L(`| loop regions by form | ${tbl(merge('loopForms'))} |`);
L(`| loop idiom annotations T8 attached | ${tbl(merge('loopIdioms'))} |`);
L(`| \`for-in\` heads rebuilt from the annotation | ${sum('forInRebuilt')} |`);
L(`| \`for-in\` annotations that could not be rebuilt | ${sum('forInNotRebuilt')} |`);
L(`| \`try\` regions carrying a recognised \`finally\` token dispatch | ${sum('finallyShapes')} ${tbl(merge('finallyShapeKinds'))} |`);
L(`| \`switch\` regions by form | ${tbl(merge('switchForms'))} |`);
L(`| jump-table guard blocks emitted as \`if\` (T8 says T9 may drop them) | ${sum('switchGuardBlocks')} |`);
L(`| \`if\` / \`break\` / \`continue\` / label | ${sum('ifs')} / ${sum('breaks')} / ${sum('continues')} / ${sum('labels')} |`);
L(`| loops whose test chain carried statements T8 claimed were absent | ${sum('loopTestChainsMaterialised')} (${sum('loopTestChainStatements')} statements) |`);
L(`| \`catch\` bindings reconstructed from an unstored context slot | ${sum('catchContextBindings')} (${sum('catchContextBindingsAmbiguous')} ambiguous, left alone) |`);
L(`| statements of a \`removed\` block with nowhere to go | ${sum('droppedStatementsOnRemovedBlocks')} in ${sum('droppedStatementBlocks')} block(s) |`);
L(`| ... by \`removed\` kind | ${tbl(merge('droppedByRemovedKind'))} |`);
L(`| ... by statement tag | ${tbl(merge('droppedByStatementTag'))} |`);
L(`| script \`return\` turned into the completion value | ${sum('topLevelReturns')} |`);
L(`| locals renamed away from a global/param/slot spelling | ${sum('localsRenamed')} |`);
L(`| outer context slots declared locally (no ancestor declared them) | ${sum('outerSlotDeclaredLocally')} |`);
L(`| declarations emitted | ${sum('declarations')} |`);
L(`| names read but never written (reported, not an invariant) | ${sum('namesReadButNeverWritten')} of ${sum('namesDeclared')} declared |`);
L(`| unresolved context-slot placeholders used | ${sum('unresolvedNames')} |`);
L(`| global reads | ${sum('globalReads')} |`);
L(`| \`{r:block}\` leaves T7 produced no statement for | ${sum('blocksWithoutStatements')} |`);
L(`| statement order monotone with the source position | ${sumIn('monotonicity', 'monotone')} / ${sumIn('monotonicity', 'functions')} functions, ${sumIn('monotonicity', 'inversions')} inversions |`);
L(`| unit tree: parent links from the source range / confirmed by \`parentSfiId\` / disagreeing | ${sumIn('unitTree', 'byRange')} / ${sumIn('unitTree', 'byParentSfiId')} / ${sumIn('unitTree', 'disagreed')} |`);
L('');
L('## holes, by reason');
L('');
L(tbl(merge('holesByWhy')) || '(none)');
L('');
L(`by position: ${tbl(merge('holesByKind'))}`);
L('');
if (sum('invariantViolations')) {
  L('## invariant violations');
  L('');
  L(tbl(merge('byInvariant')));
  L('');
  L('```json');
  for (const r of rows) {
    for (const s of r.violationSamples ?? []) L(`${r.file}: ${JSON.stringify(s).slice(0, 300)}`);
  }
  L('```');
  L('');
}
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  L('## files that produced no result');
  L('');
  for (const r of failed.slice(0, 40)) L(`* \`${r.file}\` ${r.error ?? ''}`);
  L('');
}
L('## the slowest files');
L('');
for (const r of [...rows].sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0)).slice(0, 10)) {
  L(`* \`${r.file}\` ${((r.inputBytes ?? 0) / 1024).toFixed(0)} KB -> ${((r.codeBytes ?? 0) / 1024).toFixed(0)} KB, `
    + `${r.elapsedMs} ms, ${r.compiledUnits} functions`);
}

function mergeBytecode(all, key) {
  const o = {};
  for (const r of all) for (const [k, v] of Object.entries(r.bytecode?.[key] ?? {})) o[k] = (o[k] ?? 0) + v;
  return o;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), profile: PROFILE, corpus: CORPUS,
  selected: files.length, withResult: rows.length, ok: ok.length,
  totals: {
    compiledUnits: sum('compiledUnits'),
    functionsEmitted: sum('functionsEmitted') + sum('functionsClaimedInline'),
    invariantViolations: sum('invariantViolations'),
    ctxIdentifiers: sum('ctxIdentifiers'),
    duplicatedValues: sum('duplicatedValues'),
    holes: sum('holes'), holesByWhy: merge('holesByWhy'),
    unstructuredRegions: sum('unstructuredRegions'),
    unstructuredBlocks: sum('unstructuredBlocks'),
    childMs, inputBytes: sum('inputBytes'), codeBytes: sum('codeBytes'),
    loops: sum('loops'), tries: sum('tries'), switches: sum('switches'),
    backEdges: sumIn('bytecode', 'backEdges'),
    handlerRanges: sumIn('bytecode', 'handlerRanges'),
    switchDispatchOpcodes: sumIn('bytecode', 'switchDispatchOpcodes'),
    namesReadButNeverWritten: sum('namesReadButNeverWritten'),
    namesDeclared: sum('namesDeclared'),
    droppedStatementsOnRemovedBlocks: sum('droppedStatementsOnRemovedBlocks'),
    forInRebuilt: sum('forInRebuilt'),
    catchContextBindings: sum('catchContextBindings'),
    monotone: sumIn('monotonicity', 'monotone'),
    monotonicityFunctions: sumIn('monotonicity', 'functions'),
    inversions: sumIn('monotonicity', 'inversions'),
  },
  files: rows.map((r) => ({
    file: r.file, ok: r.ok, inputBytes: r.inputBytes, codeBytes: r.codeBytes,
    compiledUnits: r.compiledUnits, functionsEmitted: r.functionsEmitted,
    invariantViolations: r.invariantViolations, holes: r.holes,
    unstructuredRegions: r.unstructuredRegions, ctxIdentifiers: r.ctxIdentifiers,
    elapsedMs: r.elapsedMs, error: r.error ?? null,
  })),
}, null, 1));
process.stderr.write(`wrote ${OUT} and ${OUT.replace(/\.md$/, '.json')}\n`);
