// tools/verify/o1_corpus.mjs
//
// O1 on the real corpus: ONE CHILD PROCESS PER FILE, a capped child heap,
// one result JSON per file, nothing through a pipe.
//
//   node tools/verify/o1_corpus.mjs [--jobs 2] [--max-files N] [--stride N]
//        [--force] [--corpus extracted_jsc] [--profile profiles/14.4.258.16]
//        [--work scratch/o1corpus/results] [--scratch scratch/o1corpus/work]
//        [--timeout 1800] [--child-heap 1400] [--minter <electron.exe>]
//        [--out docs/O1_CORPUS.md] [--merge-only]
//
// Flag spelling is the one the other three scanners use, deliberately:
// `--timeout` is in SECONDS and the heap flag is `--child-heap`. Getting that
// wrong has already cost a whole cloud run.
//
// Resumable: a file whose result JSON exists is skipped; `--force` redoes
// everything. `--merge-only` reports over whatever results exist and takes its
// FILE LIST FROM THE RESULTS, not from the corpus, so a sharded cloud run can
// be merged in a job that never staged the 104 MiB of input.
//
// A sharded run (the private corpus repo's .github/workflows/scan.yml takes a
// `layer` and shards by bytes with tools/ci/shard_corpus.mjs):
//
//   node tools/ci/shard_corpus.mjs --corpus extracted_jsc --shards 12 \
//        --index $I --out /tmp/shard
//   node tools/verify/o1_corpus.mjs --corpus /tmp/shard --jobs 2 \
//        --timeout 1800 --child-heap 1400 --work work/o1
//   # then, in the merge job, with every shard's work/ downloaded into one:
//   node tools/verify/o1_corpus.mjs --merge-only --work work/o1 --out docs/O1.md
//
// Nothing from the corpus is executed; see src/verify/o1_corpus.mjs for the
// policy and the asserts that enforce it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { findElectron } from '../../src/verify/mint.mjs';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(`--${n}`);

const CORPUS = argOf('corpus', 'extracted_jsc');
const PROFILE = argOf('profile', 'profiles/14.4.258.16');
const MAX_FILES = Number(argOf('max-files', '0')) || Infinity;
const STRIDE = Math.max(1, Number(argOf('stride', '1')) || 1);
const JOBS = Number(argOf('jobs', String(Math.max(1, Math.min(2, os.cpus().length - 1)))));
const HEAP = Number(argOf('child-heap', '1400'));
const TIMEOUT_MS = Number(argOf('timeout', '1800')) * 1000;
const WORK = argOf('work', 'scratch/o1corpus/results');
const SCRATCH = argOf('scratch', 'scratch/o1corpus/work');
const OUT = argOf('out', 'scratch/o1corpus/O1_CORPUS.md');
const MINTER = argOf('minter', findElectron() ?? '');

fs.mkdirSync(WORK, { recursive: true });
const resultPath = (f) => path.join(WORK, `${f}.json`);

const files = flag('merge-only')
  ? (fs.existsSync(WORK)
    ? fs.readdirSync(WORK).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    : [])
  : fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort()
    .filter((_, i) => i % STRIDE === 0).slice(0, MAX_FILES);

if (flag('force')) for (const f of files) fs.rmSync(resultPath(f), { force: true });
const pending = flag('merge-only') ? [] : files.filter((f) => !fs.existsSync(resultPath(f)));

if (!flag('merge-only')) {
  if (!MINTER || !fs.existsSync(MINTER)) {
    process.stderr.write(
      'no minter: stream B must be compiled by the corpus\'s own V8 (14.4.258.16 = Electron 40).\n'
      + '  node tools/oracle/fetch_electron.mjs 40.0.0 win32-x64\n'
      + '  then extract electron.exe from .v8bin-cache/electron-v40.0.0-win32-x64.zip into that directory.\n'
      + 'Minting with the local node (V8 14.6) would compare two V8 versions and blame the difference on the decompiler.\n');
    process.exit(2);
  }
  process.stderr.write(`O1 corpus scan: ${files.length} files, ${pending.length} to do, ${JOBS} job(s), `
    + `${HEAP} MB child heap, ${TIMEOUT_MS / 1000} s timeout, minter ${path.basename(MINTER)}\n`);
}

const timedOut = [];
const crashed = [];
let done = files.length - pending.length;
const t0 = Date.now();

function runOne(f) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${HEAP}`,
      'tools/verify/o1_corpus_worker.mjs',
      path.join(CORPUS, f), PROFILE, resultPath(f), SCRATCH, MINTER,
      // the worker gives its decompile children a slightly shorter leash than
      // its own, so a slow decompile is reported as `decompile-timeout`
      // against that file rather than killing the whole row
      String(Math.max(60, Math.floor(TIMEOUT_MS / 1000) - 120)), String(HEAP),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString().slice(0, 4000); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { child.kill('SIGKILL'); timedOut.push(f); }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !timedOut.includes(f)) crashed.push({ file: f, code, stderr: err.slice(0, 600) });
      done++;
      if (done % 10 === 0 || done === files.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        process.stderr.write(`  ${done}/${files.length} files (${rate.toFixed(3)}/s)\n`);
      }
      resolve();
    });
  });
}

const queue = [...pending];
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
  while (queue.length) await runOne(queue.shift());
}));

// ------------------------------------------------------------------- merge
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const T = {
  files: 0, filesNoResult: 0,
  aFunctions: 0, bFunctions: 0, aInstructions: 0, bInstructions: 0,
  aFunctionsCompared: 0, aInstructionsCompared: 0,
  pairedFunctions: 0, exactFunctions: 0, exactModuloClosureNames: 0,
  leftOnly: 0, rightOnly: 0, undiffedPairs: 0, emitNamesKnown: 0,
  inputBytes: 0, code1Bytes: 0, emittedFunctions: 0, holes: 0,
  byStatus: {}, byPairingMode: {}, pairsByMode: {}, exactByMode: {},
  simByMode: {}, histogram: Array.from({ length: 11 }, () => 0),
  erasureA: {}, erasureB: {}, decodeWarningsA: {}, decodeWarningsB: {},
  literalA: {}, literalB: {}, literalRefusedA: {}, literalRefusedB: {},
  o2Reached: 0, o2Stable: 0, o2Unstable: 0, o2NotReached: 0,
  simSum: 0, simN: 0, isimSum: 0, isimN: 0,
  flagHashDiffers: 0,
};
const causes = new Map();
const shapes = {};
const noResult = [];
const badStatus = [];
// a plain object, because `bump` sets properties -- a Map here silently
// produced an empty table
const o2Causes = {};
const o2Samples = [];
const worst = [];
let childWall = 0, childCpu = 0, maxRss = 0;

for (const f of files) {
  const p = resultPath(f);
  if (!fs.existsSync(p)) { T.filesNoResult++; noResult.push({ file: f, why: 'no result (timeout or crash)' }); continue; }
  let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { T.filesNoResult++; noResult.push({ file: f, why: 'unparsable result' }); continue; }
  T.files++;
  childWall += r.wallMs ?? 0;
  childCpu += r.cpuMs ?? 0;
  if ((r.rssPeakMB ?? 0) > maxRss) maxRss = r.rssPeakMB;
  bump(T.byStatus, r.status ?? 'unknown');
  T.inputBytes += r.inputBytes ?? 0;
  if (r.flagHashDiffers) T.flagHashDiffers++;
  for (const k of ['aFunctions', 'bFunctions', 'aInstructions', 'bInstructions', 'pairedFunctions',
    'aFunctionsCompared', 'aInstructionsCompared',
    'exactFunctions', 'exactModuloClosureNames', 'leftOnly', 'rightOnly', 'undiffedPairs',
    'emitNamesKnown', 'code1Bytes', 'emittedFunctions', 'holes']) {
    T[k] += r[k] ?? 0;
  }
  for (const [k, v] of Object.entries(r.erasureA ?? {})) bump(T.erasureA, k, v);
  for (const [k, v] of Object.entries(r.erasureB ?? {})) bump(T.erasureB, k, v);
  for (const side of ['A', 'B']) {
    const lit = r[`literal${side}`] ?? {};
    for (const [k, v] of Object.entries(lit)) {
      if (k === 'refused') { for (const [rk, rv] of Object.entries(v ?? {})) bump(T[`literalRefused${side}`], rk, rv); }
      else bump(T[`literal${side}`], k, v);
    }
  }
  for (const [k, v] of Object.entries(r.aDecodeWarnings ?? {})) bump(T.decodeWarningsA, k, v);
  for (const [k, v] of Object.entries(r.bDecodeWarnings ?? {})) bump(T.decodeWarningsB, k, v);
  if (r.pairingMode) bump(T.byPairingMode, r.pairingMode);
  for (const [k, v] of Object.entries(r.byPairingMode ?? {})) bump(T.pairsByMode, k, v);
  for (const [k, v] of Object.entries(r.exactByMode ?? {})) bump(T.exactByMode, k, v);
  for (const [k, v] of Object.entries(r.simByMode ?? {})) {
    const e = T.simByMode[k] ?? (T.simByMode[k] = { n: 0, exact: 0, sum: 0 });
    e.n += v.n ?? 0; e.exact += v.exact ?? 0; e.sum += (v.mean ?? 0) * (v.n ?? 0);
  }
  (r.histogram ?? []).forEach((v, i) => { T.histogram[i] += v; });
  if (r.meanOpcodeSimilarity != null && r.pairedFunctions) { T.simSum += r.meanOpcodeSimilarity * r.pairedFunctions; T.simN += r.pairedFunctions; }
  if (r.meanInstructionSimilarity != null && r.pairedFunctions) { T.isimSum += r.meanInstructionSimilarity * r.pairedFunctions; T.isimN += r.pairedFunctions; }
  if (!['ok', 'match'].includes(r.status) && badStatus.length < 40) {
    badStatus.push({ file: r.file, status: r.status, error: String(r.error ?? '').slice(0, 260) });
  }
  for (const c of r.causes ?? []) {
    let e = causes.get(c.family);
    if (!e) { e = { functions: 0, hunks: 0, instructions: 0, files: 0, details: new Map(), repro: null }; causes.set(c.family, e); }
    e.functions += c.functions; e.hunks += c.hunks; e.instructions += c.instructions; e.files++;
    for (const [d, n, fns] of c.details ?? []) {
      const cur = e.details.get(d) ?? { hunks: 0, functions: 0 };
      cur.hunks += n; cur.functions += fns ?? 0;
      e.details.set(d, cur);
      bump(shapes, `${c.family} | ${d}`, fns ?? 0);
    }
    if (c.repro && (!e.repro || c.repro.size < e.repro.size)) e.repro = { ...c.repro, file: r.file };
  }
  const o2 = r.o2 ?? {};
  if (!o2.reached) { T.o2NotReached++; bump(o2Causes, `not reached: ${o2.stage ?? 'unknown'}`); }
  else {
    T.o2Reached++;
    if (o2.stable) T.o2Stable++;
    else {
      T.o2Unstable++;
      const fd = o2.firstDifference ?? {};
      // the cause key is the first token of the inserted/removed text, which is
      // what makes a hundred files collapse to a handful of reasons
      const key = o2Key(fd);
      bump(o2Causes, key);
      if (o2Samples.length < 12) o2Samples.push({ file: r.file, byteDelta: o2.byteDelta, functionsDelta: o2.functionsDelta, ...fd });
    }
  }
  for (const w of r.worst ?? []) worst.push({ file: r.file, ...w });
}

/** Collapse an O2 first-difference into a reason. */
function o2Key(fd) {
  if (fd.note) return `one output is a prefix of the other`;
  const right = String(fd.right ?? '');
  const left = String(fd.left ?? '');
  const m = /\/\*\s*([A-Za-z][A-Za-z ]{2,40}?)[\s(]/.exec(right) ?? /\/\*\s*([A-Za-z][A-Za-z ]{2,40}?)[\s(]/.exec(left);
  if (m) return `annotation differs: /* ${m[1].trim()} … */`;
  if (/\bfunction\b/.test(right) !== /\bfunction\b/.test(left)) return 'a function appears or disappears';
  return `text differs at offset ${fd.offset <= 0 ? 0 : '>0'}`;
}

worst.sort((a, b) => a.sim - b.sim);
const causeRows = [...causes.entries()]
  .map(([family, e]) => ({
    family, ...e,
    details: [...e.details.entries()].sort((a, b) => b[1].functions - a[1].functions || b[1].hunks - a[1].hunks),
  }))
  .sort((a, b) => b.functions - a.functions);

// ------------------------------------------------------------------ report
const wall = (Date.now() - t0) / 1000;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(4)}%` : 'n/a');
const L = [];
const say = (s = '') => L.push(s);
const row = (k, v) => say(`| ${k} | ${v} |`);
const table = (name, obj, total) => {
  const e = obj instanceof Map ? [...obj.entries()] : Object.entries(obj);
  e.sort((a, b) => b[1] - a[1]);
  say(`### ${name}`); say();
  if (!e.length) { say('(none)'); say(); return; }
  say(total === undefined ? '| key | count |' : '| key | count | share |');
  say(total === undefined ? '|---|---:|' : '|---|---:|---:|');
  for (const [k, v] of e) say(total === undefined ? `| \`${k}\` | ${v} |` : `| \`${k}\` | ${v} | ${pct(v, total)} |`);
  say();
};

say('# O1 on the real corpus — raw scan output');
say();
say('Generated by `tools/verify/o1_corpus.mjs`. The argued version of these numbers is `docs/O1.md`.');
say();
say(`Corpus \`${CORPUS}\`, profile \`${PROFILE}\`, minter \`${path.basename(MINTER || '(merge-only)')}\`, `
  + `${JOBS} job(s), ${HEAP} MB child heap, ${TIMEOUT_MS / 1000} s timeout.`);
say(`Wall ${wall.toFixed(0)} s; children ${(childWall / 1000).toFixed(0)} s wall / ${(childCpu / 1000).toFixed(0)} s CPU, peak child RSS ${maxRss} MB.`);
say();
say('## Coverage');
say(); say('| metric | value |'); say('|---|---:|');
row('files attempted', files.length);
row('files with a result', T.files);
row('files with no result (timeout or crash)', T.filesNoResult);
row('input bytes read', T.inputBytes);
row('functions in stream A (corpus, decoded)', T.aFunctions);
row('&nbsp;&nbsp;of those, in a file that reached the comparison', `${T.aFunctionsCompared} = ${pct(T.aFunctionsCompared, T.aFunctions)}`);
row('functions in stream B (our output, recompiled)', T.bFunctions);
row('instructions in stream A', T.aInstructions);
row('&nbsp;&nbsp;of those, in a file that reached the comparison', T.aInstructionsCompared);
row('instructions in stream B', T.bInstructions);
row('functions our emitter named (the `sfi` pairing key)', T.emitNamesKnown);
row('holes our emitter marked in the text it produced', T.holes);
row('files whose cache flag hash differs from ours (`--no-lazy`)', `${T.flagHashDiffers} / ${T.files}`);
say();
table('Status', T.byStatus, T.files);

say('## The number');
say(); say('| metric | value |'); say('|---|---:|');
row('**paired functions**', T.pairedFunctions);
row('**exactly equal (the only number that means "equivalent")**', `${T.exactFunctions} = ${pct(T.exactFunctions, T.pairedFunctions)}`);
row('exactly equal once invented function names are erased', `${T.exactModuloClosureNames} = ${pct(T.exactModuloClosureNames, T.pairedFunctions)}`);
row('mean opcode similarity (per function)', T.simN ? (T.simSum / T.simN).toFixed(6) : 'n/a');
row('mean whole-instruction similarity (per function)', T.isimN ? (T.isimSum / T.isimN).toFixed(6) : 'n/a');
row('unpaired on the A side (we emitted no counterpart)', `${T.leftOnly} = ${pct(T.leftOnly, T.aFunctionsCompared)}`);
row('unpaired on the B side (we emitted a function V8 did not)', `${T.rightOnly} = ${pct(T.rightOnly, T.bFunctions)}`);
row('pairs too large to diff (classification skipped)', T.undiffedPairs);
say();
say('### Match-rate distribution (per-function opcode similarity)');
say(); say('| bucket | functions | share |'); say('|---|---:|---:|');
for (let i = 0; i < 11; i++) {
  const lo = (i / 10).toFixed(1);
  const label = i === 10 ? '1.0 (exact opcode sequence)' : `[${lo}, ${((i + 1) / 10).toFixed(1)})`;
  say(`| ${label} | ${T.histogram[i]} | ${pct(T.histogram[i], T.pairedFunctions)} |`);
}
say();
say('### By pairing mode');
say();
say('`sfi` is identity by construction: our emitter recorded the name it gave that `sfiId`, and stream B is');
say('the compilation of that text. `name` is a genuine name match, `greedy` a similarity guess, `positional`');
say('nothing but order — a number carried by `positional` means much less.');
say();
say('| mode | pairs | exact | exact share | mean opcode similarity |'); say('|---|---:|---:|---:|---:|');
for (const [k, v] of Object.entries(T.simByMode).sort((a, b) => b[1].n - a[1].n)) {
  say(`| \`${k}\` | ${v.n} | ${v.exact} | ${pct(v.exact, v.n)} | ${v.n ? (v.sum / v.n).toFixed(6) : 'n/a'} |`);
}
say();
table('Whole-file pairing mode', T.byPairingMode, T.files);

say('## Ranked causes of non-equivalence');
say();
say('Ranked by **number of functions affected**. One minimal repro each, as the two normalised streams.');
say();
say('| # | family | functions | hunks | instructions | files |'); say('|---:|---|---:|---:|---:|---:|');
causeRows.forEach((c, i) => say(`| ${i + 1} | \`${c.family}\` | ${c.functions} | ${c.hunks} | ${c.instructions} | ${c.files} |`));
say();
say('### The same thing ranked by concrete shape rather than family');
say();
say('The work queue. `family | shape`, ranked by functions affected.');
say();
say('| # | family \\| shape | functions |'); say('|---:|---|---:|');
Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 40)
  .forEach(([k, v], i) => say(`| ${i + 1} | \`${k.replace(/\|/g, '\\|')}\` | ${v} |`));
say();
for (const c of causeRows) {
  say(`### \`${c.family}\` — ${c.functions} functions`);
  say();
  say('| shape | functions | hunks |'); say('|---|---:|---:|');
  for (const [d, v] of c.details.slice(0, 10)) say(`| \`${d.replace(/\|/g, '\\|')}\` | ${v.functions} | ${v.hunks} |`);
  say();
  if (c.repro) {
    const r = c.repro;
    say(`Minimal repro: \`${r.file}\` function \`${r.name}\` (sfi ${r.sfiId}, paired by \`${r.how}\`), `
      + `${r.instructionCounts?.[0]} vs ${r.instructionCounts?.[1]} instructions, `
      + `${r.whole ? 'whole function' : `window around instruction ${r.at}`}.`);
    say();
    say('```diff');
    say(`--- stream A: ${r.file} as compiled by QQ's V8`);
    say(`+++ stream B: our output, recompiled`);
    const n = Math.max(r.left.length, r.right.length);
    for (let i = 0; i < n; i++) {
      const a = r.left[i], b = r.right[i];
      if (a === b) say(`  ${a}`);
      else {
        if (a !== undefined) say(`- ${a}`);
        if (b !== undefined) say(`+ ${b}`);
      }
    }
    say('```');
    say();
  }
}

say('## O2 — the round-trip fixpoint');
say();
say('`decompile → compile-only → decompile` must be byte-identical. Needs no execution, so it runs wherever O1 does.');
say();
say('| metric | value |'); say('|---|---:|');
row('files where both rounds completed', T.o2Reached);
row('**byte-identical (fixpoint)**', `${T.o2Stable} = ${pct(T.o2Stable, T.o2Reached)}`);
row('unstable', T.o2Unstable);
row('second round did not complete', T.o2NotReached);
say();
table('O2 first-difference reason', o2Causes, T.o2Reached + T.o2NotReached);
if (o2Samples.length) {
  say('### O2 unstable samples');
  say();
  for (const s of o2Samples) {
    say(`* \`${s.file}\` — offset ${s.offset}${s.line ? ` (line ${s.line})` : ''}, `
      + `${s.byteDelta > 0 ? '+' : ''}${s.byteDelta ?? 0} bytes, ${s.functionsDelta ?? 0} functions`);
    say('  ```diff');
    say(`  - ${String(s.left ?? '').replace(/\n/g, '\\n').slice(0, 160)}`);
    say(`  + ${String(s.right ?? '').replace(/\n/g, '\\n').slice(0, 160)}`);
    say('  ```');
  }
  say();
}

say('## What the normalisation erased');
say();
say('Totals over stream A; stream B in brackets. See `src/verify/normalize.mjs` for the per-rule argument');
say('and `docs/O1.md` for why each is defensible here.');
say();
say('| erased field | stream A | stream B | per instruction (A) |'); say('|---|---:|---:|---:|');
const EA = T.erasureA, EB = T.erasureB;
const ins = EA.instructions || 1;
for (const k of ['registerClass', 'regRange', 'feedbackSlot', 'constantIndex', 'jumpDelta', 'scalePrefix', 'sourcePosition', 'allocationIds']) {
  say(`| \`${k}\` | ${EA[k] ?? 0} | ${EB[k] ?? 0} | ${((EA[k] ?? 0) / ins).toFixed(3)} |`);
}
say();
say('| kept operand field | stream A | stream B |'); say('|---|---:|---:|');
for (const k of ['parameterKept', 'specialRegKept', 'immKept', 'flagKept', 'nameKept', 'otherOperand']) {
  say(`| \`${k}\` | ${EA[k] ?? 0} | ${EB[k] ?? 0} |`);
}
say();
say('| summary | stream A | stream B |'); say('|---|---:|---:|');
say(`| instructions compared | ${EA.instructions ?? 0} | ${EB.instructions ?? 0} |`);
say(`| operand fields total | ${EA.operands ?? 0} | ${EB.operands ?? 0} |`);
say(`| **value erased** (presence compared, value not: feedback slots) | ${EA.valueErased ?? 0} | ${EB.valueErased ?? 0} |`);
say(`| **encoding erased** (value survives in another spelling) | ${EA.encodingErased ?? 0} | ${EB.encodingErased ?? 0} |`);
say(`| constants the engine left unresolved (\`K#n\`, untrustworthy) | ${EA.unresolvedConstant ?? 0} | ${EB.unresolvedConstant ?? 0} |`);
say();
say('### Literal element values: what is compared, and what is still not');
say();
say('Both streams are rendered with `toParsedForm(…, {literalValues: true})`, so an array or object');
say('literal is compared by its CONTENTS and not only by its length — the argument is in the header of');
say('`src/verify/o1_corpus.mjs`. The default renderer still prints V8\'s text, which is why');
say('`tools/disasm/oracle_agreement.mjs` is unaffected. Every case the rendering refuses is named below,');
say('and a refusal means two different literals of that shape still compare equal.');
say();
say('| | stream A | stream B |'); say('|---|---:|---:|');
const LA = T.literalA, LB = T.literalB;
for (const [k, label] of [
  ['constants', 'constant operands rendered'],
  ['deepened', '&nbsp;&nbsp;of those, carrying more than the default rendering would'],
  ['functions', 'functions rendered'],
  ['functionsDeepened', '&nbsp;&nbsp;with at least one deepened constant'],
  ['functionsRefused', '&nbsp;&nbsp;with at least one refusal'],
  ['hashed', 'containers compared by sha256 of their contents (above the inline cap)'],
  ['idsOmitted', 'container-internal object ids omitted (`#*`, see `renderConstantDeep`)'],
]) {
  say(`| ${label} | ${LA[k] ?? 0} | ${LB[k] ?? 0} |`);
}
say();
table('Literal contents REFUSED, by reason, stream A', T.literalRefusedA);
table('Literal contents REFUSED, by reason, stream B', T.literalRefusedB);
table('Decoder warnings, stream A', T.decodeWarningsA);
table('Decoder warnings, stream B', T.decodeWarningsB);

if (badStatus.length) {
  say('## Files that produced no comparison');
  say(); say('| file | status | error |'); say('|---|---|---|');
  for (const b of badStatus) say(`| \`${b.file}\` | \`${b.status}\` | ${b.error.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  say();
}
if (worst.length) {
  say('## Worst-scoring paired functions');
  say(); say('| file | function | mode | similarity | A:B | first divergence |'); say('|---|---|---|---:|---|---|');
  for (const w of worst.slice(0, 20)) {
    const fd = w.firstDivergence;
    say(`| \`${w.file}\` | \`${String(w.name).slice(0, 40)}\` | ${w.how} | ${w.sim} | ${w.counts?.join(':')} | `
      + `${fd ? `\`${String(fd.left).slice(0, 48)}\` vs \`${String(fd.right).slice(0, 48)}\`` : ''} |`);
  }
  say();
}
if (noResult.length) {
  say('## Files with no usable result');
  say();
  for (const f of noResult.slice(0, 40)) say(`* \`${f.file}\` — ${f.why}`);
  say();
}
if (timedOut.length) { say(`Timed out: ${timedOut.map((f) => '`' + f + '`').join(', ')}`); say(); }
if (crashed.length) {
  say('## Crashed children');
  say();
  for (const c of crashed.slice(0, 10)) say(`* \`${c.file}\` exit ${c.code}: ${c.stderr.split('\n')[0]}`);
  say();
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n') + '\n');
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
  corpus: CORPUS, profile: PROFILE, minter: path.basename(MINTER || ''),
  filesAttempted: files.length, wallSeconds: wall,
  childWallSeconds: childWall / 1000, childCpuSeconds: childCpu / 1000,
  totals: T,
  causes: causeRows.map((c) => ({ ...c, details: c.details.slice(0, 20) })),
  o2Causes, o2Samples,
  worst: worst.slice(0, 40), badStatus, noResult, timedOut, crashed,
}, null, 1));
process.stderr.write(`wrote ${OUT}\n`);
