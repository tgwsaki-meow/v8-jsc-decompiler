#!/usr/bin/env node
// tools/disasm/corpus_scan.mjs
//
// Disassemble every function of every extracted_jsc/*.jsc and report:
// functions, instructions, failures, the opcode histogram, how many jump
// tables were decoded, the per-opcode count of instructions whose decoded
// length disagrees with profile.instructionLength(), and wall time.
//
// The length cross-check is the cheap permanent invariant: an instruction
// whose decoded width differs from the width the profile predicts means the
// stream has desynchronised, which is exactly the failure mode a wrong-version
// operand table produces (ARCHITECTURE.md 1.3). It must be 0.
//
// Files are processed one at a time and nothing is retained across files, so
// peak memory is one .jsc's object graph. Nothing from the corpus is executed.
//
// Usage:
//   node --max-old-space-size=2600 tools/disasm/corpus_scan.mjs
//   node --max-old-space-size=2600 tools/disasm/corpus_scan.mjs --max-files 20
//   node --max-old-space-size=2600 tools/disasm/corpus_scan.mjs --profile profiles/14.6.202.34

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile } from '../../src/profile/index.mjs';
import { disassemble } from '../../src/disasm/index.mjs';
import { unitsFromJsc } from '../../src/disasm/adapter_legacy.mjs';
import { unitsFromCache, haveRealCachePath } from './real_units.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const PROFILE_DIR = arg('profile', 'profiles/14.4.258.16');
const CORPUS = arg('corpus', 'extracted_jsc');
const MAX_FILES = Number(arg('max-files', '0')) || Infinity;
const OUT = arg('out', 'scratch/t5/CORPUS_SCAN.md');
// Which FunctionUnit producer: 'real' = src/cache + src/heap (T4, the 8.1
// contract), 'legacy' = src/disasm/adapter_legacy. Both must give the same
// decode; the oracle asserts that on the feature corpus.
const UNITS = arg('units', (await haveRealCachePath()) ? 'real' : 'legacy');

const profile = loadProfile(PROFILE_DIR);
const readUnits = UNITS === 'real'
  ? async (file) => (await unitsFromCache(file, PROFILE_DIR)).units
  : async (file) => unitsFromJsc(file, profile).units;
const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort().slice(0, MAX_FILES);

const totals = {
  files: 0, filesFailed: 0, units: 0, unitsFailed: 0, instructions: 0, bytecodeBytes: 0,
  jumps: 0, jumpTargetsResolved: 0, unresolvedJumps: 0,
  jumpTables: 0, jumpTableEntries: 0, jumpTableHoles: 0,
  prefixed: 0, wide: 0, extraWide: 0, shortStars: 0,
  danglingTargets: 0, badRegisters: 0,
  sourcePositionsTotal: 0, sourcePositionsAttached: 0,
  unitsWithSourcePositions: 0, unitsWithHandlers: 0, handlers: 0,
  constants: 0, unresolvedConstants: 0,
};
const opcodeHistogram = new Map();
const lengthMismatch = new Map();
const warningKinds = new Map();
const fileFailures = [];
const unitFailures = [];
const slowest = [];

const t0 = process.hrtime.bigint();
let lastLog = Date.now();
// Wall time splits in two: reading the .jsc (src/deserializer.js via
// adapter_legacy, which T4 replaces) and decoding (src/disasm, this task).
// Reported separately because the first dominates and is not ours.
let readNs = 0n, disasmNs = 0n;

for (const f of files) {
  const file = path.join(CORPUS, f);
  const ft0 = process.hrtime.bigint();
  let units;
  try {
    units = await readUnits(file);
    readNs += process.hrtime.bigint() - ft0;
  } catch (e) {
    readNs += process.hrtime.bigint() - ft0;
    totals.filesFailed++;
    fileFailures.push({ file: f, stage: 'deserialize', error: e.message });
    continue;
  }
  totals.files++;
  let fileInstr = 0;
  for (const u of units) {
    totals.units++;
    let r;
    const dt0 = process.hrtime.bigint();
    try {
      r = disassemble(u, { profile, strict: false });
      disasmNs += process.hrtime.bigint() - dt0;
    } catch (e) {
      disasmNs += process.hrtime.bigint() - dt0;
      totals.unitsFailed++;
      unitFailures.push({ file: f, unit: u.bytecodeId, error: e.message });
      continue;
    }
    const s = r.stats;
    totals.instructions += s.instructions;
    fileInstr += s.instructions;
    totals.bytecodeBytes += s.bytecodeLength;
    totals.jumps += s.jumps;
    totals.jumpTargetsResolved += s.jumpTargetsResolved;
    totals.unresolvedJumps += s.unresolvedJumps;
    totals.jumpTables += s.jumpTables;
    totals.jumpTableEntries += s.jumpTableEntries;
    totals.jumpTableHoles += s.jumpTableHoles;
    totals.prefixed += s.prefixed;
    totals.shortStars += s.shortStars;
    totals.danglingTargets += s.danglingTargets;
    totals.badRegisters += s.badRegisters;
    totals.sourcePositionsTotal += s.sourcePositionsTotal;
    totals.sourcePositionsAttached += s.sourcePositionsAttached;
    if (s.sourcePositionsTotal > 0) totals.unitsWithSourcePositions++;
    if ((u.handlers ?? []).length) { totals.unitsWithHandlers++; totals.handlers += u.handlers.length; }
    totals.constants += (u.constants ?? []).length;
    for (const c of u.constants ?? []) if (c && c.t === 'unresolved') totals.unresolvedConstants++;
    for (const ins of r.instructions) {
      if (ins.scale === 2) totals.wide++;
      else if (ins.scale === 4) totals.extraWide++;
    }
    for (const [k, v] of s.opcodeHistogram) opcodeHistogram.set(k, (opcodeHistogram.get(k) ?? 0) + v);
    for (const [k, v] of s.lengthMismatch) lengthMismatch.set(k, (lengthMismatch.get(k) ?? 0) + v);
    for (const w of r.warnings) warningKinds.set(w.code, (warningKinds.get(w.code) ?? 0) + 1);
  }
  const ms = Number(process.hrtime.bigint() - ft0) / 1e6;
  slowest.push({ file: f, ms, units: units.length, instructions: fileInstr, bytes: fs.statSync(file).size });
  if (Date.now() - lastLog > 5000) {
    lastLog = Date.now();
    process.stderr.write(`  ${totals.files}/${files.length} files, ${totals.units} units, ${totals.instructions} instructions\n`);
  }
}
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

slowest.sort((a, b) => b.ms - a.ms);
const hist = [...opcodeHistogram].sort((a, b) => b[1] - a[1]);

const L = [];
const say = (s = '') => { L.push(s); };
say('# src/disasm corpus scan');
say('');
say(`profile       : ${profile.version} (${profile.variant})`);
say(`corpus        : ${CORPUS}/  ${files.length} .jsc files`);
say(`unit source   : ${UNITS === 'real' ? 'src/cache + src/heap (the 8.1 contract)' : 'src/disasm/adapter_legacy'}`);
say(`node          : ${process.version}, heap cap ${process.execArgv.join(' ') || '(default)'}`);
say('');
say('## totals');
say('');
say('| metric | value |');
say('|---|---:|');
const row = (k, v) => say(`| ${k} | ${v} |`);
row('files read', `${totals.files} / ${files.length}`);
row('files that failed to deserialize', totals.filesFailed);
row('functions (BytecodeArrays)', totals.units);
row('functions that failed to disassemble', totals.unitsFailed);
row('instructions decoded', totals.instructions);
row('bytecode bytes decoded', totals.bytecodeBytes);
row('distinct opcodes seen', opcodeHistogram.size);
row('jump instructions', totals.jumps);
row('jump targets resolved', totals.jumpTargetsResolved);
row('jump deltas we could not resolve', totals.unresolvedJumps);
row('**jump tables decoded**', `**${totals.jumpTables}**`);
row('jump table entries', totals.jumpTableEntries);
row('jump table entries that were not a Smi', totals.jumpTableHoles);
row('targets that are not an instruction start', totals.danglingTargets);
row('register operands outside the frame', totals.badRegisters);
row('prefixed instructions (Wide + ExtraWide)', totals.prefixed);
row('Wide', totals.wide);
row('ExtraWide', totals.extraWide);
row('short-star instructions normalised to Star', totals.shortStars);
row('functions with a source position table', `${totals.unitsWithSourcePositions} / ${totals.units}`);
row('source position rows', totals.sourcePositionsTotal);
row('source position rows attached to an instruction', `${totals.sourcePositionsAttached}`
  + ` (${totals.sourcePositionsTotal ? (100 * totals.sourcePositionsAttached / totals.sourcePositionsTotal).toFixed(3) : '0'}%)`);
row('functions with a handler table', totals.unitsWithHandlers);
row('handler table entries', totals.handlers);
row('constant pool entries', totals.constants);
row('constant pool entries reported {t:unresolved}', `${totals.unresolvedConstants}`
  + ` (${totals.constants ? (100 * totals.unresolvedConstants / totals.constants).toFixed(2) : '0'}%)`);
const readMs = Number(readNs) / 1e6;
const disasmMs = Number(disasmNs) / 1e6;
row('wall time (total)', `${(wallMs / 1000).toFixed(1)} s`);
row(`  of which reading the .jsc (${UNITS === 'real' ? 'src/cache + src/heap' : 'src/deserializer.js'})`, `${(readMs / 1000).toFixed(1)} s`
  + ` (${(100 * readMs / wallMs).toFixed(1)}%)`);
row('  of which disassembling (src/disasm)', `${(disasmMs / 1000).toFixed(1)} s`
  + ` (${(100 * disasmMs / wallMs).toFixed(1)}%)`);
row('disassembler throughput', `${(totals.instructions / (disasmMs / 1000)).toFixed(0)} instructions/s, `
  + `${(totals.bytecodeBytes / 1024 / (disasmMs / 1000)).toFixed(0)} KiB bytecode/s`);
row('end-to-end throughput', `${(totals.instructions / (wallMs / 1000)).toFixed(0)} instructions/s`);
say('');

say('## decoded length vs profile.instructionLength()');
say('');
if (lengthMismatch.size === 0) {
  say('0 mismatches over all ' + totals.instructions + ' instructions. PASS');
} else {
  say('| opcode | mismatches |');
  say('|---|---:|');
  for (const [k, v] of [...lengthMismatch].sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
  say('');
  say('**FAIL** -- a decoded width that disagrees with the profile means the instruction stream desynchronised.');
}
say('');

say('## warnings by kind');
say('');
if (warningKinds.size === 0) say('(none)');
else {
  say('| code | count |');
  say('|---|---:|');
  for (const [k, v] of [...warningKinds].sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
}
say('');

if (fileFailures.length) {
  say('## files that failed');
  say('');
  say('| file | stage | error |');
  say('|---|---|---|');
  for (const f of fileFailures.slice(0, 40)) say(`| ${f.file} | ${f.stage} | ${f.error.slice(0, 160)} |`);
  say('');
}
if (unitFailures.length) {
  say('## functions that failed');
  say('');
  for (const f of unitFailures.slice(0, 40)) say(`* ${f.file} unit ${f.unit}: ${f.error.slice(0, 200)}`);
  say('');
}

say('## slowest files');
say('');
say('| file | KiB | functions | instructions | ms |');
say('|---|---:|---:|---:|---:|');
for (const s of slowest.slice(0, 15)) {
  say(`| ${s.file} | ${(s.bytes / 1024).toFixed(0)} | ${s.units} | ${s.instructions} | ${s.ms.toFixed(0)} |`);
}
say('');

say('## opcode histogram');
say('');
say(`${hist.length} distinct opcodes of ${profile.opcodeCount} in the profile.`);
say('');
say('| opcode | count | share |');
say('|---|---:|---:|');
for (const [k, v] of hist) say(`| ${k} | ${v} | ${(100 * v / totals.instructions).toFixed(3)}% |`);
say('');
const unseen = [];
for (let v = 0; v < profile.opcodeCount; v++) {
  const op = profile.getOpcode(v);
  if (!op) continue;
  if (/^Star\d+$/.test(op.name)) continue;        // normalised to Star
  if (!opcodeHistogram.has(op.name) && op.name !== 'Illegal' && !profile.prefixScale(v)) unseen.push(op.name);
}
say(`### never seen in the corpus (${unseen.length})`);
say('');
say(unseen.join(', ') || '(none)');
say('');

const failed = totals.filesFailed + totals.unitsFailed + lengthMismatch.size
  + totals.danglingTargets + totals.badRegisters + totals.jumpTableHoles + totals.unresolvedJumps;
say('='.repeat(78));
say(failed === 0 ? 'CORPUS SCAN: NO FAILURES' : `CORPUS SCAN: ${failed} PROBLEM(S) -- see above`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n') + '\n');
fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify({
  profile: profile.version, totals, wallMs,
  lengthMismatch: Object.fromEntries(lengthMismatch),
  warnings: Object.fromEntries(warningKinds),
  opcodeHistogram: Object.fromEntries(hist),
  unseenOpcodes: unseen,
  fileFailures, unitFailures,
}, null, 1));
console.log(L.slice(0, 60).join('\n'));
console.log(`\n... full report: ${OUT}`);
process.exitCode = failed === 0 ? 0 : 1;
