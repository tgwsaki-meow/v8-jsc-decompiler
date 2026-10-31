// tools/structure/corpus_scan.mjs
//
// Run src/structure over the whole corpus: ONE CHILD PROCESS PER FILE, a
// capped child heap, results to files, nothing through a pipe.
//
// Why a child per file (the same reasoning as tools/ir/corpus_scan.mjs): the
// host has 4 GB and about two cores, a long-lived process accumulates
// fragmentation it never gives back, a forked child returns its memory on exit
// and lets a pathological file be killed on a timeout instead of taking the
// whole run with it. The run is resumable -- a file whose result JSON already
// exists is skipped, `--force` re-does everything.
//
//   node tools/structure/corpus_scan.mjs [--jobs 2] [--max-files N] [--force]
//        [--corpus extracted_jsc] [--profile profiles/14.4.258.16]
//        [--work scratch/t8/corpus] [--out scratch/t8/STRUCTURE_CORPUS.md]
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
const TIMEOUT_MS = Number(argOf('timeout', '900')) * 1000;
const WORK = argOf('work', 'scratch/t8/corpus');
const OUT = argOf('out', 'scratch/t8/STRUCTURE_CORPUS.md');

fs.mkdirSync(WORK, { recursive: true });
// In `--merge-only` the file list comes from the RESULTS, not from the corpus:
// a sharded CI run merges in a job that never staged the corpus at all
// (.github/workflows/corpus-scan.yml), and requiring the inputs there would
// mean downloading 104 MiB to read a directory listing.
const files = flag('merge-only')
  ? (fs.existsSync(WORK) ? fs.readdirSync(WORK).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort() : [])
  : fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort().slice(0, MAX_FILES);
const resultPath = (f) => path.join(WORK, `${f}.json`);
if (flag('force')) for (const f of files) fs.rmSync(resultPath(f), { force: true });

// `--merge-only` reports whatever results already exist, which is what makes a
// multi-hour run observable while it is still going.
const pending = flag('merge-only') ? [] : files.filter((f) => !fs.existsSync(resultPath(f)));
process.stderr.write(`structure corpus scan: ${files.length} files, ${pending.length} to do, ${JOBS} job(s), ${HEAP} MB child heap\n`);

const timedOut = [];
const crashed = [];
let done = files.length - pending.length;
const t0 = Date.now();

function runOne(f) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${HEAP}`,
      'tools/structure/corpus_worker.mjs',
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
  'units', 'compiled', 'structured', 'failed',
  'blocks', 'reachableBlocks', 'placedBlocks', 'consumedBlocks', 'removedBlocks',
  'regions', 'coverageViolations', 'invariantViolations',
  'irBackEdges', 'irBackEdgesInLoop', 'jumpLoops', 'jumpLoopsInLoop',
  'loopsFound', 'loopRegions', 'testInHeader', 'testBelowHeader',
  'testChainBlocks', 'testChainNotConsumed', 'testBlockNotConsumed',
  'followAfterBody', 'multiExitLoops', 'multiLatchLoops', 'endlessLoops',
  'loopsWithoutFollow', 'forInLoops', 'forOfLoops', 'loopTestBlocks',
  'handlerRanges', 'tryRangesPlanned', 'tryRegions', 'skippedHandlerRanges',
  'asyncHandlerRanges', 'asyncHandlerBlocks', 'asyncTryViolations',
  'finallyShapes', 'normalCompletionTailBlocks',
  'dispatchers', 'dispatcherBlocksRemoved', 'dispatcherBlocksKept',
  'resumeEdgesRemoved', 'splices', 'unsplicedResumeEdges', 'suspendPoints',
  'irreducibleBefore', 'irreducibleAfter', 'functionsIrreducibleBefore',
  'functionsIrreducibleAfter',
  'jumpTables', 'generatorDispatchTables', 'compareChains', 'compareChainLinks',
  'guardBlocks',
  'unstructuredRegions', 'unstructuredBlocks', 'fellBack',
  'singleBlockFunctions', 'singleBlockTrivial',
  'ifs', 'seqs', 'breaks', 'continues', 'labels', 'labelledBreaks',
  'labelledContinues', 'followFromDomChildren', 'followFromIpdom', 'followNull',
  'warnings',
];
const MAP_KEYS = [
  'byInvariant', 'loopForms', 'loopPlanForms', 'rangesByPrediction',
  'tryByPrediction', 'missedByPrediction', 'skippedHandlerWhy',
  'finallyShapeKinds', 'switchRegions', 'unstructuredWhy', 'fellBackWhy',
  'warningKinds',
];
const T = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
for (const k of MAP_KEYS) T[k] = {};
T.files = 0; T.filesFailed = 0;
const readFailures = [];
const unitFailures = [];
const violationSamples = [];
const fellBackSamples = [];
const backEdgeMisses = [];
const slowest = [];
let childMs = 0;

for (const f of files) {
  const p = resultPath(f);
  if (flag('merge-only') && !fs.existsSync(p)) continue;
  if (!fs.existsSync(p)) { T.filesFailed++; readFailures.push({ file: f, why: 'no result (timeout or crash)' }); continue; }
  let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { T.filesFailed++; readFailures.push({ file: f, why: 'unparsable result' }); continue; }
  if (!r.ok) { T.filesFailed++; readFailures.push({ file: f, why: r.error ?? 'not ok' }); continue; }
  T.files++;
  childMs += r.elapsedMs ?? 0;
  for (const k of SUM_KEYS) T[k] += r[k] ?? 0;
  for (const k of MAP_KEYS) for (const [kk, c] of Object.entries(r[k] ?? {})) bump(T[k], kk, c);
  for (const x of r.failures ?? []) if (unitFailures.length < 40) unitFailures.push({ file: f, ...x });
  for (const x of r.violationSamples ?? []) if (violationSamples.length < 40) violationSamples.push({ file: f, ...x });
  for (const x of r.fellBackSamples ?? []) if (fellBackSamples.length < 40) fellBackSamples.push({ file: f, ...x });
  for (const x of r.backEdgeMisses ?? []) if (backEdgeMisses.length < 40) backEdgeMisses.push({ file: f, ...x });
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

const tryTotal = (T.tryByPrediction.CAUGHT ?? 0) + (T.tryByPrediction.UNCAUGHT ?? 0);
const realRanges = (T.rangesByPrediction.CAUGHT ?? 0) + (T.rangesByPrediction.UNCAUGHT ?? 0);

say('# `src/structure/` corpus scan');
say();
say(`Profile \`${PROFILE}\`, corpus \`${CORPUS}\`, ${JOBS} forked job(s), ${HEAP} MB child heap.`);
say(`Wall **${wall.toFixed(0)} s** (${(childMs / 1000).toFixed(0)} s of child CPU).`);
say();
say('## Totals');
say(); say('| metric | value |'); say('|---|---:|');
row('files read', `${T.files} / ${files.length}`);
row('files failed', T.filesFailed);
row('functions (SFI with bytecode)', T.compiled);
row('**functions structured**', `${T.structured} (${pct(T.structured, T.compiled)})`);
row('functions whose structuring threw', T.failed);
row('blocks', T.blocks);
row('reachable blocks', T.reachableBlocks);
row('region nodes built', T.regions);
say();
say('## ARCHITECTURE.md 11.3 invariant 1 — every reachable, non-removed block exactly once');
say(); say('| metric | value |'); say('|---|---:|');
row('**coverage violations**', T.coverageViolations);
row('violations of all of `src/structure/verify.mjs`', T.invariantViolations);
row('blocks placed as `{r:block}` leaves', T.placedBlocks);
row('blocks consumed by a construct (loop test chains)', T.consumedBlocks);
row('blocks in `removed`', T.removedBlocks);
say();
table('Violations by invariant', T.byInvariant);
say('## Metric 1 — back edges that became a loop statement');
say();
say('ARCHITECTURE.md 10.1: the two numbers are different questions and the');
say('obvious cross-check between them is false. 18 201 `JumpLoop`s are back');
say('edges, 130 are in irreducible regions and **259 are forward edges** in');
say('243 functions, because an `await` in a loop ends the body with a');
say('*returning* `SuspendGenerator`, so one invocation\'s CFG is acyclic.');
say();
say('| metric | expected | measured |'); say('|---|---:|---:|');
say(`| T6 back edges (before stage 1) | 18201 | ${T.irBackEdges} |`);
say(`| **of those, whose target is a loop region header** | 18201 | ${T.irBackEdgesInLoop} (${pct(T.irBackEdgesInLoop, T.irBackEdges)}) |`);
say(`| reachable \`JumpLoop\` edges | 18590 | ${T.jumpLoops} |`);
say(`| of those, whose target is a loop region header | | ${T.jumpLoopsInLoop} (${pct(T.jumpLoopsInLoop, T.jumpLoops)}) |`);
say(`| natural loops found over the structuring graph | | ${T.loopsFound} |`);
say(`| loop regions emitted | | ${T.loopRegions} |`);
say();
table('Loop regions by form', T.loopForms, T.loopRegions);
table('Loop plans by form (before the region tree)', T.loopPlanForms);
say('### Where the loop test sits');
say();
say('| metric | value |'); say('|---|---:|');
row('test in the header block', T.testInHeader);
row('**test below the header, on the test chain** (the leader rule split it)', T.testBelowHeader);
row('blocks on a multi-block test chain', T.testChainBlocks);
row('test chain rejected because it holds statements (-> `forever`)', T.testChainNotConsumed);
row('header holds a statement the test does not consume (-> `doWhile`/`forever`)', T.testBlockNotConsumed);
row('follow taken as the first exit after the body span', T.followAfterBody);
row('loops with more than one exit target', T.multiExitLoops);
row('loops with more than one latch', T.multiLatchLoops);
row('endless loops (no exit at all)', T.endlessLoops);
row('loops with no follow block', T.loopsWithoutFollow);
row('`for-in` idiom recognised', T.forInLoops);
row('`for-of` idiom recognised', T.forOfLoops);
row('loop test-chain blocks in `removed.loopTestBlocks`', T.loopTestBlocks);
say();
say('## Metric 2 — handler ranges that became a `try`');
say();
say('ARCHITECTURE.md 9.1: of 25 189 ranges, 13 713 are the `await` desugaring');
say('and must produce **no** `try`. The 5 821 CAUGHT + 5 655 UNCAUGHT ranges');
say('are the real ones.');
say();
say('| metric | expected | measured |'); say('|---|---:|---:|');
say(`| handler ranges | 25189 | ${T.handlerRanges} |`);
say(`| CAUGHT + UNCAUGHT ranges | 11476 | ${realRanges} |`);
say(`| **of those, became a \`try\` region** | 11476 | ${tryTotal} (${pct(tryTotal, realRanges)}) |`);
say(`| ASYNC_AWAIT(+UNCAUGHT_ASYNC_AWAIT) ranges | 13713 | ${T.asyncHandlerRanges} |`);
say(`| **of those, became a \`try\` region** | 0 | ${T.tryByPrediction.ASYNC_AWAIT ?? 0} |`);
say(`| \`try\` regions emitted | | ${T.tryRegions} |`);
say(`| ranges planned as a \`try\` | | ${T.tryRangesPlanned} |`);
say(`| async ranges found in \`tryPlans\` (independent check) | 0 | ${T.asyncTryViolations} |`);
say(`| blocks removed as the async rejection tail | | ${T.asyncHandlerBlocks} |`);
say(`| \`finally\` token shapes recognised | | ${T.finallyShapes} |`);
say(`| normal-completion tail blocks taken into a \`try\` body | | ${T.normalCompletionTailBlocks} |`);
say();
table('Handler ranges by prediction', T.rangesByPrediction, T.handlerRanges);
table('Ranges that became a `try`, by prediction', T.tryByPrediction, T.handlerRanges);
table('Ranges that did NOT become a `try`, by prediction', T.missedByPrediction, T.handlerRanges);
table('Why a real range was skipped', T.skippedHandlerWhy, T.skippedHandlerRanges);
table('`finally` token dispatch shapes', T.finallyShapeKinds);
say('## Stage 1 — the generator resume dispatcher');
say();
say('ARCHITECTURE.md 11.2 constraint 1: remove it **before** loop structuring.');
say('10.1 measured 121 irreducible functions in the other order and 0 in this');
say('one, so `irreducible after removal` is the number that matters.');
say();
say('| metric | expected | measured |'); say('|---|---:|---:|');
say(`| \`SwitchOnGeneratorState\` dispatchers seen | 10068 | ${T.dispatchers} |`);
say(`| **dispatcher blocks removed** | 10068 | ${T.dispatcherBlocksRemoved} |`);
say(`| dispatcher blocks kept (reported, not silent) | 0 | ${T.dispatcherBlocksKept} |`);
say(`| resume edges removed | | ${T.resumeEdgesRemoved} |`);
say(`| suspend -> resume splices | | ${T.splices} |`);
say(`| resume edges that could not be spliced | 0 | ${T.unsplicedResumeEdges} |`);
say(`| suspend points (\`ir.contextChain.suspendByIdIns\`) | 15276 | ${T.suspendPoints} |`);
say(`| irreducible edges BEFORE removal | 163 | ${T.irreducibleBefore} |`);
say(`| functions irreducible BEFORE removal | 121 | ${T.functionsIrreducibleBefore} |`);
say(`| **irreducible edges AFTER removal** | 0 | ${T.irreducibleAfter} |`);
say(`| **functions irreducible AFTER removal** | 0 | ${T.functionsIrreducibleAfter} |`);
say();
say('## `switch` — the compare chain is the main form');
say();
say('ARCHITECTURE.md 9.3: 11 208 jump tables in the corpus, of which only');
say('1 140 belong to a `switch` statement; 0.35% of functions have one. The');
say('compare chain is 99.65% of all switches, so 4.4.4 has it backwards.');
say();
say('| metric | expected | measured |'); say('|---|---:|---:|');
say(`| jump tables that are a generator dispatcher | 10068 | ${T.generatorDispatchTables} |`);
say(`| **real \`SwitchOnSmiNoFeedback\` jump tables planned** | 1140 | ${T.jumpTables} |`);
say(`| compare chains found | | ${T.compareChains} |`);
say(`| compare-chain links (case labels) | | ${T.compareChainLinks} |`);
say(`| jump-table guard blocks reported | | ${T.guardBlocks} |`);
say();
table('`switch` regions by form', T.switchRegions);
say('## The fall-back (ARCHITECTURE.md 4.4.7) — reported, never hidden');
say();
say('| metric | value |'); say('|---|---:|');
row('**`unstructured` regions**', T.unstructuredRegions);
row('blocks inside an `unstructured` region', `${T.unstructuredBlocks} (${pct(T.unstructuredBlocks, T.reachableBlocks)} of reachable blocks)`);
row('functions that fell back', `${T.fellBack} (${pct(T.fellBack, T.structured)})`);
say();
table('`unstructured` regions by `why`', T.unstructuredWhy, T.unstructuredRegions);
table('Fall-backs by `why`', T.fellBackWhy, T.fellBack);
say('## Shape of the output');
say();
say('ARCHITECTURE.md 10.6: 55.13% of corpus functions are a single basic');
say('block, and those have to come out as one trivial `{r:block}`.');
say();
say('| metric | expected | measured |'); say('|---|---:|---:|');
say(`| single-block functions | 132 290 (55.13%) | ${T.singleBlockFunctions} (${pct(T.singleBlockFunctions, T.structured)}) |`);
say(`| **of those, a single \`{r:block}\`** | all | ${T.singleBlockTrivial} (${pct(T.singleBlockTrivial, T.singleBlockFunctions)}) |`);
say(`| \`if\` regions | | ${T.ifs} |`);
say(`| \`seq\` regions | | ${T.seqs} |`);
say(`| \`break\` / \`continue\` | | ${T.breaks} / ${T.continues} |`);
say(`| labelled \`break\` / \`continue\` | | ${T.labelledBreaks} / ${T.labelledContinues} |`);
say(`| labels declared | | ${T.labels} |`);
say(`| follow from Cifuentes' dominator-children rule | | ${T.followFromDomChildren} |`);
say(`| follow from the immediate post-dominator fall-back | | ${T.followFromIpdom} |`);
say(`| no follow (the region ends at its parent's) | | ${T.followNull} |`);
say();
table('Warnings by code', T.warningKinds, T.warnings);

if (unitFailures.length) {
  say('## Functions whose structuring threw');
  say();
  for (const f of unitFailures.slice(0, 20)) say(`* \`${f.file}\` #${f.unit} ${f.name ?? ''} — ${f.error} (${f.at ?? ''})`);
  say();
}
if (violationSamples.length) {
  say('## Invariant violation samples');
  say();
  for (const v of violationSamples.slice(0, 20)) say(`* \`${v.file}\` #${v.unit} ${JSON.stringify(v).slice(0, 300)}`);
  say();
}
if (fellBackSamples.length) {
  say('## Fall-back samples');
  say();
  for (const v of fellBackSamples.slice(0, 20)) say(`* \`${v.file}\` #${v.unit} ${v.name ?? ''} ${v.why} blocks=${v.blocks} ${v.detail}`);
  say();
}
if (backEdgeMisses.length) {
  say('## Back edges with no loop region');
  say();
  for (const v of backEdgeMisses.slice(0, 20)) say(`* \`${v.file}\` #${v.unit} ${v.name ?? ''} edge ${v.from} -> ${v.to}`);
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
if (timedOut.length) { say(`Timed out: ${timedOut.map((f) => `\`${f}\``).join(', ')}`); say(); }
if (crashed.length) {
  say('## Crashed children');
  say();
  for (const c of crashed.slice(0, 10)) say(`* \`${c.file}\` exit ${c.code}: ${c.stderr.split('\n')[0]}`);
  say();
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${L.join('\n')}\n`);
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
  profile: PROFILE, corpus: CORPUS, wallSeconds: wall, childSeconds: childMs / 1000,
  totals: T, timedOut, crashed, readFailures, unitFailures, violationSamples,
  fellBackSamples, backEdgeMisses, slowest: slowest.slice(0, 30),
}, null, 1));
process.stderr.write(`wrote ${OUT}\n`);
