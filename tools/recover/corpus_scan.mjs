// tools/recover/corpus_scan.mjs
//
// Run src/recover over the whole corpus: ONE CHILD PROCESS PER FILE, a capped
// child heap, results to files, nothing through a pipe.
//
// Why a child per file (same reasoning as tools/ir/corpus_scan.mjs, and the
// recovered form is larger again than the IR): the host has 4 GB and about two
// cores, a long-lived process accumulates fragmentation it never returns, a
// forked worker gives the memory back on exit and lets a pathological file be
// killed on a timeout instead of taking the run with it. The run is resumable:
// a file whose result JSON exists is skipped, `--force` re-does everything.
//
//   node tools/recover/corpus_scan.mjs [--jobs 2] [--max-files N] [--force]
//        [--corpus extracted_jsc] [--profile profiles/14.4.258.16]
//        [--work scratch/t7/corpus] [--out docs/... or scratch/t7/RECOVER_CORPUS.md]
//
// Nothing from the corpus is executed. This tool may import anything
// (ARCHITECTURE.md 11.0 only constrains src/).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(`--${n}`);

const CORPUS = argOf('corpus', 'extracted_jsc');
const PROFILE = argOf('profile', 'profiles/14.4.258.16');
const MAX_FILES = Number(argOf('max-files', '0')) || Infinity;
const JOBS = Number(argOf('jobs', String(Math.max(1, Math.min(2, os.cpus().length - 1)))));
const HEAP = Number(argOf('child-heap', '1400'));
// Per-file wall timeout. Generous on purpose: the 10 MB `r_8878.jsc` needs
// ~15 minutes of WALL on a host whose two cores are shared, while costing a
// fraction of that in CPU, and a timeout there would leave a hole in the one
// number the acceptance line is about.
const TIMEOUT_MS = Number(argOf('timeout', '2700')) * 1000;
const WORK = argOf('work', 'scratch/t7/corpus');
const OUT = argOf('out', 'scratch/t7/RECOVER_CORPUS.md');

fs.mkdirSync(WORK, { recursive: true });
// `--stride N` takes every Nth file, which gives a sample spread across the
// corpus rather than the alphabetical head: the head is all `b_*background`
// extension service workers and is not representative.
const STRIDE = Math.max(1, Number(argOf('stride', '1')) || 1);
// In `--merge-only` the file list comes from the RESULTS, not from the corpus:
// a sharded CI run merges in a job that never staged the corpus at all
// (.github/workflows/corpus-scan.yml), and requiring the inputs there would
// mean downloading 104 MiB to read a directory listing.
const files = flag('merge-only')
  ? (fs.existsSync(WORK) ? fs.readdirSync(WORK).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort() : [])
  : fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort()
    .filter((_, i) => i % STRIDE === 0).slice(0, MAX_FILES);
const resultPath = (f) => path.join(WORK, `${f}.json`);
if (flag('force')) for (const f of files) fs.rmSync(resultPath(f), { force: true });

// `--merge-only` reports whatever results already exist without running
// anything. Two uses: watching a multi-hour run while it is still going, and
// collecting a sharded CI run (.github/workflows/corpus-scan.yml downloads
// every shard's work directory into one and reports over the union).
const pending = flag('merge-only') ? [] : files.filter((f) => !fs.existsSync(resultPath(f)));
process.stderr.write(`recover corpus scan: ${files.length} files, ${pending.length} to do, ${JOBS} job(s), ${HEAP} MB child heap\n`);

const timedOut = [];
const crashed = [];
let done = files.length - pending.length;
const t0 = Date.now();

function runOne(f) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${HEAP}`,
      'tools/recover/corpus_worker.mjs',
      path.join(CORPUS, f), PROFILE, resultPath(f),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString().slice(0, 4000); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { child.kill('SIGKILL'); timedOut.push(f); }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !timedOut.includes(f)) crashed.push({ file: f, code, stderr: err.slice(0, 1000) });
      done++;
      if (done % 25 === 0 || done === files.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        process.stderr.write(`  ${done}/${files.length} files (${rate.toFixed(2)}/s)\n`);
      }
      resolve();
    });
  });
}

const queue = [...pending];
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
  while (queue.length) await runOne(queue.shift());
}));

// ----------------------------------------------------------------- merge
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const SUM_KEYS = [
  'units', 'compiled', 'recovered', 'failed', 'functionsWithNoHoles',
  'singleBlock', 'singleBlockNoHoles', 'singleBlockHoles', 'holes',
  'holesInStmts', 'holesInExprs', 'holesInUnusedExprs', 'statements', 'exprs',
  'values', 'dead', 'movesDropped', 'inlined', 'materialised', 'duplicable',
  'blockedByMultipleUses', 'blockedByEffectOrder', 'blockedByDominance',
  'allocationsMaterialised', 'callsMaterialised', 'violations',
  'duplicatedValues', 'duplicatedAllocations', 'duplicatedEffectful',
  'ctxIdentifiers', 'undeclaredNames', 'slotOps', 'slotResolved',
  'unresolvedSlots', 'sanitisedNames', 'suspendGenerator', 'resumeGenerator',
  'switchOnGeneratorState',
  'awaitPatterns', 'yieldPatterns', 'yieldStarPatterns', 'handlerRanges',
  'asyncAwaitRanges', 'consumedHandlerRanges', 'consumedInstructions',
  'instructions',
];
const MAP_KEYS = [
  'byHoleWhy', 'byUnusedHoleWhy', 'byViolation', 'patternsByKind',
  'patternsByFamily', 'patternsByConfidence', 'namesByOrigin',
  'ctxSlotNamesByOrigin', 'declarationsByKind', 'warningKinds',
];
const T = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
for (const k of MAP_KEYS) T[k] = {};
T.files = 0; T.filesFailed = 0;
const readFailures = [];
const unitFailures = [];
const violationSamples = [];
const slowest = [];
let childMs = 0;
let childCpuMs = 0;

for (const f of files) {
  const p = resultPath(f);
  if (!fs.existsSync(p)) { T.filesFailed++; readFailures.push({ file: f, why: 'no result (timeout or crash)' }); continue; }
  let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { T.filesFailed++; readFailures.push({ file: f, why: 'unparsable result' }); continue; }
  if (!r.ok) { T.filesFailed++; readFailures.push({ file: f, why: r.error ?? 'not ok' }); continue; }
  T.files++;
  childMs += r.elapsedMs ?? 0;
  childCpuMs += r.cpuMs ?? 0;
  for (const k of SUM_KEYS) T[k] += r[k] ?? 0;
  for (const k of MAP_KEYS) for (const [kk, c] of Object.entries(r[k] ?? {})) bump(T[k], kk, c);
  for (const x of r.failures ?? []) if (unitFailures.length < 40) unitFailures.push({ file: f, ...x });
  for (const x of r.violationSamples ?? []) if (violationSamples.length < 40) violationSamples.push({ file: f, ...x });
  for (const x of r.slowest ?? []) slowest.push({ file: f, ...x });
}
slowest.sort((a, b) => b.ms - a.ms);

const wall = (Date.now() - t0) / 1000;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(4)}%` : 'n/a');
const L = [];
const say = (s = '') => L.push(s);
const row = (k, v) => say(`| ${k} | ${v} |`);
const table = (name, obj, total) => {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  say(`### ${name}`); say();
  if (!e.length) { say('(none)'); say(); return; }
  say(total === undefined ? '| key | count |' : '| key | count | share |');
  say(total === undefined ? '|---|---:|' : '|---|---:|---:|');
  for (const [k, v] of e) say(total === undefined ? `| \`${k}\` | ${v} |` : `| \`${k}\` | ${v} | ${pct(v, total)} |`);
  say();
};

say('# `src/recover/` corpus scan');
say();
say(`Profile \`${PROFILE}\`, corpus \`${CORPUS}\`, ${JOBS} forked job(s), ${HEAP} MB child heap.`);
say(`Wall ${wall.toFixed(0)} s. Children: ${(childMs / 1000).toFixed(0)} s of wall, `
  + `${(childCpuMs / 1000).toFixed(0)} s of CPU (two cores shared with the IDE, so the `
  + 'CPU number is the one that describes this code).');
say();
say('## Totals');
say(); say('| metric | value |'); say('|---|---:|');
row('files read', `${T.files} / ${files.length}`);
row('files failed', T.filesFailed);
row('functions (SFI with bytecode)', T.compiled);
row('**functions recovered**', `${T.recovered} (${pct(T.recovered, T.compiled)})`);
row('functions whose recovery threw', T.failed);
row('instructions', T.instructions);
row('SSA values', T.values);
row('values dropped by DCE', `${T.dead} (${pct(T.dead, T.values)})`);
row('register copies dropped', T.movesDropped);
row('statements emitted', T.statements);
row('`exprs` entries', T.exprs);
row('instructions consumed by an idiom', `${T.consumedInstructions} (${pct(T.consumedInstructions, T.instructions)})`);
say();
say('## Holes (ARCHITECTURE.md 7: never a plausible placeholder)');
say(); say('| metric | value |'); say('|---|---:|');
row('**functions with 0 holes**', `${T.functionsWithNoHoles} / ${T.recovered} = ${pct(T.functionsWithNoHoles, T.recovered)}`);
row('holes in emitted statements', T.holesInStmts);
row('holes in an `exprs` entry T8 can name (a `Test` value)', T.holesInExprs);
row('holes in `exprs` entries nothing reads', T.holesInUnusedExprs);
row('**single-block functions**', `${T.singleBlock} / ${T.recovered} = ${pct(T.singleBlock, T.recovered)}`);
row('**single-block functions with 0 holes**', `${T.singleBlockNoHoles} / ${T.singleBlock} = ${pct(T.singleBlockNoHoles, T.singleBlock)}`);
row('holes inside single-block functions', T.singleBlockHoles);
say();
table('Holes by `why` (emitted)', T.byHoleWhy, T.holes);
table('Holes by `why` (tabulated but unread)', T.byUnusedHoleWhy);
say('## Inlining and duplication (metrics 6 and 7)');
say(); say('| metric | value |'); say('|---|---:|');
row('definitions inlined into their single use', T.inlined);
row('definitions materialised as a named temp', T.materialised);
row('values in `duplicable`', T.duplicable);
row('blocked: more than one use', T.blockedByMultipleUses);
row('blocked: an interfering effect in between', T.blockedByEffectOrder);
row('blocked: the definition does not dominate the use', T.blockedByDominance);
row('allocations (`definite`) given a name instead of being copied', T.allocationsMaterialised);
row('calls given a name instead of being copied', T.callsMaterialised);
row('**values whose defining expression is emitted twice** (metric 6, baseline 12.93%)', T.duplicatedValues);
row('**of those, allocations** (metric 7, baseline 50.27%)', T.duplicatedAllocations);
row('of those, side-effecting', T.duplicatedEffectful);
say();
say('## Naming (4.5, 10.3)');
say(); say('| metric | value |'); say('|---|---:|');
row('context-slot operations', T.slotOps);
row('**resolved to a real variable name** (10.3: 98.726%)', `${T.slotResolved} = ${pct(T.slotResolved, T.slotOps)}`);
row('context-slot locations with no name (the `/* ctx[d][i] */` placeholder)', T.unresolvedSlots);
row('ScopeInfo names that needed sanitising to be valid identifiers', T.sanitisedNames);
row('**occurrences of the identifier `ctx`** (11.3 invariant 5, baseline 1 710 336)', T.ctxIdentifiers);
row('free identifiers with no declaration behind them', T.undeclaredNames);
say();
table('Name origin distribution (every named value)',
  T.namesByOrigin, Object.values(T.namesByOrigin).reduce((a, b) => a + b, 0));
table('Name origin distribution (context-slot names only -- the 10.3 denominator)',
  T.ctxSlotNamesByOrigin, Object.values(T.ctxSlotNamesByOrigin).reduce((a, b) => a + b, 0));
table('Declarations by kind', T.declarationsByKind);
say('## Idiom patterns');
say(); say('| metric | value |'); say('|---|---:|');
row('total claims', Object.values(T.patternsByKind).reduce((a, b) => a + b, 0));
row('`confidence: exact`', T.patternsByConfidence.exact ?? 0);
row('`confidence: shape`', T.patternsByConfidence.shape ?? 0);
say();
table('Claims by kind', T.patternsByKind);
table('Claims by family', T.patternsByFamily);
say('## The three cross-checks ARCHITECTURE.md asks for');
say(); say('| check | expected | measured |'); say('|---|---:|---:|');
say(`| \`SuspendGenerator\` instructions | 15276 | ${T.suspendGenerator} |`);
say(`| \`ResumeGenerator\` instructions | 15276 | ${T.resumeGenerator} |`);
say(`| \`SwitchOnGeneratorState\` instructions (9.2) | 10068 | ${T.switchOnGeneratorState} |`);
say(`| \`await\` + \`yield\` + \`yield*\` claims | 15276 | ${T.awaitPatterns + T.yieldPatterns + T.yieldStarPatterns} |`);
say(`| &nbsp;&nbsp;of which \`await\` | | ${T.awaitPatterns} |`);
say(`| &nbsp;&nbsp;of which \`yield\` | | ${T.yieldPatterns} |`);
say(`| &nbsp;&nbsp;of which \`yield*\` | | ${T.yieldStarPatterns} |`);
say(`| handler ranges | 25189 | ${T.handlerRanges} |`);
say(`| ASYNC_AWAIT handler ranges | 13713 | ${T.asyncAwaitRanges} |`);
say(`| **in \`consumed.handlerRanges\`** | 13713 | ${T.consumedHandlerRanges} |`);
say();
say('## Verification');
say(); say('| metric | value |'); say('|---|---:|');
row('violations of T7\'s own invariants', T.violations);
say();
table('Violations by code', T.byViolation);
table('Warnings by code', T.warningKinds);

if (unitFailures.length) {
  say('## Functions whose recovery threw');
  say();
  for (const f of unitFailures.slice(0, 20)) say(`* \`${f.file}\` #${f.unit} ${f.name ?? ''} — ${f.error} (${f.at ?? ''})`);
  say();
}
if (violationSamples.length) {
  say('## Violation samples');
  say();
  for (const v of violationSamples.slice(0, 20)) say(`* \`${v.file}\` #${v.unit} ${JSON.stringify(v).slice(0, 220)}`);
  say();
}
if (readFailures.length) {
  say('## Files with no usable result');
  say();
  for (const f of readFailures.slice(0, 30)) say(`* \`${f.file}\` — ${f.why}`);
  say();
}
if (slowest.length) {
  say('## Slowest functions');
  say(); say('| file | unit | blocks | ms |'); say('|---|---|---:|---:|');
  for (const s of slowest.slice(0, 12)) say(`| \`${s.file}\` | ${s.unit} ${s.name ?? ''} | ${s.blocks} | ${s.ms} |`);
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
  profile: PROFILE, corpus: CORPUS, wallSeconds: wall,
  childWallSeconds: childMs / 1000, childCpuSeconds: childCpuMs / 1000,
  totals: T, timedOut, crashed, readFailures, unitFailures, violationSamples,
  slowest: slowest.slice(0, 30),
}, null, 1));
process.stderr.write(`wrote ${OUT}\n`);
