#!/usr/bin/env node
// CLI for the three oracles.
//
//   node src/verify/run_oracles.mjs --selfcheck
//   node src/verify/run_oracles.mjs --all --sample 24
//   node src/verify/run_oracles.mjs --o1 --grep '^try-'
//   node src/verify/run_oracles.mjs --o3 --group class --keep-traces
//
// Flags
//   --o1 --o2 --o3 --all       which oracles (default: --all)
//   --sample N                 stratified sample of N corpus entries
//   --grep RE / --group G      filter entries
//   --include-heavy            include the ~390 KB scale-extrawide entry
//   --minter SPEC              auto | node | electron | <path>   (default auto)
//   --engine PATH              --print-bytecode engine (default: the d8 that
//                              matches the minter)
//   --pipeline MODULE          decompiler under test (default src/decompiler.js
//                              or $V8D_PIPELINE)
//   --timeout MS               per-file pipeline budget (default 120000)
//   --out DIR                  JSON artifacts (default scratch/t3/oracles)
//
// Results are always written as JSON; stdout is a summary. Output is never
// piped: redirect it to a file.

import fs from 'node:fs';
import path from 'node:path';
import { loadEntries, stratify } from './corpus.mjs';
import { resolveMinter, matchingBytecodeEngine, findElectron, findD8 } from './mint.mjs';
import { o1One, o1Summary, o1SelfCheck } from './o1_bytecode.mjs';
import { o2One, o2Summary, o2Control } from './o2_fixpoint.mjs';
import { o3One, o3Summary, o3SelfCheck } from './o3_behaviour.mjs';
import { pipelineId } from './pipeline.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const want = { o1: has('--o1'), o2: has('--o2'), o3: has('--o3') };
if (has('--all') || (!want.o1 && !want.o2 && !want.o3)) { want.o1 = want.o2 = want.o3 = true; }

const OUT = path.resolve(val('--out', 'scratch/t3/oracles'));
fs.mkdirSync(OUT, { recursive: true });

const opts = {
  minter: resolveMinter(val('--minter', 'auto')),
  pipeline: val('--pipeline', undefined),
  timeoutMs: Number(val('--timeout', '120000')),
  keepTraces: has('--keep-traces'),
};
opts.engine = val('--engine', matchingBytecodeEngine(opts.minter));

let entries = loadEntries({ grep: val('--grep', undefined), groups: has('--group') ? [val('--group')] : undefined });
if (!has('--include-heavy')) entries = entries.filter((e) => !e.heavy);
const sampleN = has('--sample') ? Number(val('--sample')) : 0;
if (sampleN) entries = stratify(entries, sampleN);

const header = {
  generatedAt: new Date().toISOString(),
  pipeline: pipelineId(opts.pipeline),
  minter: { label: opts.minter.label, v8: opts.minter.v8, kind: opts.minter.kind },
  engine: String(opts.engine),
  electronFound: Boolean(findElectron()),
  d8Found: Boolean(findD8()),
  entries: entries.length,
  node: process.version,
  localV8: process.versions.v8,
};
console.log(`pipeline : ${header.pipeline}`);
console.log(`minter   : ${header.minter.label} (V8 ${header.minter.v8 ?? '?'})`);
console.log(`engine   : ${header.engine}`);
console.log(`entries  : ${entries.length}`);

if (has('--selfcheck')) {
  const sample = stratify(entries.filter((e) => e.scriptOrModule === 'script'), Number(val('--selfcheck-n', '6')));
  console.log(`\n== self-check on ${sample.length} entries: ${sample.map((e) => e.id).join(', ')}`);

  const o1 = o1SelfCheck(sample, opts);
  console.log('\nO1 identity (an identity decompiler must be 100% exact):');
  for (const r of o1.identity) console.log(`  ${r.id.padEnd(28)} fns=${(r.functions ?? []).join('/')} paired=${r.paired} exact=${r.exact} unpaired=${r.unpaired} pairing=${r.pairingMode} -> ${r.allExact ? 'PASS' : 'FAIL ' + (r.error ?? '')}`);
  console.log(`  identity: ${o1.identityPass ? 'PASS' : 'FAIL'}`);
  console.log('O1 discrimination (a one-token mutation must NOT be exact):');
  for (const r of o1.discrimination) console.log(`  ${r.id.padEnd(28)} ${r.mutated ? `[${r.mutation ?? 'none visible'}]`.padEnd(26) : 'SKIP (nothing to mutate)'.padEnd(26)} tried=${r.mutated ? r.tried.length : 0} -> ${r.mutated ? (r.detectedChange ? 'PASS' : 'FAIL') : 'SKIP'}`);
  console.log(`  discrimination: ${o1.discriminationPass ? 'PASS' : 'FAIL'}`);
  if (o1.blindSpot.invisibleMutations.length) {
    console.log(`  known blind spot (${o1.blindSpot.what}): ${o1.blindSpot.invisibleMutations.join('; ')}`);
  }

  const ctl = o2Control();
  console.log('\nO2 mechanism control (vm.Script cachedData):');
  console.log(`  same source rejected=${ctl.sameSourceRejected} (expect false), mutated source rejected=${ctl.mutatedSourceRejected} (expect true) -> ${ctl.controlPasses ? 'PASS' : 'FAIL'}`);

  const o3 = o3SelfCheck(sample, opts);
  console.log('\nO3 identity (same file twice must trace identically):');
  for (const r of o3.identity) console.log(`  ${r.id.padEnd(28)} status=${r.status.join('/')} records=${r.records} equal=${r.equal} -> ${r.equal ? 'PASS' : 'FAIL'}`);
  console.log(`  identity: ${o3.identityPass ? 'PASS' : 'FAIL'}`);
  console.log('O3 discrimination (a one-token mutation must change the trace):');
  for (const r of o3.discrimination) console.log(`  ${r.id.padEnd(28)} ${r.mutated ? `[${r.mutation ?? r.tried.map((t) => t.mutation).join(',')}]`.padEnd(30) : 'SKIP (nothing to mutate)'.padEnd(30)} -> ${r.mutated ? (r.detectedChange ? 'PASS' : 'FAIL (no observable mutation found)') : 'SKIP'}`);
  console.log(`  discrimination: ${o3.discriminationPass ? 'PASS' : 'FAIL'}`);
  console.log(`O3 execution policy: refuses decompiled_js/ = ${o3.policy.refusesForeignCode} -> ${o3.policy.refusesForeignCode ? 'PASS' : 'FAIL'}`);

  const all = o1.identityPass && o1.discriminationPass && ctl.controlPasses && o3.identityPass && o3.discriminationPass && o3.policy.refusesForeignCode;
  const doc = { header, o1, o2Control: ctl, o3, pass: all };
  fs.writeFileSync(path.join(OUT, 'selfcheck.json'), JSON.stringify(doc, null, 1));
  console.log(`\nSELF-CHECK: ${all ? 'ALL CHECKS PASSED' : 'FAILURES ABOVE'}`);
  console.log(`wrote ${path.join(OUT, 'selfcheck.json')}`);
  process.exitCode = all ? 0 : 1;
} else {
  const result = { header };

  if (want.o1) {
    const rows = [];
    for (const e of entries) {
      const row = o1One({ ...e, isModule: e.scriptOrModule === 'module', sourcePath: e.abs }, opts);
      rows.push(row);
      process.stderr.write(`O1 ${e.id.padEnd(32)} ${row.status.padEnd(18)} fns=${(row.functions ?? []).join('/')} paired=${row.pairedFunctions ?? '-'} exact=${row.exactFunctions ?? '-'} mean=${row.meanOpcodeSimilarity ?? '-'}\n`);
    }
    result.o1 = { summary: o1Summary(rows), rows };
    console.log(`\nO1 ${JSON.stringify(result.o1.summary, null, 1)}`);
  }
  if (want.o2) {
    const rows = [];
    for (const e of entries) {
      const row = o2One({ ...e, isModule: e.scriptOrModule === 'module', sourcePath: e.abs }, opts);
      rows.push(row);
      process.stderr.write(`O2 ${e.id.padEnd(32)} ${row.status.padEnd(18)} ${row.code1Sha ?? ''} ${row.code2Sha ?? ''}\n`);
    }
    result.o2 = { summary: o2Summary(rows), control: o2Control(), rows };
    console.log(`\nO2 ${JSON.stringify(result.o2.summary, null, 1)}`);
  }
  if (want.o3) {
    const rows = [];
    for (const e of entries) {
      const row = o3One(e, opts);
      rows.push(row);
      process.stderr.write(`O3 ${e.id.padEnd(32)} ${row.status.padEnd(22)} traces=${(row.traceCounts ?? []).join('/')}\n`);
    }
    result.o3 = { summary: o3Summary(rows), rows };
    console.log(`\nO3 ${JSON.stringify(result.o3.summary, null, 1)}`);
  }

  const out = path.join(OUT, 'oracles.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`\nwrote ${out}`);
}
