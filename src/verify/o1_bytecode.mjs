// O1 -- bytecode equality.
//
//   original source ──mint──→ .jsc ──pipeline──→ JS'
//          │                                      │
//          └── real V8 --print-bytecode ──→ A     └── real V8 --print-bytecode ──→ B
//                        normalise, pair up functions, compare A vs B
//
// The comparison machinery is T2's (bytecode_parser / normalize / compare);
// this file wires the decompiler into it and reports the number.
//
// Three design points worth stating:
//
//  1. BOTH streams come from a real V8, so O1 does not depend on our own
//     decoder being right. It answers exactly "does the decompiled text
//     compile to the same program the original compiled to".
//
//  2. The engine is d8, not node. Measured (scratch/t3/probe_dump.mjs):
//     `node --print-bytecode` on a 12-line corpus file prints 517 functions
//     (its own bootstrap) against d8's 2. A whole-file comparison needs the
//     listing to contain only the file.
//
//  3. A V8 run EXECUTES the script after printing its bytecode. There is no
//     compile-only mode for --print-bytecode. O1 is therefore restricted to
//     code we wrote (corpus/features/**) and the pipeline's output for it, and
//     assertExecutable() enforces that rather than trusting the caller. O1 for
//     `extracted_jsc/` needs our own decoder for stream A -- that is T4/T5.
//
// Every failure mode is a row, never a throw: mint-failed, pipeline-threw,
// pipeline-timeout, output-unparseable, engine-failed, no-functions.

import fs from 'node:fs';
import path from 'node:path';
import { dumpBytecode } from './oracle.mjs';
import { compareFunctions, lcsLength } from './compare.mjs';
import { mintJsc, resolveMinter, matchingBytecodeEngine } from './mint.mjs';
import { decompileInChild } from './pipeline.mjs';
import { assertExecutable, readSource } from './corpus.mjs';
import { mutations } from './mutate.mjs';

const dice = (lcs, n, m) => (n + m === 0 ? 1 : (2 * lcs) / (n + m));

/**
 * Pair the functions of two normalised dumps.
 * Exact name match first; whatever is left is paired greedily by opcode
 * similarity when both sides are small, else positionally. The mode used is
 * reported, because a number produced by positional pairing means less.
 */
export function pairFunctions(left, right, { maxGreedy = 24 } = {}) {
  const pairs = [];
  const usedR = new Set();
  const leftoverL = [];
  const byName = new Map();
  right.forEach((f, i) => {
    const key = f.name ?? '';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(i);
  });
  let named = 0;
  for (const lf of left) {
    const cands = byName.get(lf.name ?? '');
    const j = cands?.find((k) => !usedR.has(k));
    if (j === undefined) { leftoverL.push(lf); continue; }
    usedR.add(j);
    pairs.push({ left: lf, right: right[j], how: 'name' });
    named++;
  }
  const leftoverR = right.map((f, i) => (usedR.has(i) ? null : { f, i })).filter(Boolean);
  let mode = leftoverL.length === 0 ? 'name' : 'name+positional';
  if (leftoverL.length && leftoverR.length) {
    if (leftoverL.length <= maxGreedy && leftoverR.length <= maxGreedy) {
      mode = named ? 'name+greedy' : 'greedy';
      const taken = new Set();
      for (const lf of leftoverL) {
        let best = -1, bestScore = -1;
        for (const { f, i } of leftoverR) {
          if (taken.has(i)) continue;
          const s = dice(lcsLength(lf.opcodes, f.opcodes), lf.opcodes.length, f.opcodes.length);
          if (s > bestScore) { bestScore = s; best = i; }
        }
        if (best >= 0) { taken.add(best); pairs.push({ left: lf, right: right[best], how: 'greedy' }); }
      }
    } else {
      for (let i = 0; i < Math.min(leftoverL.length, leftoverR.length); i++) {
        pairs.push({ left: leftoverL[i], right: right[leftoverR[i].i], how: 'positional' });
      }
    }
  }
  const pairedR = new Set(pairs.map((p) => p.right));
  return {
    pairs, mode,
    leftOnly: left.filter((f) => !pairs.some((p) => p.left === f)).map((f) => f.name),
    rightOnly: right.filter((f) => !pairedR.has(f)).map((f) => f.name),
  };
}

export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Run O1 for one source.
 * @param {{id, source?, sourcePath, isModule?, deps?}} entry
 */
export function o1One(entry, opts = {}) {
  const work = path.resolve(opts.workDir ?? 'scratch/t3/work/o1');
  fs.mkdirSync(work, { recursive: true });
  const minter = typeof opts.minter === 'object' ? opts.minter : resolveMinter(opts.minter ?? 'auto');
  const engine = opts.engine ?? matchingBytecodeEngine(minter);
  const row = {
    id: entry.id, status: 'ok', minter: minter.label, minterV8: minter.v8 ?? null,
    engine: typeof engine === 'string' ? path.basename(engine) : engine.label,
    isModule: Boolean(entry.isModule),
  };
  const source = entry.source ?? readSource(entry);
  row.sourceBytes = Buffer.byteLength(source, 'utf8');

  // the engine will run this text, so the policy applies
  try { assertExecutable(entry.sourcePath ?? entry.abs ?? entry.file); }
  catch (e) { row.status = 'refused'; row.error = e.message; return row; }

  // 1. mint
  const jscPath = path.join(work, `${entry.id}.jsc`);
  const mint = mintJsc({ source, outPath: jscPath, minter, isModule: entry.isModule, timeoutMs: opts.mintTimeoutMs ?? 120_000 });
  if (!mint.ok) { row.status = 'mint-failed'; row.error = mint.error; return row; }
  row.jscBytes = mint.bytes;
  row.jscHeader = mint.header;

  // 2. decompile, in a child
  const dec = decompileInChild(jscPath, {
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOldSpaceMB: opts.maxOldSpaceMB ?? 1200,
    workDir: work, codePath: path.join(work, `${entry.id}.decompiled.js`), module: opts.pipeline,
  });
  row.pipeline = dec.pipeline;
  row.pipelineStage = dec.stage;
  row.pipelineMs = dec.decompileMs ?? dec.childWallMs ?? null;
  row.deserializedFunctions = dec.deserializedFunctions ?? null;
  row.emittedFunctions = dec.emittedFunctions ?? null;
  if (!dec.ok) {
    row.status = dec.stage === 'timeout' ? 'pipeline-timeout' : 'pipeline-threw';
    row.errorClass = dec.errorClass;
    row.error = dec.error;
    return row;
  }
  row.decompiledPath = dec.codePath;
  row.decompiledBytes = dec.codeBytes;
  if (!dec.outputParses) { row.status = 'output-unparseable'; row.error = dec.outputParseError; return row; }

  // 3 + 4. print bytecode for both sides, with the same engine and flags
  const flags = opts.flags ?? (entry.isModule ? ['--print-bytecode', '--no-lazy', '--no-enable-lazy-source-positions', '--module'] : undefined);
  if (entry.isModule) for (const d of entry.deps ?? []) {
    const from = path.resolve('corpus/features', d);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(work, d));
  }
  let A, B;
  try {
    A = dumpBytecode({ engine, source, workDir: work, name: `${entry.id}.orig`, flags });
    B = dumpBytecode({ engine, file: dec.codePath, workDir: work, name: `${entry.id}.dec`, flags });
  } catch (e) {
    row.status = 'engine-failed';
    row.error = `${e.constructor.name}: ${e.message}`;
    return row;
  }
  row.engineStatus = [A.status, B.status];
  row.functions = [A.normalized.length, B.normalized.length];
  row.unparsedLines = [A.parsed.unparsedLines.length, B.parsed.unparsedLines.length];
  if (A.normalized.length === 0) { row.status = 'engine-no-functions'; row.error = 'the original printed no functions (compile error in the corpus file?)'; return row; }
  if (B.normalized.length === 0) { row.status = 'engine-no-functions'; row.error = 'the decompiled output printed no functions'; return row; }

  // 5. pair + compare
  const { pairs, mode, leftOnly, rightOnly } = pairFunctions(A.normalized, B.normalized);
  row.pairingMode = mode;
  row.leftOnly = leftOnly;
  row.rightOnly = rightOnly;
  const per = [];
  for (const p of pairs) {
    const c = compareFunctions(p.left, p.right);
    per.push({
      name: c.name, how: p.how, exact: c.exactMatch,
      opcodeSimilarity: +c.opcodeSimilarity.toFixed(6),
      instructionSimilarity: +c.instructionSimilarity.toFixed(6),
      instructionCounts: c.instructionCounts,
      prefixMatch: c.prefixMatch,
      firstDivergence: c.firstDivergence ? { index: c.firstDivergence.index, left: c.firstDivergence.left, right: c.firstDivergence.right } : null,
    });
  }
  const sims = per.map((p) => p.opcodeSimilarity);
  row.perFunction = per;
  row.pairedFunctions = per.length;
  row.exactFunctions = per.filter((p) => p.exact).length;
  row.meanOpcodeSimilarity = sims.length ? +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(6) : 0;
  row.medianOpcodeSimilarity = sims.length ? +median(sims).toFixed(6) : 0;
  row.firstDivergence = per.find((p) => p.firstDivergence)?.firstDivergence ?? null;
  row.status = row.exactFunctions === per.length && leftOnly.length === 0 && rightOnly.length === 0 ? 'match' : 'ok';
  return row;
}

/** Aggregate many O1 rows into the metric-4 numbers. */
export function o1Summary(rows) {
  const comparable = rows.filter((r) => r.perFunction && r.perFunction.length);
  const allSims = [];
  for (const r of comparable) for (const p of r.perFunction) allSims.push(p.opcodeSimilarity);
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    entries: rows.length,
    comparableEntries: comparable.length,
    byStatus,
    pairedFunctions: allSims.length,
    exactFunctions: comparable.reduce((a, r) => a + r.exactFunctions, 0),
    entriesFullyMatching: rows.filter((r) => r.status === 'match').length,
    meanOpcodeSimilarity: allSims.length ? +(allSims.reduce((a, b) => a + b, 0) / allSims.length).toFixed(6) : null,
    medianOpcodeSimilarity: allSims.length ? +median(allSims).toFixed(6) : null,
  };
}

// ---------------------------------------------------------------------------
// O1 self-check.
//
// The decompiler is one of four things that can make an O1 row wrong; the
// other three are the engine, the normaliser and the pairing. These two checks
// pin those three down without involving the decompiler at all:
//
//   identity      an "identity decompiler" (output = input source) must score
//                 100% exact on every function. Anything less is an O1 bug.
//   discrimination a one-operator mutation of the same source must NOT score
//                 100%. Without this, an oracle that always says "match"
//                 would pass the identity check.
// ---------------------------------------------------------------------------

/** Compare a source against itself (or against `rightSource`) through O1. */
export function o1Identity(entry, opts = {}) {
  const work = path.resolve(opts.workDir ?? 'scratch/t3/work/o1-self');
  fs.mkdirSync(work, { recursive: true });
  const minter = typeof opts.minter === 'object' ? opts.minter : resolveMinter(opts.minter ?? 'auto');
  const engine = opts.engine ?? matchingBytecodeEngine(minter);
  const left = entry.source ?? readSource(entry);
  const right = opts.rightSource ?? left;
  const flags = entry.isModule ? ['--print-bytecode', '--no-lazy', '--no-enable-lazy-source-positions', '--module'] : undefined;
  const row = { id: entry.id, engine: typeof engine === 'string' ? path.basename(engine) : engine.label };
  try {
    const A = dumpBytecode({ engine, source: left, workDir: work, name: `${entry.id}.self.a`, flags });
    const B = dumpBytecode({ engine, source: right, workDir: work, name: `${entry.id}.self.b`, flags });
    const { pairs, mode, leftOnly, rightOnly } = pairFunctions(A.normalized, B.normalized);
    const per = pairs.map((p) => compareFunctions(p.left, p.right));
    row.functions = [A.normalized.length, B.normalized.length];
    row.pairingMode = mode;
    row.paired = per.length;
    row.exact = per.filter((c) => c.exactMatch).length;
    row.unpaired = leftOnly.length + rightOnly.length;
    const sims = per.map((c) => c.opcodeSimilarity);
    row.meanOpcodeSimilarity = sims.length ? +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(6) : null;
    row.allExact = per.length > 0 && row.exact === per.length && row.unpaired === 0;
    row.firstDivergence = per.find((c) => c.firstDivergence)?.firstDivergence ?? null;
  } catch (e) {
    row.error = `${e.constructor.name}: ${e.message}`;
    row.allExact = false;
  }
  return row;
}

/**
 * Identity + discrimination over a few entries.
 *
 * Discrimination tries mutation candidates until one is visible in the
 * bytecode, and records the ones that were not. That list is not noise -- it
 * is O1's blind spot, measured: V8 prints an array or object literal as
 * `<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS, <FixedArray[3]>>` and
 * never prints the element values, on either engine (verified in
 * scratch/t3/probe_pool.mjs), so a change confined to literal element values
 * does not appear in any listing. O3 sees those; O1 cannot.
 */
export function o1SelfCheck(entries, opts = {}) {
  const identity = [], discrimination = [];
  for (const e of entries) {
    identity.push(o1Identity(e, opts));
    const cands = mutations(readSource(e));
    if (cands.length === 0) { discrimination.push({ id: e.id, mutated: false, reason: 'nothing to mutate' }); continue; }
    const tried = [];
    let detected = null;
    for (const cand of cands.slice(0, 4)) {
      const r = o1Identity({ ...e, id: e.id + '-mut' }, { ...opts, rightSource: cand.src });
      tried.push({ mutation: cand.label, allExact: r.allExact, meanOpcodeSimilarity: r.meanOpcodeSimilarity });
      if (r.allExact === false) { detected = { ...cand, firstDivergence: r.firstDivergence, meanOpcodeSimilarity: r.meanOpcodeSimilarity }; break; }
    }
    discrimination.push({
      id: e.id, mutated: true, tried,
      mutation: detected ? detected.label : null,
      invisibleMutations: tried.filter((t) => t.allExact === true).map((t) => t.mutation),
      meanOpcodeSimilarity: detected ? detected.meanOpcodeSimilarity : null,
      detectedChange: Boolean(detected),
      firstDivergence: detected ? detected.firstDivergence : null,
    });
  }
  const disc = discrimination.filter((d) => d.mutated);
  return {
    identity, discrimination,
    identityPass: identity.length > 0 && identity.every((r) => r.allExact),
    discriminationPass: disc.length > 0 && disc.every((d) => d.detectedChange),
    blindSpot: {
      what: 'values inside boilerplate constants (array / object literals)',
      why: 'V8 prints the boilerplate descriptor, never the element values -- on node (pool dumped) as well as d8 (pool partial)',
      evidence: 'scratch/t3/probe_pool.mjs',
      invisibleMutations: disc.flatMap((d) => d.invisibleMutations.map((m) => `${d.id}: ${m}`)),
    },
  };
}
