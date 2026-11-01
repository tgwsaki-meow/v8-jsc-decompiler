// The decompiler, behind one small interface, so the oracles do not know which
// implementation they are grading.
//
//   decompile(jscPath)        -> { ok, code, perFunction, stats, error }
//   decompileInChild(jscPath) -> same shape, in a forked process with a heap
//                                cap and a hard timeout, and NEVER throws
//
// perFunction is [{ index, name, code, bytes, loc }] for every top-level
// function in the emitted text. That is what O1 pairs against V8's listing.
//
// Choosing the implementation:
//   * default: src/emit/decompile.mjs -> new V8Decompiler().decompileFile(path)
//   * override: set V8D_PIPELINE=<module> (or pass {module}) where the module
//     exports decompileFile(path) / decompile(path) / default
//
// The default used to name src/decompiler.js, the prototype BASELINE_AUDIT.md
// condemned and legacy/README.md explains. Every run that did not set
// V8D_PIPELINE therefore graded the wrong artefact, and docs/EMIT.md records
// that happening: a liveness run came back tagged `pipeline:
// src/decompiler.js` with `function func_1` in its output. Two things keep
// that from recurring. loadPipeline() asserts the resolved module exists and
// exports the shape it is about to use, so a stale default fails loudly
// instead of measuring something else; and every row carries
// `pipelineSource`, so a report can state whether anybody actually named what
// was graded.
//
// A broken pipeline must not break a measurement run: every failure comes back
// as a row with ok:false and a stage, and decompileInChild() turns a crash,
// an OOM or a hang into exactly the same kind of row.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '@babel/parser';

export const DEFAULT_PIPELINE = 'src/emit/decompile.mjs';
const CHILD = path.resolve('src/verify/pipeline_child.mjs');

export function pipelineId(moduleSpec) {
  return pipelineChoice(moduleSpec).spec;
}

/**
 * Which module will be graded, and who chose it. `source` is the whole point:
 * 'default' means nobody named a pipeline, which is exactly the condition
 * under which the old stale default went unnoticed.
 * @returns {{spec: string, source: 'explicit'|'env'|'default'}}
 */
export function pipelineChoice(moduleSpec) {
  if (moduleSpec) return { spec: moduleSpec, source: 'explicit' };
  if (process.env.V8D_PIPELINE) return { spec: process.env.V8D_PIPELINE, source: 'env' };
  return { spec: DEFAULT_PIPELINE, source: 'default' };
}

async function loadPipeline(moduleSpec) {
  const { spec, source } = pipelineChoice(moduleSpec);
  const abs = path.resolve(spec);
  // A default that has gone stale must fail here, not quietly grade whatever
  // module still happens to sit at that path.
  if (!fs.existsSync(abs)) {
    throw new Error(`pipeline module ${spec} does not exist (resolved to ${abs}${source === 'default' ? '; this is the built-in default, so it is out of date' : ''})`);
  }
  const url = new URL(`file:///${abs.replace(/\\/g, '/')}`);
  const mod = await import(url.href);
  if (mod.V8Decompiler) {
    const d = new mod.V8Decompiler();
    // deserializeFile() is what fills in deserializedFunctions, metric 6's
    // denominator. Losing it silently turns metric 6 into `null`, so the
    // richer branch only engages when the whole shape is really there.
    if (typeof d.deserializer?.deserializeFile !== 'function') {
      throw new Error(`pipeline module ${spec} exports V8Decompiler but no .deserializer.deserializeFile`);
    }
    return {
      spec,
      source,
      run: (p) => {
        const res = d.decompileFile(p);
        return { code: res.code, totalFunctions: res.totalFunctions, header: res.header, fnCacheSize: d.fnCache?.size ?? null };
      },
      deserialize: (p) => d.deserializer.deserializeFile(p),
    };
  }
  const fn = mod.decompileFile ?? mod.decompile ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`pipeline module ${spec} exports no decompileFile/decompile/default`);
  return { spec, source, run: (p) => { const r = fn(p); return typeof r === 'string' ? { code: r } : r; }, deserialize: null };
}

/** Split emitted text into its top-level functions. */
export function splitFunctions(code) {
  try {
    const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: false });
    const out = [];
    ast.program.body.forEach((n, i) => {
      if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') {
        out.push({ index: out.length, bodyIndex: i, name: n.id ? n.id.name : '<anonymous>', code: code.slice(n.start, n.end), bytes: n.end - n.start });
      }
    });
    return { ok: true, functions: out, topLevelStatements: ast.program.body.length };
  } catch (e) {
    return { ok: false, functions: [], error: `${e.constructor.name}: ${e.message}` };
  }
}

/** In-process decompile. Throws only if the pipeline module cannot be loaded. */
export async function decompile(jscPath, opts = {}) {
  const started = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - started) / 1e6;
  let pipe;
  try {
    pipe = await loadPipeline(opts.module);
  } catch (e) {
    const c = pipelineChoice(opts.module);
    return { ok: false, stage: 'load', error: `${e.constructor.name}: ${e.message}`, pipeline: c.spec, pipelineSource: c.source };
  }

  const row = { ok: false, pipeline: pipe.spec, pipelineSource: pipe.source, jsc: jscPath, inputBytes: fs.statSync(jscPath).size };
  if (pipe.deserialize) {
    try {
      const d = pipe.deserialize(jscPath);
      row.deserializedFunctions = d.functions.length;
      row.header = d.header;
      row.deserializeMs = +ms().toFixed(1);
    } catch (e) {
      row.stage = 'deserialize';
      row.errorClass = classify(e);
      row.error = String(e?.message ?? e);
      row.wallMs = +ms().toFixed(1);
      return row;
    }
  }
  const t1 = process.hrtime.bigint();
  try {
    const res = pipe.run(jscPath);
    row.ok = true;
    row.stage = 'complete';
    row.code = res.code ?? '';
    row.codeBytes = Buffer.byteLength(row.code, 'utf8');
    row.totalFunctions = res.totalFunctions ?? row.deserializedFunctions ?? null;
    row.fnCacheSize = res.fnCacheSize ?? null;
    row.decompileMs = +(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1);
    const split = splitFunctions(row.code);
    row.perFunction = split.functions;
    row.emittedFunctions = split.functions.length;
    row.distinctEmittedNames = new Set(split.functions.map((f) => f.name)).size;
    row.outputParses = split.ok;
    if (!split.ok) row.outputParseError = split.error;
  } catch (e) {
    row.stage = 'decompile';
    row.errorClass = classify(e);
    row.error = String(e?.message ?? e);
    row.errorFrame = String(e?.stack ?? '').split('\n')[1]?.trim() ?? null;
    row.decompileMs = +(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1);
    row.perFunction = [];
  }
  row.wallMs = +ms().toFixed(1);
  row.rssPeakMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  return row;
}

/** The error classes the current pipeline fail-fasts with, kept as data. */
function classify(e) {
  const m = String(e?.message ?? '');
  const named = m.match(/\b([A-Z][A-Za-z]*Error)\b/);
  return named ? named[1] : (e?.constructor?.name ?? typeof e);
}

/**
 * Forked decompile: a hang, an OOM or a hard crash becomes a row, not an
 * exception. This is the only form the metric collectors use -- the host has
 * 4 GB and the current pipeline has inputs that take minutes and 1.5 GB.
 */
export function decompileInChild(jscPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const heapMB = opts.maxOldSpaceMB ?? 1400;
  const work = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'v8d-pipe-'));
  fs.mkdirSync(work, { recursive: true });
  const base = path.basename(jscPath).replace(/\.jsc$/, '');
  const resultPath = path.join(work, base + '.result.json');
  const codePath = opts.codePath ?? path.join(work, base + '.out.js');
  const logPath = path.join(work, base + '.log.txt');

  const args = [`--max-old-space-size=${heapMB}`, CHILD, path.resolve(jscPath), resultPath, codePath];
  if (opts.module) args.splice(2, 0, `--pipeline=${opts.module}`);
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: timeoutMs });
  } finally {
    fs.closeSync(fd);
  }
  const wall = Date.now() - t0;

  if (fs.existsSync(resultPath)) {
    const row = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    row.childWallMs = wall;
    row.codePath = fs.existsSync(codePath) ? codePath : null;
    row.logPath = logPath;
    return row;
  }
  const log = fs.readFileSync(logPath, 'utf8').trim();
  const killed = r.signal || wall >= timeoutMs - 50;
  return {
    ok: false,
    jsc: jscPath,
    pipeline: pipelineChoice(opts.module).spec,
    pipelineSource: pipelineChoice(opts.module).source,
    stage: killed ? 'timeout' : 'crash',
    errorClass: killed ? 'TimeoutError' : 'ChildCrash',
    error: killed ? `killed after ${timeoutMs} ms` : `child exited ${r.status}${r.error ? ' ' + r.error.message : ''}`,
    childLogTail: log.slice(-400),
    childWallMs: wall,
    perFunction: [],
    logPath,
  };
}
