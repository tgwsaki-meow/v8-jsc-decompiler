#!/usr/bin/env node
// Metrics 6 and 11, plus the check the rest of the dashboard depends on.
//
//   6  functions emitted / functions deserialized, counted from the emitted
//      AST: every function-like node, at any depth, including expressions and
//      arrows.
//
//      It used to count DISTINCT names matching `main|func_<n>`, which was an
//      exact count only for the retired emitter, because that emitter named
//      every function that way. Any emitter using the SFI's real name scored
//      0, so metric 6 read 0% for a pipeline that in fact emitted 100%. The
//      numerator was measuring the emitter's naming convention, not its
//      coverage.
//
//   11 throughput, ms per input KB.
//
//   plus: fresh output vs the stored decompiled_js/*.js (sha256 and distinct
//      function names). The other collectors read the stored archive as "the
//      current pipeline's output"; that is only legitimate while the archive
//      still matches, and BASELINE_AUDIT.md 3.5 found 2 of 10 files where it
//      does not. The dashboard re-checks instead of assuming.
//
// Usage: node tools/metrics/collect/liveness.mjs --mode quick --out <json>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';
import { decompileInChild } from '../../../src/verify/pipeline.mjs';
import { livenessSample } from '../samples.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const mode = val('--mode', 'quick');
const outPath = val('--out', `scratch/t3/metrics/liveness.${mode}.json`);
const timeoutMs = Number(val('--timeout', mode === 'full' ? '180000' : '90000'));
const heapMB = Number(val('--heap', '1400'));

const sample = livenessSample(mode);
const work = 'scratch/t3/work/metrics-live';
fs.mkdirSync(work, { recursive: true });

/**
 * How many functions the emitted text actually contains.
 *
 * This used to be `/\bfunction\s*\*?\s+(main|func_\d+)\b/g` -- the retired
 * emitter named every function `main` or `func_<n>`, so the count was really
 * "how many functions did THAT emitter emit". Any emitter using the SFI's real
 * name scored 0, which made metric 6 (functions emitted / functions
 * deserialized) read 0% for a pipeline emitting 100%. The denominator was
 * right the whole time, so the metric was anti-correlated with the thing it
 * was supposed to measure.
 *
 * Counted from the AST rather than by regex, for the reason control_flow.mjs
 * gives for its own counts: a lexical `function` also matches inside a string
 * or a comment. Function *expressions* and arrows count -- `var f = () => {}`
 * is a function in the output -- so this is every function-like node, which is
 * the quantity the denominator (`deserializedFunctions`, every SFI with
 * bytecode) is comparable to.
 *
 * The regex is kept as the fallback, because the collector measures pipelines
 * under development and must report a number for output that does not parse
 * rather than crash. When that happens the row says so.
 */
const FUNCTION_LIKE = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);
const FALLBACK_RE = /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(|=>/g;

const countFunctions = (src) => {
  try {
    const ast = parse(src, {
      sourceType: 'unambiguous', attachComment: false, tokens: false, ranges: false,
    });
    let n = 0;
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node.type !== 'string') return;
      if (FUNCTION_LIKE.has(node.type)) n++;
      for (const k in node) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
        const v = node[k];
        if (v && typeof v === 'object') walk(v);
      }
    }(ast.program));
    return { count: n, parsed: true };
  } catch (e) {
    const m = src.match(FALLBACK_RE);
    return { count: m ? m.length : 0, parsed: false, parseError: String(e.message).slice(0, 200) };
  }
};

const rows = [];
for (const f of sample.files) {
  const row = { jsc: f.name, inputBytes: f.size, isBaselineFile: (sample.baselineNames ?? []).includes(f.name) };
  const d = decompileInChild(f.path, { timeoutMs, maxOldSpaceMB: heapMB, workDir: work, codePath: path.join(work, f.name + '.out.js') });
  row.ok = d.ok;
  row.stage = d.stage;
  row.errorClass = d.errorClass ?? null;
  row.error = d.error ? String(d.error).slice(0, 200) : null;
  row.deserializedFunctions = d.deserializedFunctions ?? null;
  row.deserializeMs = d.deserializeMs ?? null;
  row.decompileMs = d.decompileMs ?? null;
  row.wallMs = d.childWallMs ?? null;
  row.rssPeakMB = d.rssPeakMB ?? null;
  if (d.ok && d.codePath && fs.existsSync(d.codePath)) {
    const src = fs.readFileSync(d.codePath, 'utf8');
    row.outputBytes = Buffer.byteLength(src, 'utf8');
    const counted = countFunctions(src);
    row.emittedFunctionCount = counted.count;
    // kept under the old name so a stored report stays comparable, but it is
    // no longer "distinct names matching the retired emitter's convention"
    row.distinctEmittedNames = counted.count;
    row.outputCountedFromAst = counted.parsed;
    if (!counted.parsed) row.outputParseError = counted.parseError;
    row.topLevelFunctions = d.emittedFunctions ?? null;
    row.outputParses = d.outputParses ?? null;
    row.freshSha = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
    row.emittedPct = row.deserializedFunctions ? +(100 * row.emittedFunctionCount / row.deserializedFunctions).toFixed(2) : null;
    row.msPerInputKB = row.decompileMs !== null ? +(row.decompileMs / (f.size / 1024)).toFixed(1) : null;
    const stored = path.join('decompiled_js', f.name.replace(/\.jsc$/, '.js'));
    if (fs.existsSync(stored)) {
      const st = fs.statSync(stored);
      row.storedBytes = st.size;
      if (st.size < 40_000_000) {
        const s = fs.readFileSync(stored, 'utf8');
        row.storedSha = crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
        row.storedDistinctEmittedNames = countFunctions(s).count;
        row.storedMatchesFresh = row.storedSha === row.freshSha;
      } else {
        row.storedSha = null;
        row.storedMatchesFresh = null;
        row.storedNote = 'too large to hash on this host';
      }
    }
  }
  rows.push(row);
  process.stderr.write(`${row.jsc.padEnd(34)} ${row.ok ? 'ok     ' : (row.stage ?? 'fail').padEnd(7)} deser=${row.deserializedFunctions ?? '-'} emitted=${row.distinctEmittedNames ?? '-'} (${row.emittedPct ?? '-'}%) ${row.decompileMs ?? '-'}ms ${row.msPerInputKB ?? '-'}ms/KB stored=${row.storedMatchesFresh ?? '-'}\n`);
}

// Throughput control. BASELINE_AUDIT.md 3.3's headline for metric 11 is
// "5,975 ms per input KB" for internal_index.jsc -- a 3.4 KB input taking
// ~20.6 s, which is the evidence for "cost is not size-driven". The same audit
// warns that its wall times are noisy (3.3 and the threats list: the same file
// measured 95,934 ms in a batch and 34,638 ms idle). So measure that one input
// several times and report the spread instead of arguing about it.
const controlName = val('--control', 'internal_index.jsc');
const controlFile = sample.files.find((f) => f.name === controlName)
  ?? { name: controlName, path: path.join('extracted_jsc', controlName), size: fs.existsSync(path.join('extracted_jsc', controlName)) ? fs.statSync(path.join('extracted_jsc', controlName)).size : 0 };
const repeats = Number(val('--repeats', '3'));
const controlRuns = [];
if (fs.existsSync(controlFile.path)) {
  for (let i = 0; i < repeats; i++) {
    const d = decompileInChild(controlFile.path, { timeoutMs, maxOldSpaceMB: heapMB, workDir: work, codePath: path.join(work, `${controlFile.name}.ctl${i}.js`) });
    controlRuns.push({ run: i, ok: d.ok, decompileMs: d.decompileMs ?? null, wallMs: d.childWallMs ?? null,
      msPerInputKB: d.decompileMs != null ? +(d.decompileMs / (controlFile.size / 1024)).toFixed(1) : null });
  }
  process.stderr.write(`throughput control ${controlFile.name} (${controlFile.size} B) x${repeats}: ${controlRuns.map((r) => `${r.decompileMs}ms`).join(' ')}\n`);
}

const done = rows.filter((r) => r.ok);
const agg = (list) => {
  const d = list.reduce((a, r) => a + (r.deserializedFunctions ?? 0), 0);
  const e = list.reduce((a, r) => a + (r.distinctEmittedNames ?? 0), 0);
  const pcts = list.map((r) => r.emittedPct).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  const med = pcts.length ? (pcts.length % 2 ? pcts[pcts.length >> 1] : (pcts[(pcts.length >> 1) - 1] + pcts[pcts.length >> 1]) / 2) : null;
  return { files: list.length, deserialized: d, emitted: e, aggregatePct: d ? +(100 * e / d).toFixed(2) : null, medianPct: med };
};
const rates = done.map((r) => r.msPerInputKB).filter((x) => x !== null).sort((a, b) => a - b);

const result = {
  collector: 'liveness',
  generatedAt: new Date().toISOString(),
  mode, timeoutMs, heapMB,
  sample: { ...sample, files: sample.files.map((f) => ({ name: f.name, size: f.size })) },
  attempted: rows.length,
  completed: done.length,
  failures: rows.filter((r) => !r.ok).map((r) => ({ jsc: r.jsc, stage: r.stage, errorClass: r.errorClass, error: r.error })),
  all: agg(done),
  baselineSubset: agg(done.filter((r) => r.isBaselineFile)),
  throughputControl: {
    file: controlFile.name, inputBytes: controlFile.size, repeats: controlRuns.length, runs: controlRuns,
    baselineMsPerKB: 5975,
    baselineWallMs: 20635,
    measuredMsPerKB: controlRuns.filter((r) => r.msPerInputKB != null).map((r) => r.msPerInputKB),
    note: 'BASELINE_AUDIT.md 3.3 reports 20,635 ms / 5,975 ms per KB for this input and uses it as the evidence that cost is not size-driven; the same section warns its wall times are load-dependent',
  },
  storedArchive: {
    compared: rows.filter((r) => r.storedMatchesFresh !== undefined && r.storedMatchesFresh !== null).length,
    identical: rows.filter((r) => r.storedMatchesFresh === true).length,
    differing: rows.filter((r) => r.storedMatchesFresh === false).map((r) => ({ jsc: r.jsc, freshBytes: r.outputBytes, storedBytes: r.storedBytes, freshNames: r.distinctEmittedNames, storedNames: r.storedDistinctEmittedNames })),
  },
  metrics: {
    m6_functionsEmittedPerDeserialized: agg(done),
    m11_msPerInputKB: { min: rates[0] ?? null, max: rates[rates.length - 1] ?? null,
      median: rates.length ? (rates.length % 2 ? rates[rates.length >> 1] : (rates[(rates.length >> 1) - 1] + rates[rates.length >> 1]) / 2) : null,
      spreadRatio: rates.length && rates[0] ? +(rates[rates.length - 1] / rates[0]).toFixed(0) : null },
  },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
