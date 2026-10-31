#!/usr/bin/env node
// Metric 5: how many of the output's free identifiers are real globals.
//
// A free (undeclared) identifier in the emitted text is either a genuine
// global the original program referenced (`self`, `Object`, `require`) or a
// name the decompiler invented (`ctx`, `r7`, `__the_hole__`). The second kind
// is a guaranteed ReferenceError the moment the code runs, so the ratio is a
// direct measure of symbol recovery.
//
// Method and the known-globals set are taken from
// scratch/audit/free_identifiers.mjs, which produced the baseline's ~30%.
// Changes: one child process per file, and every invented name is classified
// so the report can say WHICH leak dominates.
//
// Nothing is executed -- each file is compiled with vm.Script as an
// independent cross-check of the parse, exactly as the baseline did, and the
// compiled script is discarded.
//
// Usage: node tools/metrics/collect/identifiers.mjs --mode quick --out <json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const KNOWN = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  'globalThis', 'undefined', 'NaN', 'Infinity', 'eval', 'arguments',
  'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Reflect', 'Proxy', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape',
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer',
  'global', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'console',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'Event', 'EventTarget', 'MessageChannel', 'MessagePort',
  'performance', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'crypto', 'WebAssembly',
  'window', 'self', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest', 'WebSocket',
  'Worker', 'SharedWorker', 'importScripts', 'postMessage', 'addEventListener',
  'removeEventListener', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'open', 'close',
  'HTMLElement', 'Element', 'Node', 'Image', 'CustomEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'XMLSerializer',
  'CSS', 'Intl', 'top', 'parent', 'frames', 'devicePixelRatio', 'origin',
]);

function classify(n) {
  if (/^r\d+$/.test(n)) return 'register r<N>';
  if (/^a\d+$/.test(n)) return 'parameter a<N>';
  if (/^func_\d+$/.test(n)) return 'unresolved closure func_<N>';
  if (/^__obj_\d+$/.test(n)) return 'unresolved heap object __obj_<N>';
  if (/^__runtime_\d+$/.test(n)) return 'unresolved runtime __runtime_<N>';
  if (/^__intrinsic_\d+$/.test(n)) return 'unresolved intrinsic __intrinsic_<N>';
  if (n === '__the_hole__') return 'hole sentinel __the_hole__';
  if (n === '__caughtErr') return 'synthetic catch variable __caughtErr';
  if (n === '__state') return 'relooper __state';
  if (n === '__resumeVal') return 'generator resume placeholder __resumeVal';
  if (n === 'ctx') return 'context object ctx';
  if (/^ctx_d\d+$/.test(n)) return 'outer context ctx_d<N>';
  if (n === 'acc') return 'accumulator acc';
  if (n === 'feedback_vector') return 'interpreter frame slot feedback_vector';
  if (/^Symbol_/.test(n)) return 'root symbol Symbol_<name>';
  return 'other (plausibly a real program global)';
}

if (argv.includes('--child')) {
  const file = val('--file');
  const outPath = val('--child');
  const row = { name: path.basename(file), bytes: fs.statSync(file).size };
  try {
    const vm = await import('node:vm');
    const { parse } = await import('@babel/parser');
    const traverseMod = await import('@babel/traverse');
    const traverse = traverseMod.default?.default ?? traverseMod.default ?? traverseMod;
    const src = fs.readFileSync(file, 'utf8');
    try { new vm.Script(src, { filename: row.name }); row.v8CompileOk = true; }
    catch (e) { row.v8CompileOk = false; row.v8CompileError = `${e.constructor.name}: ${e.message}`; }
    const ast = parse(src, { sourceType: 'script', attachComment: false, tokens: false, ranges: false });
    let globals = {};
    traverse(ast, { Program(p) { globals = p.scope.globals; p.stop(); } });
    const freeNames = Object.keys(globals).sort();
    const refCount = Object.create(null);
    traverse(ast, {
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        const n = p.node.name;
        if (p.scope.hasBinding(n, { noGlobals: true })) return;
        refCount[n] = (refCount[n] || 0) + 1;
      },
    });
    const invented = freeNames.filter((n) => !KNOWN.has(n));
    const real = freeNames.filter((n) => KNOWN.has(n));
    const byClass = {};
    for (const n of invented) {
      const c = classify(n);
      byClass[c] ??= { names: 0, references: 0, examples: [] };
      byClass[c].names++;
      byClass[c].references += refCount[n] || 0;
      if (byClass[c].examples.length < 5) byClass[c].examples.push(n);
    }
    row.freeDistinct = freeNames.length;
    row.realGlobalNames = real.length;
    row.inventedNames = invented.length;
    row.totalFreeReferences = freeNames.reduce((a, n) => a + (refCount[n] || 0), 0);
    row.inventedReferences = invented.reduce((a, n) => a + (refCount[n] || 0), 0);
    row.realGlobalReferences = row.totalFreeReferences - row.inventedReferences;
    row.byClass = byClass;
    row.realGlobals = real;
    row.ok = true;
  } catch (e) {
    row.ok = false;
    row.error = `${e?.constructor?.name}: ${String(e?.message).slice(0, 200)}`;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(row));
  process.exit(0);
}

const mode = val('--mode', 'quick');
const outPath = val('--out', `scratch/t3/metrics/identifiers.${mode}.json`);
const { identifierSample } = await import('../samples.mjs');
const sample = identifierSample(mode);
const work = 'scratch/t3/work/metrics-id';
fs.mkdirSync(work, { recursive: true });

const rows = [];
for (const f of sample.files) {
  const childOut = path.join(work, f.name + '.id.json');
  fs.rmSync(childOut, { force: true });
  const fd = fs.openSync(path.join(work, f.name + '.id.log'), 'w');
  try {
    spawnSync(process.execPath, ['--max-old-space-size=1400', process.argv[1], '--file', f.path, '--child', childOut],
      { stdio: ['ignore', fd, fd], timeout: 300_000, windowsHide: true });
  } finally { fs.closeSync(fd); }
  rows.push(fs.existsSync(childOut) ? JSON.parse(fs.readFileSync(childOut, 'utf8'))
                                    : { name: f.name, bytes: f.size, ok: false, error: 'child produced no result' });
  const r = rows[rows.length - 1];
  process.stderr.write(`${r.name.padEnd(40)} free=${r.totalFreeReferences ?? '-'} invented=${r.inventedReferences ?? '-'} real=${r.realGlobalReferences ?? '-'}\n`);
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const classes = {};
for (const r of rows) for (const [c, v] of Object.entries(r.byClass ?? {})) {
  classes[c] ??= { names: 0, references: 0, examples: [] };
  classes[c].names += v.names;
  classes[c].references += v.references;
  for (const x of v.examples) if (classes[c].examples.length < 6 && !classes[c].examples.includes(x)) classes[c].examples.push(x);
}
const total = sum('totalFreeReferences');
const result = {
  collector: 'identifiers',
  generatedAt: new Date().toISOString(),
  mode,
  sample: { ...sample, files: sample.files.map((f) => ({ name: f.name, size: f.size })) },
  files: rows.length,
  filesOk: rows.filter((r) => r.ok).length,
  v8CompileOk: rows.filter((r) => r.v8CompileOk).length,
  totalFreeReferences: total,
  inventedReferences: sum('inventedReferences'),
  realGlobalReferences: sum('realGlobalReferences'),
  filesWithNoInventedNames: rows.filter((r) => r.ok && r.inventedNames === 0).length,
  byClass: Object.fromEntries(Object.entries(classes).sort((a, b) => b[1].references - a[1].references)),
  metrics: {
    m5_realGlobalShare: { numerator: sum('realGlobalReferences'), denominator: total,
      pct: total ? +(100 * sum('realGlobalReferences') / total).toFixed(2) : null },
  },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
