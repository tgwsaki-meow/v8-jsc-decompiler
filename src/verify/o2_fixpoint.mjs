// O2 -- round-trip fixpoint.
//
//   .jsc ──pipeline──→ code1 ──mint──→ .jsc' ──pipeline──→ code2
//   code1 must equal code2, byte for byte.
//
// What it catches that O1 cannot: instability and state leaking between runs
// (a decompiler whose output depends on a cache, a counter, a Map iteration
// order or the order functions happen to be visited). O2 says nothing about
// correctness -- a decompiler that emits `0;` for everything has a perfect
// fixpoint -- so it is only ever read next to O1.
//
// It is also the cheapest check that the output is *compilable*: step 3 cannot
// mint a .jsc from code1 unless V8 accepts code1.
//
// Negative control (mint.cachedDataControl): V8 sets cachedDataRejected=true
// when cached data is handed to a source it was not produced from, so the
// "same source -> false, mutated source -> true" pair proves the round-trip
// mechanism is actually checking the source and not silently accepting
// anything. Reported alongside, not mixed into, the fixpoint result.
//
// O2 never executes anything: minting compiles only.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { mintJsc, resolveMinter, cachedDataControl } from './mint.mjs';
import { decompileInChild } from './pipeline.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) {
    return { offset: i, left: a.slice(Math.max(0, i - 40), i + 40), right: b.slice(Math.max(0, i - 40), i + 40) };
  }
  return { offset: n, left: a.slice(n, n + 80), right: b.slice(n, n + 80), note: 'one output is a prefix of the other' };
}

/**
 * One fixpoint check. Either give it a `.jsc` (`jscPath`) or a source to mint
 * one from (`source` / `sourcePath`).
 */
export function o2One(entry, opts = {}) {
  const work = path.resolve(opts.workDir ?? 'scratch/t3/work/o2');
  fs.mkdirSync(work, { recursive: true });
  const minter = typeof opts.minter === 'object' ? opts.minter : resolveMinter(opts.minter ?? 'auto');
  const row = { id: entry.id, status: 'ok', minter: minter.label, minterV8: minter.v8 ?? null };
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOldSpaceMB = opts.maxOldSpaceMB ?? 1200;

  // round 0: the input .jsc
  let jsc0 = entry.jscPath;
  if (!jsc0) {
    const source = entry.source ?? fs.readFileSync(entry.sourcePath ?? entry.abs ?? entry.file, 'utf8');
    const m = mintJsc({ source, outPath: path.join(work, `${entry.id}.0.jsc`), minter, isModule: entry.isModule });
    if (!m.ok) { row.status = 'mint-failed'; row.error = m.error; return row; }
    jsc0 = m.jscPath;
    row.jsc0Bytes = m.bytes;
  } else {
    row.jsc0Bytes = fs.statSync(jsc0).size;
  }

  // round 1: decompile
  const d1 = decompileInChild(jsc0, { timeoutMs, maxOldSpaceMB, workDir: work, codePath: path.join(work, `${entry.id}.1.js`), module: opts.pipeline });
  row.pipeline = d1.pipeline;
  if (!d1.ok) {
    row.status = d1.stage === 'timeout' ? 'pipeline-timeout' : 'pipeline-threw';
    row.round = 1; row.errorClass = d1.errorClass; row.error = d1.error;
    return row;
  }
  const code1 = fs.readFileSync(d1.codePath, 'utf8');
  row.code1Bytes = Buffer.byteLength(code1, 'utf8');
  row.code1Sha = sha(code1).slice(0, 16);
  row.code1Functions = d1.emittedFunctions ?? null;

  // round 2: recompile code1 -> .jsc, decompile again
  const m2 = mintJsc({ source: code1, outPath: path.join(work, `${entry.id}.1.jsc`), minter });
  if (!m2.ok) { row.status = 'recompile-failed'; row.error = m2.error; return row; }
  row.jsc1Bytes = m2.bytes;
  row.recompiledSourceLengthMatches = m2.sourceLengthMatches;

  const d2 = decompileInChild(m2.jscPath, { timeoutMs, maxOldSpaceMB, workDir: work, codePath: path.join(work, `${entry.id}.2.js`), module: opts.pipeline });
  if (!d2.ok) {
    row.status = d2.stage === 'timeout' ? 'pipeline-timeout' : 'pipeline-threw';
    row.round = 2; row.errorClass = d2.errorClass; row.error = d2.error;
    return row;
  }
  const code2 = fs.readFileSync(d2.codePath, 'utf8');
  row.code2Bytes = Buffer.byteLength(code2, 'utf8');
  row.code2Sha = sha(code2).slice(0, 16);
  row.code2Functions = d2.emittedFunctions ?? null;

  row.stable = code1 === code2;
  row.status = row.stable ? 'fixpoint' : 'unstable';
  if (!row.stable) row.firstDifference = firstDifference(code1, code2);
  return row;
}

/** The mechanism check, run once per O2 batch. */
export function o2Control() {
  const c = cachedDataControl('function f(a){return a+1;} f(1);');
  return { ...c, meaning: 'cachedDataRejected must be false for the same source and true for a mutated one' };
}

export function o2Summary(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const reached = rows.filter((r) => r.stable !== undefined);
  return {
    entries: rows.length,
    byStatus,
    reachedComparison: reached.length,
    stable: reached.filter((r) => r.stable).length,
    unstable: reached.filter((r) => !r.stable).length,
    stabilityPct: reached.length ? +(100 * reached.filter((r) => r.stable).length / reached.length).toFixed(2) : null,
  };
}
