#!/usr/bin/env node
// Metrics 7 and 8: the two semantic hazards BASELINE_AUDIT.md 5.5 measured.
//
//   7  duplicated side-effecting call. legacy/src/dataflow.js pushes a call as a
//      statement AND leaves it in the accumulator, so the call is emitted
//      twice: `performance.now(); x = performance.now();` is two different
//      numbers. Metric: adjacent statement pairs where the printed text of
//      statement i occurs inside statement i+1.
//
//   8  destroyed object identity. A register holding an object is inlined as
//      the CONSTRUCTING EXPRESSION at every use, so each use allocates a new
//      object. Metric: allocation expressions whose printed text appears more
//      than once inside one function body.
//
// Method is scratch/audit/semantic_hazards.mjs, which produced the baseline.
// Changes: one child per file, and the per-file rows are kept so an outlier
// can be named.
//
// Usage: node tools/metrics/collect/hazards.mjs --mode quick --out <json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const FN = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
const ALLOC = /^(ObjectExpression|ArrayExpression|NewExpression)$/;
const SKIP = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);

if (argv.includes('--child')) {
  const file = val('--file');
  const outPath = val('--child');
  const f = { name: path.basename(file), bytes: fs.statSync(file).size, statements: 0, adjacentPairs: 0,
    dupSideEffect: 0, allocNodes: 0, dupAllocNodes: 0, dupAllocGroups: 0, maxDupOfOneAlloc: 0, fnBodies: 0, examples: [] };
  try {
    const { parse } = await import('@babel/parser');
    const genMod = await import('@babel/generator');
    const generate = genMod.default?.default ?? genMod.default ?? genMod;
    const code = (n) => generate(n, { comments: false, compact: true }).code;
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'script', attachComment: false, tokens: false, ranges: false });
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node.type !== 'string') return;
      if ((node.type === 'BlockStatement' || node.type === 'Program') && Array.isArray(node.body)) {
        const body = node.body;
        f.statements += body.length;
        for (let i = 0; i + 1 < body.length; i++) {
          f.adjacentPairs++;
          const a = body[i];
          if (a.type !== 'ExpressionStatement') continue;
          let txt, nxt;
          try { txt = code(a.expression); nxt = code(body[i + 1]); } catch { continue; }
          if (txt.length < 6 || !txt.includes('(')) continue;
          if (nxt.includes(txt)) {
            f.dupSideEffect++;
            if (f.examples.length < 3) f.examples.push({ stmt: txt.slice(0, 110), next: nxt.slice(0, 150) });
          }
        }
      }
      if (FN.test(node.type)) {
        f.fnBodies++;
        const seen = new Map();
        (function scan(n) {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) { for (const x of n) scan(x); return; }
          if (typeof n.type !== 'string') return;
          if (n !== node && FN.test(n.type)) return;
          if (ALLOC.test(n.type)) {
            let t; try { t = code(n); } catch { t = null; }
            if (t && t.length > 4) { seen.set(t, (seen.get(t) || 0) + 1); f.allocNodes++; }
          }
          for (const k in n) if (!SKIP.has(k)) scan(n[k]);
        })(node.body);
        for (const [, c] of seen) {
          if (c > 1) { f.dupAllocGroups++; f.dupAllocNodes += c; if (c > f.maxDupOfOneAlloc) f.maxDupOfOneAlloc = c; }
        }
      }
      for (const k in node) if (!SKIP.has(k)) walk(node[k]);
    })(ast.program);
    f.ok = true;
  } catch (e) {
    f.ok = false;
    f.error = `${e?.constructor?.name}: ${String(e?.message).slice(0, 200)}`;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(f));
  process.exit(0);
}

const mode = val('--mode', 'quick');
const outPath = val('--out', `scratch/t3/metrics/hazards.${mode}.json`);
const { hazardSample } = await import('../samples.mjs');
const sample = hazardSample(mode);
const work = 'scratch/t3/work/metrics-hz';
fs.mkdirSync(work, { recursive: true });

const rows = [];
for (const file of sample.files) {
  const childOut = path.join(work, file.name + '.hz.json');
  fs.rmSync(childOut, { force: true });
  const fd = fs.openSync(path.join(work, file.name + '.hz.log'), 'w');
  try {
    spawnSync(process.execPath, ['--max-old-space-size=1400', process.argv[1], '--file', file.path, '--child', childOut],
      { stdio: ['ignore', fd, fd], timeout: 600_000, windowsHide: true });
  } finally { fs.closeSync(fd); }
  rows.push(fs.existsSync(childOut) ? JSON.parse(fs.readFileSync(childOut, 'utf8'))
                                    : { name: file.name, bytes: file.size, ok: false, error: 'child produced no result' });
  const r = rows[rows.length - 1];
  process.stderr.write(`${r.name.padEnd(40)} pairs=${r.adjacentPairs} dupCalls=${r.dupSideEffect} allocs=${r.allocNodes} dupAllocs=${r.dupAllocNodes}\n`);
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const result = {
  collector: 'hazards',
  generatedAt: new Date().toISOString(),
  mode,
  sample: { ...sample, files: sample.files.map((f) => ({ name: f.name, size: f.size })) },
  files: rows.length,
  filesOk: rows.filter((r) => r.ok).length,
  statements: sum('statements'),
  adjacentPairs: sum('adjacentPairs'),
  dupSideEffect: sum('dupSideEffect'),
  filesWithDupSideEffect: rows.filter((r) => r.dupSideEffect > 0).length,
  fnBodies: sum('fnBodies'),
  allocNodes: sum('allocNodes'),
  dupAllocNodes: sum('dupAllocNodes'),
  dupAllocGroups: sum('dupAllocGroups'),
  filesWithDupAlloc: rows.filter((r) => r.dupAllocNodes > 0).length,
  worstDupOfOneAlloc: Math.max(0, ...rows.map((r) => r.maxDupOfOneAlloc ?? 0)),
  examples: rows.flatMap((r) => (r.examples ?? []).map((e) => ({ file: r.name, ...e }))).slice(0, 6),
  metrics: {
    m7_duplicatedSideEffects: { numerator: sum('dupSideEffect'), denominator: sum('adjacentPairs'),
      pct: sum('adjacentPairs') ? +(100 * sum('dupSideEffect') / sum('adjacentPairs')).toFixed(2) : null },
    m8_allocationsLosingIdentity: { numerator: sum('dupAllocNodes'), denominator: sum('allocNodes'),
      pct: sum('allocNodes') ? +(100 * sum('dupAllocNodes') / sum('allocNodes')).toFixed(2) : null },
  },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
