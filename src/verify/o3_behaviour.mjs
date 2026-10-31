// O3 -- behavioural differential, corpus only.
//
//   corpus file ──run in an instrumented vm context──→ trace A
//        └──mint──→ .jsc ──pipeline──→ JS' ──run, same way──→ trace B
//                          trace A must equal trace B
//
// The trace is the ordered list of observable effects: every T(label, ...)
// call the file makes, every property write and call routed through G, every
// console.*, the completion value and anything that escaped as a throw. See
// trace.mjs for the serialisation contract.
//
// THE CONSTRAINT, stated here because it is the whole reason O3 is scoped the
// way it is: O3 ONLY EVER RUNS corpus/features/ CODE. `extracted_jsc/` and
// `decompiled_js/` are reverse-engineered third-party code from a chat client;
// this project reads, parses and disassembles them and never executes them.
// The rule is enforced in corpus.mjs assertExecutable() and checked again
// inside the child, not merely written down here.
//
// Each side runs in its own process (src/verify/o3_child.mjs), so an infinite
// loop in a bad decompilation costs one row and a timeout.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareTraces, traceText } from './trace.mjs';
import { mutations } from './mutate.mjs';
import { mintJsc, resolveMinter } from './mint.mjs';
import { decompileInChild } from './pipeline.mjs';
import { assertExecutable, readSource } from './corpus.mjs';

const CHILD = path.resolve('src/verify/o3_child.mjs');

/** Run one program, in its own process. Never throws. */
export function runTraced(codePath, { kind = 'script', timeoutMs = 8000, invokeMain = false, workDir } = {}) {
  assertExecutable(codePath);
  const work = path.resolve(workDir ?? 'scratch/t3/work/o3');
  fs.mkdirSync(work, { recursive: true });
  const base = path.basename(codePath).replace(/\.(m?js)$/, '');
  const outPath = path.join(work, `${base}.${kind}.trace.json`);
  const logPath = path.join(work, `${base}.${kind}.log.txt`);
  fs.rmSync(outPath, { force: true });
  const args = ['--experimental-vm-modules', `--max-old-space-size=512`, CHILD, path.resolve(codePath), outPath, kind, `--timeout=${Math.min(timeoutMs - 500, 4000)}`];
  if (invokeMain) args.push('--invoke-main');
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: timeoutMs });
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(outPath)) {
    const res = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    res.logPath = logPath;
    return res;
  }
  const log = fs.readFileSync(logPath, 'utf8').trim();
  return {
    status: r.signal || r.status === null ? 'timeout' : 'child-crash',
    error: `child exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}: ${log.slice(-300)}`,
    records: [], logPath,
  };
}

/** O3 for one corpus entry. */
export function o3One(entry, opts = {}) {
  const work = path.resolve(opts.workDir ?? 'scratch/t3/work/o3');
  fs.mkdirSync(work, { recursive: true });
  const minter = typeof opts.minter === 'object' ? opts.minter : resolveMinter(opts.minter ?? 'auto');
  const row = { id: entry.id, status: 'ok', kind: entry.scriptOrModule ?? 'script', minter: minter.label };

  // A: the original
  const a = runTraced(entry.abs ?? entry.file, { kind: row.kind, timeoutMs: opts.traceTimeoutMs ?? 8000, workDir: work });
  row.originalStatus = a.status;
  row.originalRecords = a.records.length;
  if (a.status !== 'ok') { row.status = `original-${a.status}`; row.error = a.error; return row; }
  if (a.records.filter((r) => r.k === 'T' || r.k === 'write' || r.k === 'call' || r.k === 'log').length === 0) {
    row.status = 'original-no-effects';
    row.error = 'the corpus file produced no observable trace -- it cannot discriminate anything';
    return row;
  }

  // mint + decompile
  const source = readSource(entry);
  const mint = mintJsc({ source, outPath: path.join(work, `${entry.id}.jsc`), minter, isModule: row.kind === 'module' });
  if (!mint.ok) { row.status = 'mint-failed'; row.error = mint.error; return row; }
  const dec = decompileInChild(mint.jscPath, {
    timeoutMs: opts.timeoutMs ?? 120_000, maxOldSpaceMB: opts.maxOldSpaceMB ?? 1200,
    workDir: work, codePath: path.join(work, `${entry.id}.decompiled.js`), module: opts.pipeline,
  });
  row.pipeline = dec.pipeline;
  if (!dec.ok) {
    row.status = dec.stage === 'timeout' ? 'pipeline-timeout' : 'pipeline-threw';
    row.errorClass = dec.errorClass; row.error = dec.error;
    return row;
  }

  // B: the decompiled output (always a script: the emitter does not emit modules)
  const b = runTraced(dec.codePath, { kind: 'script', timeoutMs: opts.traceTimeoutMs ?? 8000, invokeMain: opts.invokeMain !== false, workDir: work });
  row.decompiledStatus = b.status;
  row.decompiledRecords = b.records.length;
  row.invokedMain = Boolean(b.invokeMain);
  if (b.status !== 'ok') { row.status = `decompiled-${b.status}`; row.error = b.error; return row; }

  const cmp = compareTraces(a.records, b.records);
  row.traceCounts = cmp.counts;
  row.commonPrefix = cmp.commonPrefix;
  row.equal = cmp.equal;
  row.completion = cmp.completion;
  row.completionMatch = cmp.completionMatch;
  row.firstDivergence = cmp.firstDivergence;
  row.status = cmp.equal ? 'match' : 'differ';
  if (opts.keepTraces) {
    fs.writeFileSync(path.join(work, `${entry.id}.A.trace.txt`), traceText(a.records) + '\n');
    fs.writeFileSync(path.join(work, `${entry.id}.B.trace.txt`), traceText(b.records) + '\n');
  }
  return row;
}

export function o3Summary(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const compared = rows.filter((r) => r.equal !== undefined);
  return {
    entries: rows.length,
    byStatus,
    comparedEntries: compared.length,
    matching: compared.filter((r) => r.equal).length,
    differing: compared.filter((r) => !r.equal).length,
    matchPct: compared.length ? +(100 * compared.filter((r) => r.equal).length / compared.length).toFixed(2) : null,
  };
}

/**
 * Self-check: O3 must (a) say two runs of the same corpus file are equal and
 * (b) say a deliberately mutated copy is different. Without (b) a comparator
 * that always returns "equal" would pass.
 */
export function o3SelfCheck(entries, opts = {}) {
  const work = path.resolve(opts.workDir ?? 'scratch/t3/work/o3-self');
  fs.mkdirSync(work, { recursive: true });
  const out = { identity: [], discrimination: [], policy: null };

  for (const e of entries) {
    const a = runTraced(e.abs ?? e.file, { kind: e.scriptOrModule, workDir: work });
    const b = runTraced(e.abs ?? e.file, { kind: e.scriptOrModule, workDir: work });
    const cmp = compareTraces(a.records, b.records);
    out.identity.push({ id: e.id, status: [a.status, b.status], records: a.records.length, equal: cmp.equal });

    // A one-token mutation must change the trace. It is not guaranteed to be
    // observable (`out.unshift(x)` on an empty array behaves like push), so
    // try candidates until one is, and say so when none is. Mutants are
    // written into the work dir, the only place besides the corpus that
    // assertExecutable allows.
    const src = fs.readFileSync(e.abs ?? e.file, 'utf8');
    const cands = mutations(src);
    if (cands.length === 0) { out.discrimination.push({ id: e.id, mutated: false, reason: 'nothing to mutate' }); continue; }
    let detected = null, tried = [];
    for (const cand of cands.slice(0, 4)) {
      const mpath = path.join(work, `${e.id}.mutated${e.scriptOrModule === 'module' ? '.mjs' : '.js'}`);
      fs.writeFileSync(mpath, cand.src, 'utf8');
      const c = runTraced(mpath, { kind: e.scriptOrModule, workDir: work });
      const cmp2 = compareTraces(a.records, c.records);
      tried.push({ mutation: cand.label, status: c.status, equal: cmp2.equal });
      if (!cmp2.equal) { detected = cand.label; break; }
    }
    out.discrimination.push({ id: e.id, mutated: true, tried, detectedChange: Boolean(detected), mutation: detected, equal: detected ? false : true });
  }

  // the policy itself is part of the self-check
  try {
    assertExecutable('decompiled_js/r_73065.js');
    out.policy = { refusesForeignCode: false, note: 'POLICY HOLE: decompiled_js was accepted' };
  } catch (err) {
    out.policy = { refusesForeignCode: true, message: err.message };
  }

  out.identityPass = out.identity.every((r) => r.equal);
  const disc = out.discrimination.filter((d) => d.mutated);
  out.discriminationPass = disc.length > 0 && disc.every((d) => d.detectedChange);
  return out;
}


