#!/usr/bin/env node
// src/cli/disasm.mjs
//
// Disassemble a V8 code cache.
//
//   node src/cli/disasm.mjs <file.jsc> [options]
//
//   --function <id>     only the function with this bytecode id, index, or name
//   --profile <tag>     profile directory or tag (default: the newest under profiles/)
//   --v8                print in V8's own --print-bytecode column layout, so the
//                       output diffs directly against a real engine's listing
//   --json [<out>]      machine-readable Instruction[] per 8.2
//   --list              one line per function: id, name, sizes, counts
//   --stats             decoding statistics and the opcode histogram only
//   --units real|legacy which FunctionUnit producer to use (default: real,
//                       i.e. src/cache + src/heap, falling back to
//                       src/disasm/adapter_legacy)
//   --no-constants      omit the constant pool from the rich listing
//   --quiet             suppress the per-file header
//
// Diffing against a real engine:
//
//   node src/cli/disasm.mjs a.jsc --v8 > ours.txt
//   node src/verify/oracle.mjs dump --engine <d8> --file a.js   # writes its raw listing
//   # then diff the two files; the address column is incidental.

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../profile/index.mjs';
import { disassemble } from '../disasm/index.mjs';
import { unitsFromJsc } from '../disasm/adapter_legacy.mjs';
import { renderRichListing, renderV8Listing, toParsedForm } from '../disasm/format.mjs';

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  const prev = all[i - 1];
  return !(prev && prev.startsWith('--'));
});

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node src/cli/disasm.mjs <file.jsc> [--function <id>] [--profile <tag>]
                              [--v8] [--json [out.json]] [--list] [--stats]
                              [--units real|legacy] [--no-constants] [--quiet]

available profiles: ${listProfiles().join(', ') || '(none)'}`);
  process.exit(msg ? 2 : 0);
}

if (flag('help') || flag('h')) usage();
const file = positional[0];
if (!file) usage('no .jsc file given');
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

// ---------------------------------------------------------------- profile
function resolveProfileDir(spec) {
  if (spec && spec !== true) {
    if (fs.existsSync(path.join(spec, 'meta.json'))) return spec;
    const asTag = path.join('profiles', spec);
    if (fs.existsSync(path.join(asTag, 'meta.json'))) return asTag;
    usage(`no profile at ${spec} or ${asTag}. Available: ${listProfiles().join(', ')}`);
  }
  const all = listProfiles();
  if (!all.length) usage('no profiles found under profiles/');
  return path.join('profiles', all[all.length - 1]);
}
const profileDir = resolveProfileDir(arg('profile'));
const profile = loadProfile(profileDir);

// ---------------------------------------------------------------- input
//
// Prefer the real pipeline (src/cache + src/heap, T4), which produces the 8.1
// FunctionUnit this disassembler is specified against. src/disasm/adapter_legacy
// is the fallback for when that pipeline is unavailable or cannot read a
// particular cache; it recovers less (no scope, no names, fewer constant
// classifications) and says so per unit.
const forced = arg('units');          // 'real' | 'legacy'
async function readUnits() {
  if (forced !== 'legacy') {
    try {
      const { loadEnvironment, readCache } = await import('../cache/index.mjs');
      const { buildUnits } = await import('../heap/index.mjs');
      const env = loadEnvironment(profileDir, { requireRoHeap: false, strict: false });
      const read = readCache(file, env);
      const built = buildUnits(env, read.graph ?? read);
      const units = Array.isArray(built) ? built : (built.units ?? []);
      if (units.length) return { units, header: read.header, via: 'src/cache + src/heap' };
      if (forced === 'real') return { units, header: read.header, via: 'src/cache + src/heap' };
    } catch (e) {
      if (forced === 'real') {
        console.error(`error: src/cache + src/heap could not read ${file}: ${e.message}`);
        process.exit(1);
      }
      if (!flag('quiet')) console.error(`  (src/cache + src/heap declined this file: ${e.message.slice(0, 160)})`);
    }
  }
  try {
    const r = unitsFromJsc(file, profile);
    return { units: r.units, header: r.header, via: 'src/disasm/adapter_legacy' };
  } catch (e) {
    console.error(`error: cannot read ${file} with profile ${profile.version}: ${e.message}`);
    console.error('  A tag mismatch between the cache and the profile, or a V8 build with a');
    console.error('  different sandbox setting, shows up here. Both readers assume the');
    console.error('  sandboxed layout the profile describes.');
    process.exit(1);
  }
}
const { units, header, via } = await readUnits();

const want = arg('function');
function matches(u, i) {
  if (want === undefined || want === true) return true;
  const s = String(want);
  return String(u.bytecodeId) === s || String(i) === s || (u.name && u.name === s)
    || (u.functionLiteralId !== null && String(u.functionLiteralId) === s);
}
const selected = units.map((u, i) => ({ u, i })).filter(({ u, i }) => matches(u, i));
if (!selected.length) {
  console.error(`error: no function matches --function ${want}. Use --list to see them.`);
  process.exit(1);
}

if (!flag('quiet')) {
  console.error(`${file}: ${units.length} functions, profile ${profile.version} (${profile.variant})`);
  console.error(`  units from ${via}`);
  const h = (k) => {
    const v = header && header[k];
    if (v === undefined || v === null) return '?';
    return typeof v === 'number' ? '0x' + (v >>> 0).toString(16) : String(v);
  };
  console.error(`  header magic ${h('magic')} versionHash ${h('versionHash')} payload ${header?.payloadLength ?? '?'} bytes`);
  if (selected.length !== units.length) console.error(`  showing ${selected.length} selected function(s)`);
}

// ---------------------------------------------------------------- run
const results = [];
let failures = 0;
for (const { u, i } of selected) {
  try {
    results.push({ i, result: disassemble(u, { profile, strict: false }) });
  } catch (e) {
    failures++;
    console.error(`  function ${i} (bytecode ${u.bytecodeId}): ${e.message}`);
  }
}

// ---------------------------------------------------------------- output
if (flag('list')) {
  console.log('index\tbytecodeId\tbytes\tinstrs\tparams\tregs\tjumps\tjumpTables\tsrcPos\thandlers\tname');
  for (const { i, result: r } of results) {
    const u = r.unit;
    console.log([i, u.bytecodeId, u.bytecode.length, r.stats.instructions, u.parameterCount, u.registerCount,
      r.stats.jumps, r.stats.jumpTables, `${r.stats.sourcePositionsAttached}/${r.stats.sourcePositionsTotal}`,
      (u.handlers ?? []).length, u.name || '<anonymous>'].join('\t'));
  }
} else if (flag('stats')) {
  const agg = { instructions: 0, jumps: 0, jumpTables: 0, jumpTableEntries: 0, prefixed: 0, shortStars: 0, mismatches: 0 };
  const hist = new Map();
  for (const { result: r } of results) {
    agg.instructions += r.stats.instructions;
    agg.jumps += r.stats.jumps;
    agg.jumpTables += r.stats.jumpTables;
    agg.jumpTableEntries += r.stats.jumpTableEntries;
    agg.prefixed += r.stats.prefixed;
    agg.shortStars += r.stats.shortStars;
    for (const [, v] of r.stats.lengthMismatch) agg.mismatches += v;
    for (const [k, v] of r.stats.opcodeHistogram) hist.set(k, (hist.get(k) ?? 0) + v);
  }
  console.log(`functions        ${results.length}`);
  console.log(`instructions     ${agg.instructions}`);
  console.log(`jumps            ${agg.jumps}`);
  console.log(`jump tables      ${agg.jumpTables} (${agg.jumpTableEntries} entries)`);
  console.log(`prefixed         ${agg.prefixed}`);
  console.log(`short stars      ${agg.shortStars}`);
  console.log(`length mismatches ${agg.mismatches}`);
  console.log('');
  console.log('opcode histogram:');
  for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(8)}  ${k}`);
} else if (arg('json') !== undefined) {
  const payload = {
    file, profile: profile.version, header,
    functions: results.map(({ i, result: r }) => ({
      index: i,
      unit: {
        bytecodeId: r.unit.bytecodeId, name: r.unit.name, functionLiteralId: r.unit.functionLiteralId,
        parameterCount: r.unit.parameterCount, registerCount: r.unit.registerCount,
        frameSize: r.unit.frameSize, maxArguments: r.unit.maxArguments,
        bytecodeLength: r.unit.bytecode.length,
        constants: r.unit.constants, handlers: r.unit.handlers,
      },
      instructions: r.instructions,
      stats: {
        ...r.stats,
        lengthMismatch: Object.fromEntries(r.stats.lengthMismatch),
        opcodeHistogram: Object.fromEntries(r.stats.opcodeHistogram),
      },
      warnings: r.warnings,
    })),
  };
  const text = JSON.stringify(payload, null, 1);
  const out = arg('json');
  if (out === true) console.log(text);
  else {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    console.error(`wrote ${out}`);
  }
} else if (flag('v8')) {
  for (const { result: r } of results) process.stdout.write(renderV8Listing(r));
} else {
  for (const { result: r } of results) {
    process.stdout.write(renderRichListing(r, { constants: !flag('no-constants') }));
    process.stdout.write('\n');
  }
}

process.exitCode = failures === 0 ? 0 : 1;
export { toParsedForm };
