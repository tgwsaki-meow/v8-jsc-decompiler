#!/usr/bin/env node
// tools/ir/corpus_scan.mjs
//
// Build the IR of every function of every extracted_jsc/*.jsc, assert every
// structural invariant, and report the shape of the corpus.
//
// Follows tools/disasm/corpus_scan.mjs's pattern, with one difference it needs:
// one child process per file. The host has 4 GB and about two cores, and the
// IR of a large file is several times the size of its disassembly, so a single
// long-lived process accumulates fragmentation it never gives back. A forked
// worker per file gives the memory back on exit, lets a pathological file be
// killed on a timeout instead of taking the run with it, and uses the second
// core. Each child gets its own heap cap.
//
// The run is resumable: each file's result is a JSON file under
// --work, and a file whose result already exists is skipped. So a run that is
// interrupted picks up where it stopped, and --force re-does everything.
//
//   node tools/ir/corpus_scan.mjs
//   node tools/ir/corpus_scan.mjs --max-files 20 --jobs 2
//   node tools/ir/corpus_scan.mjs --exception-model block --out scratch/t6/IR_CORPUS_BLOCK.md
//
// Nothing from the corpus is ever executed; only parsed.

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
const TIMEOUT_MS = Number(argOf('timeout', '600')) * 1000;
const WORK = argOf('work', 'scratch/t6/corpus');
const OUT = argOf('out', 'scratch/t6/IR_CORPUS.md');
const MODEL = argOf('exception-model', 'instruction');
const BRUTE = argOf('brute-force-budget', '3');
const SCOPE_INFOS = flag('no-scope-infos') ? '0' : '1';

const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort().slice(0, MAX_FILES);
fs.mkdirSync(WORK, { recursive: true });
const resultPath = (f) => path.join(WORK, `${f}.${MODEL}.json`);
if (flag('force')) for (const f of files) { try { fs.unlinkSync(resultPath(f)); } catch { /* not there */ } }

const pending = files.filter((f) => !fs.existsSync(resultPath(f)));
process.stderr.write(`${files.length} files, ${pending.length} to do, ${JOBS} job(s), `
  + `child heap ${HEAP} MB, timeout ${TIMEOUT_MS / 1000}s, exception model '${MODEL}'\n`);

const timedOut = [];
const crashed = [];
let done = files.length - pending.length;
const t0 = Date.now();

function runOne(f) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${HEAP}`,
      'tools/ir/corpus_worker.mjs',
      path.join(CORPUS, f), PROFILE, resultPath(f),
      '--brute-force-budget', BRUTE,
      '--exception-model', MODEL,
      '--scope-infos', SCOPE_INFOS,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString().slice(0, 4000); });
    child.stdout.on('data', () => { /* workers write files, not stdout */ });
    const timer = setTimeout(() => { child.kill('SIGKILL'); timedOut.push(f); }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !timedOut.includes(f)) crashed.push({ file: f, code, stderr: err.slice(0, 1200) });
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

// ---------------------------------------------------------------- merge
const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const T = {
  files: 0, filesFailed: 0, units: 0, compiled: 0, failed: 0, instructions: 0,
  blocks: 0, reachableBlocks: 0, unreachableBlocks: 0, edges: 0,
  loops: 0, backEdges: 0, retreatingEdges: 0, irreducibleFunctions: 0, irreducibleEdges: 0,
  irreducibleAsync: 0, irreducibleGenerator: 0, irreducibleNeither: 0,
  irreducibleEvenWithoutResumeFunctions: 0, irreducibleEvenWithoutResumeEdges: 0,
  generatorResumeEdges: 0, generatorDispatchBlocks: 0,
  jumpLoopEdges: 0, jumpLoopBackEdges: 0, jumpLoopIrreducible: 0,
  jumpLoopCycleBrokenBySuspend: 0, jumpLoopUnclassified: 0, functionsWithLoopBrokenBySuspend: 0,
  endlessLoops: 0, multiLatchLoops: 0, multiExitLoops: 0, virtualExitEdges: 0,
  phis: 0, maxPhiArity: 0, values: 0, projections: 0, caughtExceptionDefs: 0,
  effectChainOps: 0, effectPhis: 0, effectfulOps: 0, allocatingOps: 0,
  handlers: 0, handlerBlocks: 0, exceptionEdges: 0, switchEdges: 0, switchDispatchBlocks: 0,
  rangesWithoutThrowingInstruction: 0, handlerNotInsideEnclosingRange: 0,
  liveInWrittenByThrowingTerminator: 0, accumulatorLiveInAtHandler: 0, clobberedUses: 0,
  contextSlotOps: 0, contextSlotResolved: 0, contextSlotUnresolved: 0, contextFrames: 0,
  functionsWithExceptionEdges: 0, functionsWithGeneratorDispatcher: 0,
  functionsWithSwitchStatementTable: 0, functionsWithLoops: 0,
  generatorDispatchers: 0, smiSwitchTables: 0, bruteForceChecked: 0, elapsedMs: 0,
};
const edgesByKind = {}, blockKinds = {}, effectKindCounts = {}, contextSlotWhy = {};
const contextSlotDepthHist = {}, warningKinds = {}, irreducibleTerminators = {};
const dist = {};
const checks = {}, checkSamples = {};
const irreducibleExamples = [], irreducibleHardExamples = [];
const readFailures = [];
const slowest = [];
let contextHeaderSource = null;

for (const f of files) {
  const p = resultPath(f);
  if (!fs.existsSync(p)) { T.filesFailed++; readFailures.push({ file: f, error: 'no result file (crashed or timed out)' }); continue; }
  let R;
  try { R = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { T.filesFailed++; readFailures.push({ file: f, error: `unreadable result: ${e.message}` }); continue; }
  if (!R.ok) { T.filesFailed++; readFailures.push({ file: f, error: R.error }); continue; }
  T.files++;
  for (const k of Object.keys(T)) {
    if (k === 'files' || k === 'filesFailed' || k === 'maxPhiArity') continue;
    if (typeof R[k] === 'number') T[k] += R[k];
  }
  if (R.maxPhiArity > T.maxPhiArity) T.maxPhiArity = R.maxPhiArity;
  for (const [k, v] of Object.entries(R.edgesByKind)) bump(edgesByKind, k, v);
  for (const [k, v] of Object.entries(R.blockKinds)) bump(blockKinds, k, v);
  for (const [k, v] of Object.entries(R.effectKindCounts)) bump(effectKindCounts, k, v);
  for (const [k, v] of Object.entries(R.contextSlotWhy)) bump(contextSlotWhy, k, v);
  for (const [k, v] of Object.entries(R.contextSlotDepthHist)) bump(contextSlotDepthHist, k, v);
  for (const [k, v] of Object.entries(R.warningKinds)) bump(warningKinds, k, v);
  for (const [k, v] of Object.entries(R.irreducibleTerminators ?? {})) bump(irreducibleTerminators, k, v);
  for (const x of R.irreducibleHardExamples ?? []) if (irreducibleHardExamples.length < 12) irreducibleHardExamples.push(x);
  for (const [name, h] of Object.entries(R.dist)) {
    const d = dist[name] ?? (dist[name] = {});
    for (const [k, v] of Object.entries(h)) bump(d, k, v);
  }
  for (const [name, c] of Object.entries(R.checks)) {
    const e = checks[name] ?? (checks[name] = { violations: 0, total: 0, functions: 0 });
    e.violations += c.violations; e.total += c.total; e.functions += c.functions;
  }
  for (const [name, s] of Object.entries(R.checkSamples)) {
    const a = checkSamples[name] ?? (checkSamples[name] = []);
    for (const x of s) if (a.length < 6) a.push(x);
  }
  for (const x of R.irreducibleExamples) if (irreducibleExamples.length < 25) irreducibleExamples.push(x);
  if (R.contextHeaderSource) contextHeaderSource = R.contextHeaderSource;
  slowest.push({ file: f, ms: R.elapsedMs, units: R.compiled, instructions: R.instructions, blocks: R.blocks });
}
slowest.sort((a, b) => b.ms - a.ms);

// ---------------------------------------------------------------- report
const L = [];
const say = (s = '') => L.push(s);
const BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9-16', '17-32', '33-64', '65-128', '129-256', '257-512', '513-1024', '1025-4096', '4097+'];
function histTable(name, h) {
  say(`### ${name}`);
  say('');
  const total = Object.values(h).reduce((a, b) => a + b, 0);
  say('| bucket | count | share |');
  say('|---|---:|---:|');
  const keys = Object.keys(h).sort((a, b) => {
    const ia = BUCKETS.indexOf(a), ib = BUCKETS.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    return Number(a) - Number(b);
  });
  for (const k of keys) say(`| ${k} | ${h[k]} | ${total ? (100 * h[k] / total).toFixed(2) : '0'}% |`);
  say('');
}

say('# src/ir corpus scan');
say('');
say(`corpus          : ${CORPUS}/  ${files.length} .jsc files`);
say(`profile         : ${PROFILE}`);
say(`exception model : ${MODEL}`);
say(`node            : ${process.version}, ${JOBS} job(s), child heap ${HEAP} MB`);
say(`wall time       : ${((Date.now() - t0) / 1000).toFixed(1)} s for the files run this pass`
  + `  (child CPU total ${(T.elapsedMs / 1000).toFixed(1)} s)`);
say('');
say('## totals');
say('');
say('| metric | value |');
say('|---|---:|');
const row = (k, v) => say(`| ${k} | ${v} |`);
row('files read', `${T.files} / ${files.length}`);
row('files that failed', T.filesFailed);
row('functions (SharedFunctionInfo)', T.units);
row('functions with bytecode', T.compiled);
row('**functions whose IR failed to build**', `**${T.failed}**`);
row('instructions', T.instructions);
row('basic blocks', T.blocks);
row('blocks reachable from the entry', `${T.reachableBlocks} (${T.blocks ? (100 * T.reachableBlocks / T.blocks).toFixed(4) : 0}%)`);
row('**unreachable blocks**', `**${T.unreachableBlocks}**`);
row('edges', T.edges);
row('SSA values', T.values);
row('phi nodes', T.phis);
row('max phi arity', T.maxPhiArity);
row('projections (secondary outputs)', T.projections);
row('CaughtException definitions', T.caughtExceptionDefs);
row('effect-chain ops', T.effectChainOps);
row('effect phis', T.effectPhis);
row('ops with hasEffect', T.effectfulOps);
row('ops with allocatesIdentity', T.allocatingOps);
row('loops', T.loops);
row('back edges', T.backEdges);
row('retreating edges', T.retreatingEdges);
row('**functions with an irreducible back edge**', `**${T.irreducibleFunctions}** of ${T.compiled}`);
row('**irreducible back edges**', `**${T.irreducibleEdges}**`);
row('endless loops (no exit edge)', T.endlessLoops);
row('loops with more than one latch', T.multiLatchLoops);
row('loops with more than one exit', T.multiExitLoops);
row('virtual exit edges invented for post-dominance', T.virtualExitEdges);
row('handler ranges', T.handlers);
row('handler blocks', T.handlerBlocks);
row('exception edges', T.exceptionEdges);
row('ranges with no throwing instruction (degenerate edge added)', T.rangesWithoutThrowingInstruction);
row('inner handlers NOT covered by their enclosing range', T.handlerNotInsideEnclosingRange);
row('handler live-ins written by a throwing terminator (model imprecision)', T.liveInWrittenByThrowingTerminator);
row('functions where the accumulator is live-in at a handler', T.accumulatorLiveInAtHandler);
row('uses of a clobbered accumulator', T.clobberedUses);
row('switch successor edges', T.switchEdges);
row('jump tables: generator dispatchers', T.generatorDispatchers);
row('jump tables: SwitchOnSmiNoFeedback', T.smiSwitchTables);
row('context slot ops', T.contextSlotOps);
row('**context slot ops resolved to a name**', `**${T.contextSlotResolved}** (${T.contextSlotOps ? (100 * T.contextSlotResolved / T.contextSlotOps).toFixed(3) : 0}%)`);
row('context frames', T.contextFrames);
row('functions the brute-force oracles were run on', T.bruteForceChecked);
say('');
say(`Context header length source: ${contextHeaderSource}`);
say('');

say('## invariants');
say('');
say('| invariant | result | violations | items checked | functions affected |');
say('|---|---|---:|---:|---:|');
let totalViolations = 0;
for (const [name, c] of Object.entries(checks)) {
  totalViolations += c.violations;
  say(`| ${name} | ${c.violations === 0 ? 'PASS' : '**FAIL**'} | ${c.violations} | ${c.total} | ${c.functions} |`);
}
say('');
if (Object.keys(checkSamples).length) {
  say('### violation samples');
  say('');
  for (const [name, s] of Object.entries(checkSamples)) {
    say(`**${name}**`);
    say('');
    for (const x of s) say('```\n' + JSON.stringify(x, null, 1) + '\n```');
    say('');
  }
}

say('## reducibility');
say('');
say(`ARCHITECTURE.md section 0 asserts the CFG is always reducible because Ignition bytecode is emitted`);
say(`from an AST by a single-pass generator that never rewrites control flow. Measured over`);
say(`${T.compiled} functions and ${T.instructions} instructions:`);
say('');
say('| measurement | value |');
say('|---|---:|');
row('retreating edges (target earlier in reverse postorder)', T.retreatingEdges);
row('of those, back edges (target dominates source)', T.backEdges);
row('**irreducible retreating edges**', `**${T.irreducibleEdges}**`);
row('**functions containing one**', `**${T.irreducibleFunctions}** of ${T.compiled}`
  + ` (${(100 * T.irreducibleFunctions / Math.max(1, T.compiled)).toFixed(4)}%)`);
row('of those, async', T.irreducibleAsync);
row('of those, generator', T.irreducibleGenerator);
row('of those, neither async nor generator', T.irreducibleNeither);
row('**functions still irreducible once the generator resume edges are removed**', `**${T.irreducibleEvenWithoutResumeFunctions}**`);
row('edges still irreducible once the generator resume edges are removed', T.irreducibleEvenWithoutResumeEdges);
say('');
if (Object.keys(irreducibleTerminators).length) {
  say('### terminator of the block the irreducible edge leaves');
  say('');
  say('| opcode | edges |');
  say('|---|---:|');
  for (const [k, v] of Object.entries(irreducibleTerminators).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
  say('');
}
if (irreducibleExamples.length) {
  say('### irreducible functions');
  say('');
  for (const x of irreducibleExamples) say('```\n' + JSON.stringify(x, null, 1) + '\n```');
  say('');
} else {
  say('No function in the corpus has a retreating edge whose target does not dominate it, so every CFG');
  say('is reducible and T8 needs the `goto` fall-back only as insurance against a future input.');
  say('');
}
if (irreducibleHardExamples.length) {
  say('### functions that are irreducible for a reason OTHER than the resume dispatcher');
  say('');
  for (const x of irreducibleHardExamples) say('```\n' + JSON.stringify(x, null, 1) + '\n```');
  say('');
} else if (T.irreducibleFunctions) {
  say('Every irreducible function becomes reducible once the generator resume dispatcher\'s jump-table');
  say('edges are removed. So the irreducibility is entirely an artefact of the `SwitchOnGeneratorState`');
  say('entry dispatcher jumping into the middle of a loop body, and ARCHITECTURE.md 4.4.6 already');
  say('prescribes removing it. The only thing that has to be added to the plan is an ORDER: T8 must');
  say('delete the dispatcher before it structures loops, not after.');
  say('');
}

say('## cross-checks against the disassembler');
say('');
say('| cross-check | disagreements |');
say('|---|---:|');
for (const name of [
  'every back edge comes from the backward branch opcode',
  'every reachable JumpLoop produces exactly one classified edge',
  'switch successor count equals the decoded jump-table entry count',
  'every protected range has a handler block and at least one exception edge',
  'every jump-table target is a block leader',
]) say(`| ${name} | ${checks[name]?.violations ?? '?'} |`);
say('');
say('### what each reachable JumpLoop turned into');
say('');
say('| class | count | share |');
say('|---|---:|---:|');
const jlRow = (k, v) => say(`| ${k} | ${v} | ${(100 * v / Math.max(1, T.jumpLoopEdges)).toFixed(2)}% |`);
jlRow('a back edge (target dominates source)', T.jumpLoopBackEdges);
jlRow('in an irreducible region (cyclic, target does not dominate)', T.jumpLoopIrreducible);
jlRow('a forward edge: the cycle is broken by a suspend', T.jumpLoopCycleBrokenBySuspend);
jlRow('unclassified (a real failure)', T.jumpLoopUnclassified);
say(`| total | ${T.jumpLoopEdges} | |`);
say('');
say('The third class is the one that makes "back edges == JumpLoop count" wrong. In an async function');
say('whose `await` is inside the loop, the body ends in `SuspendGenerator`, which returns, so the body');
say(`has no path back to the header: one invocation's CFG is acyclic and the loop closes only by`);
say(`re-entering the function through the resume dispatcher. ${T.functionsWithLoopBrokenBySuspend} function(s) are in that shape.`);
say('');

say('## corpus shape');
say('');
say('| metric | value |');
say('|---|---:|');
row('mean blocks per function', (T.blocks / Math.max(1, T.compiled)).toFixed(2));
row('mean instructions per block', (T.instructions / Math.max(1, T.blocks)).toFixed(2));
row('mean edges per block', (T.edges / Math.max(1, T.blocks)).toFixed(2));
row('mean phis per function', (T.phis / Math.max(1, T.compiled)).toFixed(2));
row('mean SSA values per function', (T.values / Math.max(1, T.compiled)).toFixed(1));
row('functions with at least one loop', `${T.functionsWithLoops} (${(100 * T.functionsWithLoops / Math.max(1, T.compiled)).toFixed(2)}%)`);
row('functions with exception edges', `${T.functionsWithExceptionEdges} (${(100 * T.functionsWithExceptionEdges / Math.max(1, T.compiled)).toFixed(2)}%)`);
row('functions with a generator dispatcher', `${T.functionsWithGeneratorDispatcher} (${(100 * T.functionsWithGeneratorDispatcher / Math.max(1, T.compiled)).toFixed(2)}%)`);
row('functions with a SwitchOnSmiNoFeedback table', `${T.functionsWithSwitchStatementTable} (${(100 * T.functionsWithSwitchStatementTable / Math.max(1, T.compiled)).toFixed(2)}%)`);
say('');
say('### edges by kind');
say('');
say('| kind | count | share |');
say('|---|---:|---:|');
for (const [k, v] of Object.entries(edgesByKind).sort((a, b) => b[1] - a[1])) {
  say(`| ${k} | ${v} | ${(100 * v / Math.max(1, T.edges)).toFixed(2)}% |`);
}
say('');
say('### blocks by kind (8.4 `kind`, resolved by priority)');
say('');
say('| kind | count |');
say('|---|---:|');
for (const [k, v] of Object.entries(blockKinds).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
say('');
for (const [name, h] of Object.entries(dist)) histTable(name, h);

say('### effect kinds touched');
say('');
say('| kind | ops |');
say('|---|---:|');
for (const [k, v] of Object.entries(effectKindCounts).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
say('');

say('### context slot resolution');
say('');
say('| outcome | count |');
say('|---|---:|');
say(`| resolved to a name | ${T.contextSlotResolved} |`);
for (const [k, v] of Object.entries(contextSlotWhy).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
say('');
histTable('max context depth per function', contextSlotDepthHist);

say('## warnings by kind');
say('');
if (!Object.keys(warningKinds).length) say('(none)');
else {
  say('| code | count |');
  say('|---|---:|');
  for (const [k, v] of Object.entries(warningKinds).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
}
say('');

if (readFailures.length || timedOut.length || crashed.length) {
  say('## files that did not complete');
  say('');
  for (const f of readFailures.slice(0, 40)) say(`* ${f.file}: ${f.error}`);
  for (const f of timedOut) say(`* ${f}: TIMED OUT after ${TIMEOUT_MS / 1000}s`);
  for (const c of crashed.slice(0, 20)) say(`* ${c.file}: exit ${c.code} ${c.stderr.split('\n').slice(0, 3).join(' / ')}`);
  say('');
}

say('## slowest files');
say('');
say('| file | functions | instructions | blocks | ms |');
say('|---|---:|---:|---:|---:|');
for (const s of slowest.slice(0, 15)) say(`| ${s.file} | ${s.units} | ${s.instructions} | ${s.blocks} | ${s.ms.toFixed(0)} |`);
say('');

const failed = T.filesFailed + T.failed + totalViolations + T.unreachableBlocks;
say('='.repeat(78));
say(failed === 0 ? 'IR CORPUS SCAN: NO FAILURES' : `IR CORPUS SCAN: ${failed} PROBLEM(S) -- see above`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n') + '\n');
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
  corpus: CORPUS, profile: PROFILE, model: MODEL, files: files.length,
  totals: T, edgesByKind, blockKinds, effectKindCounts, contextSlotWhy, contextSlotDepthHist,
  dist, checks, checkSamples, irreducibleExamples, irreducibleHardExamples,
  irreducibleTerminators, warningKinds, readFailures, timedOut, crashed,
  contextHeaderSource,
}, null, 1));
process.stderr.write(L.slice(0, 90).join('\n') + `\n\n... full report: ${OUT}\n`);
process.exitCode = failed === 0 ? 0 : 1;
