#!/usr/bin/env node
// The metrics dashboard.
//
//   node tools/metrics/run.mjs --quick      # minutes, stratified samples
//   node tools/metrics/run.mjs --full       # hours, wide samples
//
// Writes docs/METRICS.md and scratch/t3/metrics/metrics-<mode>.json (plus
// latest.json). Every collector runs in its own process with a heap cap and a
// timeout, because this host has 4 GB and the pipeline under test has inputs
// that take minutes and 1.5 GB.
//
// Other flags
//   --outputs stored|fresh   where the emitted-JS side of metrics 1-3 comes
//                            from. stored = decompiled_js/ (the archive);
//                            fresh = re-decompile each sampled input. The
//                            liveness collector re-checks that the archive
//                            still matches the pipeline either way.
//   --only a,b / --skip a,b  collectors: control_flow identifiers hazards
//                            liveness ro_refs features
//   --sample N               corpus entries for the features collector
//   --timeout MS             per-input pipeline budget
//
// Deliberately absent: output parseability and opcode-case coverage. Both are
// saturated at 100% and neither measures the decompiler (see the "Retired"
// section of the generated doc). Do not add them back.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const mode = has('--full') ? 'full' : 'quick';
const outputsFrom = val('--outputs', 'stored');
const timeoutMs = val('--timeout', mode === 'full' ? '180000' : '90000');
const METRICS_DIR = 'scratch/t3/metrics';
const DOC = 'docs/METRICS.md';
fs.mkdirSync(METRICS_DIR, { recursive: true });

const baseline = JSON.parse(fs.readFileSync('tools/metrics/baseline.json', 'utf8'));

const ALL = ['control_flow', 'identifiers', 'hazards', 'liveness', 'ro_refs', 'features'];
const only = has('--only') ? val('--only').split(',') : null;
const skip = has('--skip') ? val('--skip').split(',') : [];
const collectors = ALL.filter((c) => (!only || only.includes(c)) && !skip.includes(c));

const BUDGET = { control_flow: 40, identifiers: 20, hazards: 30, liveness: 90, ro_refs: 30, features: 240 };

// Per-collector mode override. The one that matters is `--liveness full`
// inside a --quick run: metric 6's baseline is dominated by one 6 MB input
// that takes 166 s, so the only way to compare metric 6 against the baseline
// without paying for a full run everywhere else is to widen that collector
// alone. Whatever is chosen, the generated doc prints each collector's own
// sample description, so the document stays self-describing.
const collectorMode = (name) => val(`--${name}`, mode);

function runCollector(name) {
  const cmode = collectorMode(name);
  const out = path.join(METRICS_DIR, `${name}.${cmode}.json`);
  const log = path.join(METRICS_DIR, `${name}.${cmode}.log.txt`);
  // --reuse re-renders the document from collector artifacts already on disk.
  // Measuring is the expensive part; the wording of the report is not, and
  // paying 45 minutes to fix a sentence makes the report worse, not better.
  if (has('--reuse') && fs.existsSync(out)) {
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    doc._wallMs = 0;
    doc._log = log;
    doc._reused = true;
    console.log(`  ${name.padEnd(14)} reused     -> ${out}`);
    return doc;
  }
  const args = [`--max-old-space-size=1400`, `tools/metrics/collect/${name}.mjs`, '--mode', cmode, '--out', out, '--timeout', timeoutMs];
  if (name === 'control_flow') args.push('--outputs', outputsFrom);
  if (name === 'features' && has('--sample')) args.push('--sample', val('--sample'));
  const fd = fs.openSync(log, 'w');
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: BUDGET[name] * 60_000 });
  } finally { fs.closeSync(fd); }
  const wall = Date.now() - t0;
  if (fs.existsSync(out)) {
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    doc._wallMs = wall;
    doc._log = log;
    console.log(`  ${name.padEnd(14)} ok   ${(wall / 1000).toFixed(1)} s   -> ${out}`);
    return doc;
  }
  const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().slice(-600) : '';
  console.log(`  ${name.padEnd(14)} FAIL ${(wall / 1000).toFixed(1)} s   status=${r?.status} ${r?.error?.message ?? ''}`);
  return { collector: name, mode: cmode, _failed: true, _wallMs: wall, _log: log, _status: r?.status ?? null, _tail: tail };
}

console.log(`metrics dashboard: mode=${mode} outputs=${outputsFrom} collectors=${collectors.join(',')}`);
const t0 = Date.now();
const data = {};
for (const c of collectors) data[c] = runCollector(c);
const wallMs = Date.now() - t0;

// ---------------------------------------------------------------------------
// assemble the table
// ---------------------------------------------------------------------------
const B = baseline.metrics;
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(2)}%` : 'n/a');
const frac = (n, d) => `${n} / ${d}`;
const na = (x) => (x === null || x === undefined ? 'not measured' : x);

const cf = data.control_flow;
const id = data.identifiers;
const hz = data.hazards;
const lv = data.liveness;
const ro = data.ro_refs;
const ft = data.features;

const M = [];
const row = (n, name, baselineText, measured, sample, note) => M.push({ n, name, baselineText, measured, sample, note });

row(1, 'loop statements emitted per `JumpLoop` back-edge', B['1'].baseline,
  cf && !cf._failed ? `${frac(cf.metrics.m1_loopsPerBackEdge.numerator, cf.metrics.m1_loopsPerBackEdge.denominator)}` : 'collector failed',
  cf && !cf._failed ? `${cf.filesPaired} files` : '-',
  cf && !cf._failed && cf.metrics.m1_loopsPerBackEdge.denominator !== B['1'].denominator
    ? `denominator differs from the baseline's ${B['1'].denominator} (sample is ${cf.mode === 'quick' ? 'the same formula' : 'wider'})` : '');
row(2, 'try statements emitted per handler range', B['2'].baseline,
  cf && !cf._failed ? `${frac(cf.metrics.m2_tryPerHandlerRange.numerator, cf.metrics.m2_tryPerHandlerRange.denominator)}` : 'collector failed',
  cf && !cf._failed ? `${cf.filesPaired} files` : '-',
  'the baseline\'s 667 counted exception OPCODES, not handler ranges -- see Discrepancies');
row(3, '`switch` statements per switch-dispatch opcode', B['3'].baseline,
  cf && !cf._failed ? `${frac(cf.metrics.m3_switchPerDispatchOpcode.numerator, cf.metrics.m3_switchPerDispatchOpcode.denominator)}` : 'collector failed',
  cf && !cf._failed ? `${cf.filesPaired} files` : '-', '');
row(4, 'O1 opcode-sequence match % (per function, mean and median)', B['4'].baseline,
  ft && !ft._failed
    ? (ft.metrics.m4_o1OpcodeMatch.pairedFunctions
        ? `mean ${(100 * ft.metrics.m4_o1OpcodeMatch.mean).toFixed(2)}%, median ${(100 * ft.metrics.m4_o1OpcodeMatch.median).toFixed(2)}% over ${ft.metrics.m4_o1OpcodeMatch.pairedFunctions} functions`
        : `no comparable function: ${Object.entries(ft.metrics.m4_o1OpcodeMatch.statusHistogram).map(([k, v]) => `${v} ${k}`).join(', ')}`)
    : 'collector failed',
  ft && !ft._failed ? `${ft.sample.entries} corpus entries` : '-',
  ft && !ft._failed && !ft.metrics.m4_o1OpcodeMatch.pairedFunctions ? 'the instrument works (see Oracle self-check); the pipeline cannot ingest the input' : '');
row(5, 'free identifiers that are real globals', B['5'].baseline,
  id && !id._failed ? `${id.metrics.m5_realGlobalShare.pct}% (${frac(id.metrics.m5_realGlobalShare.numerator, id.metrics.m5_realGlobalShare.denominator)} references)` : 'collector failed',
  id && !id._failed ? `${id.files} files` : '-', '');
row(6, 'functions emitted / functions deserialized', B['6'].baseline,
  lv && !lv._failed ? `${lv.all.aggregatePct}% aggregate, ${lv.all.medianPct}% median` : 'collector failed',
  lv && !lv._failed ? `${lv.completed}/${lv.attempted} inputs completed (\`--${lv.mode}\` sample)` : '-',
  lv && !lv._failed && lv.baselineSubset.files
    ? `on the baseline's own ${lv.baselineSubset.files} completed inputs: ${lv.baselineSubset.aggregatePct}% aggregate, ${lv.baselineSubset.medianPct}% median`
    : 'this sample excludes the baseline\'s slow inputs, and metric 6 is dominated by one of them -- run `--liveness full` for the comparable number');
row(7, 'duplicated side-effecting calls (adjacent statement pairs)', B['7'].baseline,
  hz && !hz._failed ? `${hz.metrics.m7_duplicatedSideEffects.pct}% (${frac(hz.metrics.m7_duplicatedSideEffects.numerator, hz.metrics.m7_duplicatedSideEffects.denominator)})` : 'collector failed',
  hz && !hz._failed ? `${hz.files} files` : '-', '');
row(8, 'allocation expressions losing identity', B['8'].baseline,
  hz && !hz._failed ? `${hz.metrics.m8_allocationsLosingIdentity.pct}% (${frac(hz.metrics.m8_allocationsLosingIdentity.numerator, hz.metrics.m8_allocationsLosingIdentity.denominator)})` : 'collector failed',
  hz && !hz._failed ? `${hz.files} files` : '-', '');
row(9, 'unresolved read-only refs', B['9'].baseline,
  ro && !ro._failed ? `${ro.metrics.m9_unresolvedRoRefs.distinctUnresolvedWithAuthorityTable} distinct / ${ro.metrics.m9_unresolvedRoRefs.occurrencesUnresolvedWithAuthorityTable} occurrences unresolved` : 'collector failed',
  ro && !ro._failed ? `${ro.files} files, ${ro.distinctRefs} distinct refs, ${ro.refOccurrences} occurrences` : '-',
  ro && !ro._failed ? `against the legacy rules/v8-ro-heap.json: ${ro.metrics.m9_unresolvedRoRefs.distinctUnresolvedWithLegacyTable} distinct unresolved` : '');
row(10, 'regions marked UNSTRUCTURED', B['10'].baseline,
  cf && !cf._failed ? `${cf.metrics.m10_unstructuredRegions.value}` : 'collector failed',
  cf && !cf._failed ? `${cf.filesPaired} files` : '-',
  'the current emitter has no UNSTRUCTURED marker, so 0 means "never reported", not "never needed"');
row(11, 'throughput, ms per input KB', B['11'].baseline,
  lv && !lv._failed ? `${lv.metrics.m11_msPerInputKB.min} - ${lv.metrics.m11_msPerInputKB.max} (median ${lv.metrics.m11_msPerInputKB.median}, spread ${lv.metrics.m11_msPerInputKB.spreadRatio}x)` : 'collector failed',
  lv && !lv._failed ? `${lv.completed} inputs` : '-',
  lv && !lv._failed && lv.throughputControl?.measuredMsPerKB?.length
    ? `the baseline's upper bound came from \`${lv.throughputControl.file}\` at ${lv.throughputControl.baselineMsPerKB} ms/KB; measured ${lv.throughputControl.repeats}x here: ${lv.throughputControl.measuredMsPerKB.join(', ')} ms/KB`
    : '');
row(12, 'feature-coverage matrix: pass/fail per `corpus/features/` entry', B['12'].baseline,
  ft && !ft._failed ? `O1 ${ft.metrics.m12_featureCoverage.o1Match}/${ft.metrics.m12_featureCoverage.entries}, O2 ${ft.metrics.m12_featureCoverage.o2Fixpoint}/${ft.metrics.m12_featureCoverage.entries}, O3 ${ft.metrics.m12_featureCoverage.o3Match}/${ft.metrics.m12_featureCoverage.entries}, all three ${ft.metrics.m12_featureCoverage.allThree}/${ft.metrics.m12_featureCoverage.entries}` : 'collector failed',
  ft && !ft._failed ? `${ft.sample.entries} entries` : '-', '');

// ---------------------------------------------------------------------------
// discrepancies with the baseline, computed not asserted
// ---------------------------------------------------------------------------
const disc = [];
if (cf && !cf._failed) {
  const d1 = cf.metrics.m1_loopsPerBackEdge.denominator;
  if (cf.mode === 'quick' && d1 !== B['1'].denominator) {
    disc.push(`metric 1 denominator: dashboard ${d1} JumpLoop back-edges vs baseline ${B['1'].denominator}, on the same 20-file formula.`);
  }
  const d3 = cf.metrics.m3_switchPerDispatchOpcode.denominator;
  if (cf.mode === 'quick' && d3 !== B['3'].denominator) {
    disc.push(`metric 3 denominator: dashboard ${d3} switch-dispatch opcodes vs baseline ${B['3'].denominator}, on the same 20-file formula.`);
  }
  const exc = cf.metrics.m2_tryPerExceptionOpcode.denominator;
  disc.push(`metric 2 is named "per handler range" but the baseline's 667 is the count of exception opcodes (Throw / ReThrow / SetPendingMessage). This run: ${cf.bytecode.handlerRanges} handler ranges in ${cf.bytecode.functionsWithHandlers} functions, and ${exc} exception opcodes${exc === B['2'].denominator ? ' -- the opcode count reproduces the baseline exactly, which confirms the mislabelling' : ''}. The handler-range count is the right denominator for a metric about \`try\`; both are reported.`);
}
if (id && !id._failed) {
  const d = Math.abs(id.metrics.m5_realGlobalShare.pct - B['5'].value);
  if (d > 1) disc.push(`metric 5: dashboard ${id.metrics.m5_realGlobalShare.pct}% vs baseline ${B['5'].value}% on the same file selection.`);
}
if (hz && !hz._failed) {
  if (Math.abs(hz.metrics.m7_duplicatedSideEffects.pct - B['7'].value) > 0.2) {
    disc.push(`metric 7: dashboard ${hz.metrics.m7_duplicatedSideEffects.pct}% (${hz.metrics.m7_duplicatedSideEffects.numerator}/${hz.metrics.m7_duplicatedSideEffects.denominator}) vs baseline ${B['7'].value}% (${B['7'].numerator}/${B['7'].denominator}).`);
  }
  if (Math.abs(hz.metrics.m8_allocationsLosingIdentity.pct - B['8'].value) > 0.2) {
    disc.push(`metric 8: dashboard ${hz.metrics.m8_allocationsLosingIdentity.pct}% (${hz.metrics.m8_allocationsLosingIdentity.numerator}/${hz.metrics.m8_allocationsLosingIdentity.denominator}) vs baseline ${B['8'].value}% (${B['8'].numerator}/${B['8'].denominator}).`);
  }
}
if (lv && !lv._failed && lv.storedArchive.differing.length) {
  disc.push(`the stored archive is not the current pipeline's output for ${lv.storedArchive.differing.length} of ${lv.storedArchive.compared} compared inputs (${lv.storedArchive.differing.map((d) => d.jsc).join(', ')}). Metrics 1-3, 5, 7 and 8 read \`decompiled_js/\` in --outputs stored mode, so they describe the archive for those files, not today's code. BASELINE_AUDIT.md 3.5 found the same two.`);
}

// ---------------------------------------------------------------------------
// write the doc
// ---------------------------------------------------------------------------
const L = [];
const say = (s = '') => L.push(s);

say('# Metrics');
say('');
say('> Generated by `node tools/metrics/run.mjs ' + (mode === 'full' ? '--full' : '--quick') + '`. Do not edit by hand.');
say('');
say('| | |');
say('|---|---|');
say(`| generated | ${new Date().toISOString()} |`);
say(`| mode | \`--${mode}\` (${(wallMs / 1000).toFixed(0)} s wall) |`);
say(`| pipeline under test | \`${ft && !ft._failed ? ft.pipeline : (process.env.V8D_PIPELINE ?? 'src/decompiler.js')}\` |`);
say(`| emitted-JS side of metrics 1-3 | ${outputsFrom === 'stored' ? '`decompiled_js/` (the archive)' : 'a fresh decompile of each sampled input'} |`);
say(`| .jsc minter | ${ft && !ft._failed ? `${ft.minter.label} (V8 ${ft.minter.v8 ?? '?'})` : 'n/a'} |`);
say(`| bytecode engine | ${ft && !ft._failed ? path.basename(ft.engine) : 'n/a'} |`);
say(`| host | ${os.platform()} ${os.arch()}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, node ${process.version} (V8 ${process.versions.v8}) |`);
say(`| baseline | \`${baseline.source}\`, ${baseline.date} |`);
say(`| JSON artifact | \`${METRICS_DIR}/metrics-${mode}.json\` |`);
say('');
say('## The table');
say('');
say('| # | metric | baseline | this run | sample | note |');
say('|---|---|---|---|---|---|');
for (const m of M) say(`| ${m.n} | ${m.name} | ${m.baselineText} | **${m.measured}** | ${m.sample} | ${m.note} |`);
say('');

say('## Retired metrics -- do not reintroduce');
say('');
say('Two numbers were at 100% before any of this work started, and neither one measures the decompiler. They are not in the table above, and a future run must not add them back as progress indicators.');
say('');
say('| retired metric | value | why it is not progress |');
say('|---|---|---|');
for (const [k, v] of Object.entries(baseline.retiredMetrics)) say(`| ${k} | ${v.value} | ${v.why} |`);
say('');
say('`BASELINE_AUDIT.md` §2.5 and §4.6 are the long form. In one line each: `@babel/generator` cannot print invalid JavaScript from a valid `@babel/types` AST, so parseability is a property of the printer; and opcode coverage counts `case` labels in `src/dataflow.js`, so `JumpLoop` counts as "handled" in a run where every loop is lost. The replacements are metrics 1-4 and 12, which compare the output against the input instead of inspecting the output alone.');
say('');

if (disc.length) {
  say('## Discrepancies with the baseline');
  say('');
  for (const d of disc) say(`- ${d}`);
  say('');
} else {
  say('## Discrepancies with the baseline');
  say('');
  say('None: every metric the dashboard measured on a baseline-identical sample reproduced the baseline number.');
  say('');
}

if (ft && !ft._failed) {
  say('## Oracle self-check');
  say('');
  say('Each oracle has to be shown both that it accepts an identical program and that it rejects a one-token change; without the second, an oracle that always answers "match" passes the first.');
  say('');
  say('| check | result |');
  say('|---|---|');
  say(`| O1 identity (an identity decompiler scores 100% exact) | ${ft.selfcheck.o1IdentityPass ? 'PASS' : 'FAIL'} |`);
  say(`| O1 discrimination (a one-token mutation is not exact) | ${ft.selfcheck.o1DiscriminationPass ? 'PASS' : 'FAIL'} |`);
  say(`| O2 mechanism control (\`cachedDataRejected\` false for the same source, true for a mutated one) | ${ft.selfcheck.o2ControlPass ? 'PASS' : 'FAIL'} |`);
  say(`| O3 identity (the same file twice traces identically) | ${ft.selfcheck.o3IdentityPass ? 'PASS' : 'FAIL'} |`);
  say(`| O3 discrimination (a one-token mutation changes the trace) | ${ft.selfcheck.o3DiscriminationPass ? 'PASS' : 'FAIL'} |`);
  say(`| O3 execution policy (refuses to run \`decompiled_js/\`) | ${ft.selfcheck.o3PolicyRefusesForeignCode ? 'PASS' : 'FAIL'} |`);
  say('');
  say(`Self-check entries: ${ft.selfcheck.entries.join(', ')}.`);
  say('');
  say(`**O1 blind spot, measured.** ${ft.selfcheck.o1BlindSpot.what}: ${ft.selfcheck.o1BlindSpot.why}. Evidence: \`${ft.selfcheck.o1BlindSpot.evidence}\`. Mutations that O1 could not see in this run: ${ft.selfcheck.o1BlindSpot.invisibleMutations.length ? ft.selfcheck.o1BlindSpot.invisibleMutations.map((m) => '`' + m + '`').join(', ') : 'none'}. O3 sees these, which is part of why three oracles are needed rather than one.`);
  say('');
}

if (cf && !cf._failed) {
  say('## 1-3, 10: control flow, bytecode side vs emitted side');
  say('');
  say(`Same files on both sides: ${cf.sample.description}. Bytecode counts come from \`src/deserializer.js\` + \`src/lifter.js\`; emitted counts come from an AST walk, not a regex (a lexical \`while\` also matches inside a string literal).`);
  say('');
  say('| in the bytecode | count | emitted in the output | count |');
  say('|---|---:|---|---:|');
  say(`| \`JumpLoop\` back-edges | ${cf.bytecode.jumpLoop} | loop statements (any kind) | ${cf.emitted.loops} |`);
  say(`| \`ForInNext\` | ${cf.bytecode.forInNext} | \`for-in\` statements | ${cf.emitted.forIn} |`);
  say(`| handler-table ranges | ${cf.bytecode.handlerRanges} | \`try\` statements | ${cf.emitted.try} |`);
  say(`| exception opcodes (\`Throw\`/\`ReThrow\`/\`SetPendingMessage\`) | ${cf.bytecode.exceptionOpcodes} | \`catch\` clauses / \`finally\` blocks | ${cf.emitted.catch} / ${cf.emitted.finally} |`);
  say(`| switch dispatch (\`SwitchOnSmiNoFeedback\`/\`SwitchOnGeneratorState\`) | ${cf.bytecode.switchDispatchOpcodes} | \`switch\` statements | ${cf.emitted.switch} |`);
  say(`| generator suspends (\`SuspendGenerator\`/\`ResumeGenerator\`) | ${cf.bytecode.generatorSuspends} | \`break\` / \`continue\` / labels | ${cf.emitted.break} / ${cf.emitted.continue} / ${cf.emitted.labeled} |`);
  say(`| functions deserialized | ${cf.bytecode.functions} | function declarations / expressions | ${cf.emitted.functionDeclarations} / ${cf.emitted.functionExpressions} |`);
  say(`| instructions | ${cf.bytecode.instructions} | \`if\` statements | ${cf.emitted.if} |`);
  say('');
  say(`Metric 10 markers in the output: \`UNSTRUCTURED\` ${cf.unstructuredMarkers.unstructuredComment}, \`__region\` ${cf.unstructuredMarkers.regionLabel}, \`switch (__state)\` ${cf.unstructuredMarkers.stateDispatch}, \`__state\` ${cf.unstructuredMarkers.stateVar}.`);
  say('');
}

if (id && !id._failed) {
  say('## 5: free identifiers');
  say('');
  say(`${id.sample.description}. ${id.totalFreeReferences} free references, of which ${id.realGlobalReferences} resolve to a real JS/Node/browser global and ${id.inventedReferences} do not. ${id.v8CompileOk}/${id.files} files also compile under \`vm.Script\` (compile only, never executed).`);
  say('');
  say('| invented-name class | distinct names | references | examples |');
  say('|---|---:|---:|---|');
  for (const [c, v] of Object.entries(id.byClass)) say(`| ${c} | ${v.names} | ${v.references} | ${v.examples.map((e) => '`' + e + '`').join(' ')} |`);
  say('');
}

if (hz && !hz._failed) {
  say('## 7-8: semantic hazards');
  say('');
  say(`${hz.sample.description}. ${hz.statements} statements, ${hz.adjacentPairs} adjacent statement pairs, ${hz.fnBodies} function bodies, ${hz.allocNodes} allocation expressions.`);
  say('');
  say(`- metric 7: ${hz.dupSideEffect} pairs where one statement re-evaluates a call made by the previous statement (${hz.metrics.m7_duplicatedSideEffects.pct}%), in ${hz.filesWithDupSideEffect}/${hz.files} files.`);
  say(`- metric 8: ${hz.dupAllocNodes} allocation expressions duplicated inside one function body (${hz.metrics.m8_allocationsLosingIdentity.pct}%), ${hz.dupAllocGroups} distinct groups, worst single allocation re-emitted ${hz.worstDupOfOneAlloc} times, in ${hz.filesWithDupAlloc}/${hz.files} files.`);
  say('');
  if (hz.examples.length) {
    say('Examples of metric 7 (statement, then the statement that repeats it):');
    say('');
    say('```js');
    for (const e of hz.examples.slice(0, 4)) { say(`// ${e.file}`); say(e.stmt); say(e.next); say(''); }
    say('```');
    say('');
  }
}

if (lv && !lv._failed) {
  say('## 6, 11: emission completeness and throughput');
  say('');
  say(`${lv.sample.description}. ${lv.completed}/${lv.attempted} inputs completed within ${lv.timeoutMs} ms and a ${lv.heapMB} MB heap.`);
  say('');
  say('| .jsc | input B | stage | deserialized | emitted | emitted % | decompile ms | ms/KB | archive matches |');
  say('|---|---:|---|---:|---:|---:|---:|---:|---|');
  for (const r of lv.rows) {
    say(`| \`${r.jsc}\` | ${r.inputBytes} | ${r.ok ? 'complete' : (r.errorClass ?? r.stage)} | ${r.deserializedFunctions ?? '-'} | ${r.distinctEmittedNames ?? '-'} | ${r.emittedPct ?? '-'} | ${r.decompileMs ?? '-'} | ${r.msPerInputKB ?? '-'} | ${r.storedMatchesFresh === undefined || r.storedMatchesFresh === null ? '-' : r.storedMatchesFresh} |`);
  }
  say('');
  if (lv.failures.length) {
    say('Failures:');
    say('');
    for (const f of lv.failures) say(`- \`${f.jsc}\`: ${f.stage} ${f.errorClass ?? ''} ${f.error ?? ''}`);
    say('');
  }
  if (lv.baselineSubset.files) {
    say(`Restricted to the ${lv.baselineSubset.files} inputs of \`BASELINE_AUDIT.md\` §3.1 that completed: ${lv.baselineSubset.emitted} / ${lv.baselineSubset.deserialized} = **${lv.baselineSubset.aggregatePct}%** aggregate, ${lv.baselineSubset.medianPct}% median, against the baseline's 5051 / 13030 = 38.76% aggregate and 96.78% median.`);
    say('');
  }
  const tc = lv.throughputControl;
  if (tc?.runs?.length) {
    say(`**Throughput control.** The baseline's metric-11 upper bound, and its argument that cost is not size-driven, both rest on \`${tc.file}\` (${tc.inputBytes} B) taking ${tc.baselineWallMs} ms = ${tc.baselineMsPerKB} ms/KB. Re-measured ${tc.repeats}x here: ${tc.runs.map((r) => `${r.decompileMs} ms`).join(', ')} (${tc.measuredMsPerKB.join(', ')} ms/KB).`);
    say('');
    say('Metric 11 is the one metric in this table that this host cannot measure to better than two orders of magnitude, and the dashboard should not pretend otherwise. Same code, same input, byte-identical output, different load: `r_8305.jsc` is 102 ms in `BASELINE_AUDIT.md` §3.3 and 13 085 ms here; `internal_index.jsc` is 20 635 ms there and ~520 ms on an idle host. The machine has 4 GB with roughly 240 MB free, so a 1.4 GB child pages, and wall-clock time measures the paging. Read metric 11 as a shape (which inputs blow a fixed budget) rather than as a rate, and prefer CPU time over wall time when this metric is next revised.');
    say('');
  }
}

if (ro && !ro._failed) {
  say('## 9: read-only references');
  say('');
  say(`${ro.files} inputs, ${ro.constants} decoded constant-pool entries, ${ro.distinctRefs} distinct \`kReadOnlyHeapRef\` (counted per file) and ${ro.refOccurrences} occurrences.`);
  say('');
  say('| table | distinct resolved | occurrences resolved |');
  say('|---|---|---|');
  say(`| \`${ro.authorityTable}\` (T2, 10299 objects) | ${ro.authority.distinctHits} / ${ro.distinctRefs} | ${ro.authority.occurrenceHits} / ${ro.refOccurrences} |`);
  say(`| \`rules/v8-ro-heap.json\` (legacy, strings only) | ${ro.legacy.distinctHits} / ${ro.distinctRefs} | ${ro.legacy.occurrenceHits} / ${ro.refOccurrences} |`);
  say('');
  const gap = ro.authority.distinctHits - ro.legacy.distinctHits;
  say(`The legacy table is what \`src/dataflow.js\` consults today; the T2 table is the one \`ARCHITECTURE.md\` §3.6 says to use. ${gap === 0
    ? 'On this sample both resolve everything, so metric 9 is not currently a source of unresolved references — the legacy table is unreproducible and strings-only, but it is not the bottleneck for the refs these constant pools actually reach.'
    : `The T2 table resolves ${gap} distinct refs the legacy table misses, which is how much of metric 9 is already solved and merely not wired up.`}`);
  say('');
}

if (ft && !ft._failed) {
  say('## 4, 12: the oracles over `corpus/features/`');
  say('');
  say(`${ft.sample.description}. Pipeline \`${ft.pipeline}\`, minter ${ft.minter.label} (V8 ${ft.minter.v8 ?? '?'}), bytecode engine \`${path.basename(ft.engine)}\`.`);
  say('');
  let corpusCount = null;
  try { corpusCount = JSON.parse(fs.readFileSync('corpus/features/manifest.json', 'utf8')).count; } catch { /* leave it unstated */ }
  say(`All ${corpusCount ?? 'of the'} corpus entries parse, compile to a \`.jsc\` under the same minter and produce a non-empty behavioural trace (\`node corpus/check.mjs\`), so an oracle row that is not \`match\` is a statement about the pipeline, not about the corpus. \`--full\` runs every entry; \`--quick\` samples because the cost is ~20-35 s per entry and, where every cell has the same cause, the remaining entries add no information.`);
  say('');
  say('| oracle | result |');
  say('|---|---|');
  say(`| O1 | ${Object.entries(ft.o1.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')} |`);
  say(`| O2 | ${Object.entries(ft.o2.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')} |`);
  say(`| O3 | ${Object.entries(ft.o3.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')} |`);
  say('');
  say('### Coverage by feature group');
  say('');
  say('| group | entries | O1 match | O2 fixpoint | O3 match | all three |');
  say('|---|---:|---:|---:|---:|---:|');
  for (const [g, v] of Object.entries(ft.metrics.m12_featureCoverage.byGroup).sort()) {
    say(`| ${g} | ${v.entries} | ${v.o1Match} | ${v.o2Fixpoint} | ${v.o3Match} | ${v.allThree} |`);
  }
  say('');
  say('### Per-entry matrix (metric 12)');
  say('');
  say('| id | group | kind | mode | O1 | O2 | O3 |');
  say('|---|---|---|---|---|---|---|');
  for (const c of ft.matrix) say(`| \`${c.id}\` | ${c.group} | ${c.kind} | ${c.mode} | ${c.o1} | ${c.o2} | ${c.o3} |`);
  say('');
}

say('## How to re-run');
say('');
say('```powershell');
say('node corpus/check.mjs                      # the corpus itself must be sound first');
say('node src/verify/run_oracles.mjs --selfcheck # the instruments must pass their own checks');
say('node tools/metrics/run.mjs --quick         # this document');
say('node tools/metrics/run.mjs --full          # wide samples; hours');
say('```');
say('');
say('Per-collector artifacts and logs are in `' + METRICS_DIR + '/`. A collector that fails leaves its log and a `_failed` row rather than taking the run down.');
say('');
say('## Sampling');
say('');
say('| collector | sample | wall |');
say('|---|---|---|');
for (const c of collectors) {
  const d = data[c];
  const desc = d?._failed ? `FAILED (log \`${d._log}\`)` : (d.sample?.description ?? d.sample?.entries ?? '-');
  say(`| ${c} (\`--${d?.mode ?? mode}\`) | ${desc} | ${((d?._wallMs ?? 0) / 1000).toFixed(1)} s |`);
}
say('');
say('A full-corpus re-decompile was estimated at 15-30 h on this host, so no mode decompiles all 1039 inputs. `--quick` uses the baseline\'s own sampling formula where the metric is cheap, so the numbers are directly comparable, and a small named set of inputs where the metric needs the pipeline to run. `--full` widens every sample and makes the liveness set a superset of the baseline\'s 12 inputs, which is the mode to use when comparing metric 6 against the baseline.');
say('');

fs.writeFileSync(DOC, L.join('\n') + '\n', 'utf8');

const artifact = {
  generatedAt: new Date().toISOString(),
  mode, outputsFrom, wallMs,
  host: { platform: os.platform(), arch: os.arch(), totalmemGB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, v8: process.versions.v8 },
  baseline,
  table: M,
  discrepancies: disc,
  collectors: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v])),
};
fs.writeFileSync(path.join(METRICS_DIR, `metrics-${mode}.json`), JSON.stringify(artifact, null, 1));
fs.writeFileSync(path.join(METRICS_DIR, 'latest.json'), JSON.stringify(artifact, null, 1));

console.log('');
for (const m of M) console.log(`  ${String(m.n).padStart(2)}. ${m.name.slice(0, 54).padEnd(56)} baseline=${String(m.baselineText).padEnd(28)} now=${m.measured}`);
console.log('');
console.log(`wrote ${DOC}`);
console.log(`wrote ${path.join(METRICS_DIR, `metrics-${mode}.json`)} and latest.json`);
if (disc.length) { console.log(''); console.log(`${disc.length} discrepancy note(s) with the baseline -- see the generated doc.`); }
