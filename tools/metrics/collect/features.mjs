#!/usr/bin/env node
// Metrics 4 and 12: the three oracles over corpus/features/.
//
//   4   O1 opcode-sequence match %, per function, mean and median
//   12  the feature-coverage matrix: one pass/fail cell per corpus entry per
//       oracle, which is the operational definition of "complete"
//
// Every oracle degrades into a row. An entry that the pipeline cannot even
// ingest is `pipeline-threw`, not a crash and not a silent zero, and the
// status histogram is reported next to the percentages so a 0% match cannot be
// mistaken for 0% correctness when the real story is "never got that far".
//
// Usage: node tools/metrics/collect/features.mjs --mode quick --out <json>
import fs from 'node:fs';
import path from 'node:path';
import { loadEntries, stratify } from '../../../src/verify/corpus.mjs';
import { resolveMinter, matchingBytecodeEngine, findElectron, findD8 } from '../../../src/verify/mint.mjs';
import { o1One, o1Summary, o1SelfCheck } from '../../../src/verify/o1_bytecode.mjs';
import { o2One, o2Summary, o2Control } from '../../../src/verify/o2_fixpoint.mjs';
import { o3One, o3Summary, o3SelfCheck } from '../../../src/verify/o3_behaviour.mjs';
import { pipelineId } from '../../../src/verify/pipeline.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const mode = val('--mode', 'quick');
const outPath = val('--out', `scratch/t3/metrics/features.${mode}.json`);
const sampleN = Number(val('--sample', mode === 'full' ? '0' : '24'));

const opts = {
  minter: resolveMinter(val('--minter', 'auto')),
  timeoutMs: Number(val('--timeout', '60000')),
  workDir: 'scratch/t3/work/metrics-features',
};
opts.engine = val('--engine', matchingBytecodeEngine(opts.minter));

let entries = loadEntries();
if (mode !== 'full') entries = entries.filter((e) => !e.heavy);
if (sampleN) {
  // Stratified round-robin over the feature groups, PLUS every entry of the
  // `flat` group. `flat` is the group with no function literal, which is the
  // only shape the current deserializer can read at all (FINDINGS.md §1), so
  // without it metric 4 has no measurable entry and the dashboard can only
  // report "pipeline-threw". When a pipeline can ingest everything, `flat`
  // contributes its entries like any other group and this union is a no-op
  // beyond sample size.
  const sampled = stratify(entries, sampleN);
  const ids = new Set(sampled.map((e) => e.id));
  entries = [...sampled, ...entries.filter((e) => e.group === 'flat' && !ids.has(e.id))];
}

const prepared = entries.map((e) => ({ ...e, isModule: e.scriptOrModule === 'module', sourcePath: e.abs }));

process.stderr.write(`features: ${prepared.length} entries, pipeline ${pipelineId()}, minter ${opts.minter.label}, engine ${path.basename(String(opts.engine))}\n`);

const selfcheckEntries = stratify(prepared.filter((e) => !e.isModule), 4);
const selfcheck = {
  o1: o1SelfCheck(selfcheckEntries, opts),
  o2: o2Control(),
  o3: o3SelfCheck(selfcheckEntries, opts),
};

const o1Rows = [], o2Rows = [], o3Rows = [];
for (const e of prepared) {
  const r1 = o1One(e, opts);
  const r2 = o2One(e, opts);
  const r3 = o3One(e, opts);
  o1Rows.push(r1); o2Rows.push(r2); o3Rows.push(r3);
  process.stderr.write(`${e.id.padEnd(32)} O1=${r1.status.padEnd(18)} O2=${r2.status.padEnd(16)} O3=${r3.status}\n`);
}

const byId = new Map();
for (const e of prepared) byId.set(e.id, { id: e.id, group: e.group, feature: e.feature, kind: e.scriptOrModule, mode: e.sloppyOrStrict });
for (const r of o1Rows) Object.assign(byId.get(r.id), { o1: r.status, o1Mean: r.meanOpcodeSimilarity ?? null, o1Paired: r.pairedFunctions ?? null, o1Exact: r.exactFunctions ?? null, o1Error: r.error ?? null });
for (const r of o2Rows) Object.assign(byId.get(r.id), { o2: r.status, o2Stable: r.stable ?? null });
for (const r of o3Rows) Object.assign(byId.get(r.id), { o3: r.status, o3Traces: r.traceCounts ?? null });

const matrix = [...byId.values()];
const pass = (c) => c.o1 === 'match' && c.o2 === 'fixpoint' && c.o3 === 'match';
const groups = {};
for (const c of matrix) {
  groups[c.group] ??= { entries: 0, o1Match: 0, o2Fixpoint: 0, o3Match: 0, allThree: 0 };
  const g = groups[c.group];
  g.entries++;
  if (c.o1 === 'match') g.o1Match++;
  if (c.o2 === 'fixpoint') g.o2Fixpoint++;
  if (c.o3 === 'match') g.o3Match++;
  if (pass(c)) g.allThree++;
}

const result = {
  collector: 'features',
  generatedAt: new Date().toISOString(),
  mode,
  pipeline: pipelineId(),
  minter: { label: opts.minter.label, v8: opts.minter.v8 },
  engine: String(opts.engine),
  electronFound: Boolean(findElectron()),
  d8Found: Boolean(findD8()),
  sample: {
    entries: prepared.length,
    description: sampleN
      ? `stratified sample of ${sampleN} corpus entries, round-robin over the ${new Set(prepared.map((e) => e.group)).size} feature groups, heavy entries excluded, plus every \`flat\` entry (the only shape the current pipeline can ingest) -- ${prepared.length} entries in total`
      : 'every corpus entry',
    ids: prepared.map((e) => e.id),
  },
  selfcheck: {
    o1IdentityPass: selfcheck.o1.identityPass,
    o1DiscriminationPass: selfcheck.o1.discriminationPass,
    o1BlindSpot: selfcheck.o1.blindSpot,
    o2ControlPass: selfcheck.o2.controlPasses,
    o3IdentityPass: selfcheck.o3.identityPass,
    o3DiscriminationPass: selfcheck.o3.discriminationPass,
    o3PolicyRefusesForeignCode: selfcheck.o3.policy.refusesForeignCode,
    entries: selfcheckEntries.map((e) => e.id),
    detail: selfcheck,
  },
  o1: o1Summary(o1Rows),
  o2: o2Summary(o2Rows),
  o3: o3Summary(o3Rows),
  metrics: {
    m4_o1OpcodeMatch: {
      mean: o1Summary(o1Rows).meanOpcodeSimilarity,
      median: o1Summary(o1Rows).medianOpcodeSimilarity,
      pairedFunctions: o1Summary(o1Rows).pairedFunctions,
      comparableEntries: o1Summary(o1Rows).comparableEntries,
      entries: o1Rows.length,
      statusHistogram: o1Summary(o1Rows).byStatus,
    },
    m12_featureCoverage: {
      entries: matrix.length,
      o1Match: matrix.filter((c) => c.o1 === 'match').length,
      o2Fixpoint: matrix.filter((c) => c.o2 === 'fixpoint').length,
      o3Match: matrix.filter((c) => c.o3 === 'match').length,
      allThree: matrix.filter(pass).length,
      byGroup: groups,
    },
  },
  matrix,
  rows: { o1: o1Rows, o2: o2Rows, o3: o3Rows },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
