#!/usr/bin/env node
// O1 oracle: run a real V8, parse its `--print-bytecode` listing into a
// structured per-function form, normalise away the incidental parts, and
// compare two streams.
//
// This is the only instrument in the project that can answer "is the
// decompiled JS the same program as the .jsc?" quantitatively: compile the
// decompiler's output with the matching V8, print its bytecode, and compare
// against the bytecode we decoded out of the .jsc.
//
// Library use:
//   import { dumpBytecode, parseBytecodeDump, normalizeDump, compareDumps } from 'src/verify/oracle.mjs';
//   const a = dumpBytecode({engine: 'node', source: srcA});
//   const b = dumpBytecode({engine: '.v8bin-cache/.../d8.exe', source: srcB});
//   const report = compareDumps(a.normalized, b.normalized);
//
// CLI:
//   node src/verify/oracle.mjs dump    --engine node --file a.js [--filter f] [--json out.json]
//   node src/verify/oracle.mjs compare --engine node --left a.js --right b.js [--filter f]
//   node src/verify/oracle.mjs engines

import fs from 'node:fs';
import path from 'node:path';
import { resolveEngine, engineVersion, printBytecode, DEFAULT_FLAGS } from '../../tools/oracle/engines.mjs';
import { parseBytecodeDump, renderInstruction, canonicalizeRawLine } from './bytecode_parser.mjs';
import { normalizeDump, normalizeFunction } from './normalize.mjs';
import { compareDumps, compareFunctions } from './compare.mjs';

export { parseBytecodeDump, normalizeDump, normalizeFunction, compareDumps, compareFunctions, renderInstruction, canonicalizeRawLine };
export { resolveEngine, engineVersion, printBytecode, DEFAULT_FLAGS };

/**
 * Compile a source with an engine and return raw text + parsed + normalised.
 * @param {{engine?: string, source?: string, file?: string, filter?: string,
 *          flags?: string[], workDir?: string, name?: string}} opts
 */
export function dumpBytecode(opts) {
  const engine = typeof opts.engine === 'object' ? opts.engine : resolveEngine(opts.engine);
  const source = opts.source ?? fs.readFileSync(opts.file, 'utf8');
  const name = opts.name ?? (opts.file ? path.basename(opts.file, path.extname(opts.file)) : 'snippet');
  const run = printBytecode(engine, source, { filter: opts.filter, flags: opts.flags, workDir: opts.workDir, name });
  const parsed = parseBytecodeDump(run.text);
  const normalized = normalizeDump(parsed);
  return {
    engine: { label: engine.label, kind: engine.kind, exe: engine.exe },
    status: run.status,
    flags: run.flags,
    rawText: run.text,
    rawPath: run.outPath,
    sourcePath: run.srcPath,
    parsed,
    functions: parsed.functions,
    normalized,
  };
}

/** Round-trip check: every parsed instruction must re-render to the raw line. */
export function roundTripCheck(parsed) {
  const failures = [];
  let checked = 0;
  for (const fn of parsed.functions) {
    for (const ins of fn.instructions) {
      checked++;
      const rendered = renderInstruction(ins);
      const canonical = canonicalizeRawLine(ins.raw);
      if (rendered !== canonical) failures.push({ fn: fn.name, offset: ins.offset, raw: ins.raw, rendered, canonical });
    }
  }
  return { checked, failures, ok: failures.length === 0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

function fmtPct(x) { return `${(100 * x).toFixed(2)}%`; }

function printCompare(rep) {
  console.log(`functions compared : ${rep.total}  (exact: ${rep.exact})`);
  if (rep.leftOnly.length) console.log(`only on the left   : ${rep.leftOnly.join(', ')}`);
  if (rep.rightOnly.length) console.log(`only on the right  : ${rep.rightOnly.join(', ')}`);
  console.log(`mean opcode similarity      : ${fmtPct(rep.meanOpcodeSimilarity)}`);
  console.log(`mean instruction similarity : ${fmtPct(rep.meanInstructionSimilarity)}`);
  for (const f of rep.functions) {
    console.log('');
    console.log(`  ${f.name || '<anonymous>'}: exact=${f.exactMatch} opcode=${fmtPct(f.opcodeSimilarity)} instr=${fmtPct(f.instructionSimilarity)} n=${f.instructionCounts.join('/')} prefix=${f.prefixMatch}`);
    if (f.firstDivergence) {
      const d = f.firstDivergence;
      console.log(`    first divergence at instruction ${d.index}:`);
      console.log(`      left : ${d.left}`);
      console.log(`      right: ${d.right}`);
      console.log(`      left context : ${d.leftContext.join(' | ')}`);
      console.log(`      right context: ${d.rightContext.join(' | ')}`);
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'engines') {
    for (const spec of ['node', ...process.argv.slice(3)]) {
      try {
        const e = resolveEngine(spec);
        console.log(`${spec} -> ${e.label}  v8=${engineVersion(e)}`);
      } catch (err) { console.log(`${spec} -> ${err.message}`); }
    }
    return;
  }
  if (cmd === 'dump') {
    const d = dumpBytecode({ engine: arg('engine', 'node'), file: arg('file'), filter: arg('filter'), workDir: arg('workdir') });
    console.log(`engine: ${d.engine.label}  flags: ${d.flags.join(' ')}  status=${d.status}`);
    console.log(`raw listing: ${d.rawPath}`);
    const rt = roundTripCheck(d.parsed);
    console.log(`round-trip: ${rt.checked} instructions, ${rt.failures.length} mismatches`);
    for (const f of d.parsed.functions) {
      console.log('');
      console.log(`function ${f.name || '<anonymous>'}: len=${f.bytecodeLength} params=${f.parameterCount} regs=${f.registerCount} frame=${f.frameSize} instrs=${f.instructions.length} pool=${f.constantPoolSize}(${f.constantPoolResolution}) handlers=${f.handlerTable.length}`);
      const n = normalizeFunction(f);
      for (let i = 0; i < n.perInstruction.length; i++) console.log(`  ${String(i).padStart(4)}  ${n.perInstruction[i]}`);
      if (n.handlerStream) console.log(n.handlerStream.split('\n').map((s) => '  ' + s).join('\n'));
    }
    const json = arg('json');
    if (json) {
      fs.mkdirSync(path.dirname(path.resolve(json)), { recursive: true });
      fs.writeFileSync(json, JSON.stringify({ engine: d.engine, functions: d.parsed.functions, normalized: d.normalized }, null, 1));
      console.log(`\nwrote ${json}`);
    }
    return;
  }
  if (cmd === 'compare') {
    const leftEngine = arg('engine', 'node');
    const rightEngine = arg('right-engine', leftEngine);
    const l = dumpBytecode({ engine: leftEngine, file: arg('left'), filter: arg('filter'), name: 'left' });
    const r = dumpBytecode({ engine: rightEngine, file: arg('right'), filter: arg('filter'), name: 'right' });
    console.log(`left : ${l.engine.label}  ${arg('left')}  (${l.normalized.length} functions)`);
    console.log(`right: ${r.engine.label}  ${arg('right')}  (${r.normalized.length} functions)`);
    printCompare(compareDumps(l.normalized, r.normalized));
    return;
  }
  console.log(`usage:
  node src/verify/oracle.mjs engines [<path-to-d8> ...]
  node src/verify/oracle.mjs dump    --engine <node|path-to-d8> --file <a.js> [--filter <fn>] [--json <out.json>]
  node src/verify/oracle.mjs compare --engine <node|path-to-d8> [--right-engine <...>] --left <a.js> --right <b.js> [--filter <fn>]`);
  process.exitCode = 2;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  await main();
}
