#!/usr/bin/env node
// tools/disasm/oracle_agreement.mjs
//
// THE acceptance test for src/disasm/: V8's own --print-bytecode is a reference
// disassembler for exactly the bytecode we decode, so agreement with it is a
// hard, exact criterion rather than a similarity score.
//
//   source.js --(listing engine: --print-bytecode)--> text
//             --(src/verify/bytecode_parser)--------> V8's instruction stream
//
//   source.js --(our input side)------------------->  FunctionUnit (8.1)
//             --(src/disasm)----------------------->  our instruction stream
//
// The input side comes in two modes.
//
//   mode `cache`   source.js --(cache engine: vm.Script.createCachedData)-->
//                  a real .jsc --(src/disasm/adapter_legacy)--> FunctionUnit.
//                  The full path, including the serialized constant pool,
//                  handler table and source position table.
//
//   mode `listing` the FunctionUnit's bytecode bytes, header numbers and
//                  constant pool are lifted out of V8's own listing (see
//                  tools/disasm/unit_from_listing.mjs for exactly what that
//                  does and does not test). Needed for 14.6: both profiles
//                  describe a SANDBOXED V8 build and the node binary here is
//                  built without the sandbox, so its .jsc does not match the
//                  profile's object layouts. Source positions are not
//                  available in this mode and are not compared.
//
// Functions are paired by their BYTECODE BYTES, reconstructed from the hex
// column of V8's listing. That is unambiguous, and in `cache` mode it doubles
// as a check that the cache engine and the listing engine emitted the same
// bytecode; if they did not, pairing fails loudly instead of producing a
// misleading instruction diff.
//
// Each paired function is then checked two ways:
//
//  1. DIRECT, instruction for instruction: same count, same offsets, same raw
//     bytes, same opcode and scale, same operand text, same jump target, same
//     jump table, same source position / statement flag. Constant-pool
//     operands are compared BY INDEX, not by V8's printed value: both sides
//     read the same pool out of the same BytecodeArray, so the index is the
//     stronger comparison, and a release d8 does not dump the pool at all.
//  2. Through src/verify/normalize.mjs + compare.mjs, requiring `exactMatch`,
//     with constant values erased on both sides for the same reason.
//
// Every mode is REQUIRED by default and a missing engine is a failure, not a
// skip: a run that measured nothing used to print the same green last line as
// a run that measured everything, which is how the dual-reader claim stayed a
// Windows-local fact while CI was green (see the comment on D8_144 below).
//
// Usage:
//   node tools/disasm/oracle_agreement.mjs
//   node tools/disasm/oracle_agreement.mjs --only switch_jumptable
//   node tools/disasm/oracle_agreement.mjs --pair 14.6.202.34
//   node tools/disasm/oracle_agreement.mjs --skip-big
//   node tools/disasm/oracle_agreement.mjs --allow-skip   # a mode with no
//                                 engine is reported and skipped, not failed

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadProfile } from '../../src/profile/index.mjs';
import { disassemble } from '../../src/disasm/index.mjs';
import { unitsFromJsc } from '../../src/disasm/adapter_legacy.mjs';
import { unitsFromCache, haveRealCachePath } from './real_units.mjs';
import { toParsedForm } from '../../src/disasm/format.mjs';
import { parseBytecodeDump } from '../../src/verify/bytecode_parser.mjs';
import { normalizeFunction } from '../../src/verify/normalize.mjs';
import { compareFunctions } from '../../src/verify/compare.mjs';
import { resolveEngine, printBytecode, findCachedEngine, DEFAULT_FLAGS } from '../oracle/engines.mjs';
import { unitFromListing, poolsFromRawListing } from './unit_from_listing.mjs';
import { SOURCES, WANTED } from './sources.mjs';

// The two 14.4 engines are FOUND, not named. They used to be
// `.v8bin-cache/electron-v40.0.0-win32-x64/electron.exe` and
// `.v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe`, which is why the last green
// `V8 oracle` run on ubuntu logged `SKIP: cache engine missing` for both 14.4
// modes and measured only 14.6 -- see tools/oracle/engines.mjs's comment.
// Either patch of 14.4.258 will do for the listing engine, because functions
// are paired by their BYTECODE BYTES rather than by name: the Windows cache
// carries .17 and the chromium-v8 bucket's linux64-rel build is .16.
const D8_144 = findCachedEngine('d8', '14.4.258.');
const ELECTRON_40 = findCachedEngine('electron', '40.');
const ELECTRON_LABEL = 'electron 40 (v8 14.4.258.16, sandboxed)';

const PAIRS = [
  {
    tag: '14.4.258.16',
    profile: 'profiles/14.4.258.16',
    mode: 'cache',
    // Electron 40.0.0 carries V8 14.4.258.16, exactly the profile tag, and is
    // a sandboxed build like the corpus. On Windows it cannot print a listing,
    // because electron.exe is a GUI-subsystem binary and V8's StdoutStream has
    // nowhere to write; d8 does the printing on both hosts, which is why
    // functions are paired by bytecode bytes.
    cache: { engine: ELECTRON_40, label: ELECTRON_LABEL, env: { ELECTRON_RUN_AS_NODE: '1' } },
    listing: D8_144,
    required: true,
  },
  {
    // The same comparison, but with the FunctionUnits coming from T4's real
    // src/cache + src/heap instead of src/disasm/adapter_legacy. src/disasm is
    // specified against 8.1 and must consume T4's output unchanged; running
    // both input paths against the same oracle is how that is demonstrated,
    // and a disagreement between them says which one has the contract wrong.
    tag: '14.4.258.16',
    label: '14.4.258.16 (src/cache + src/heap)',
    profile: 'profiles/14.4.258.16',
    mode: 'cache-t4',
    cache: { engine: ELECTRON_40, label: ELECTRON_LABEL, env: { ELECTRON_RUN_AS_NODE: '1' } },
    listing: D8_144,
    required: true,
  },
  {
    tag: '14.6.202.34',
    profile: 'profiles/14.6.202.34',
    mode: 'listing',
    listing: 'node',
    required: true,
    // node's V8 is a patched, non-sandboxed build (14.6.202.34-node.40), and
    // its FOR_EACH_INTRINSIC expansion differs from the pristine
    // 14.6.202.34 the profile was generated from: profile id 273 is
    // IsJSReceiver, node's binary prints InternalSetPrototype for the same id,
    // i.e. node's list is short by one somewhere below id 167. That shifts
    // every CallRuntime / InvokeIntrinsic *name* while changing nothing about
    // operand widths, instruction lengths or jump arithmetic. So runtime
    // callee names are counted here, not asserted; the pristine d8 14.4 pair
    // asserts them and agrees exactly, which is what shows the lookup itself
    // is right.
    assertRuntimeNames: false,
  },
];

/** Opcodes whose operands name a runtime/intrinsic callee. */
const RUNTIME_NAMING_OPCODES = /^(CallRuntime|CallRuntimeForPair|InvokeIntrinsic|CallJSRuntime)$/;

const CACHE_FLAGS = ['--no-lazy', '--no-enable-lazy-source-positions', '--max-old-space-size=1024'];
const LISTING_FLAGS = [...DEFAULT_FLAGS, '--max-old-space-size=1400'];
const CORPUS_DIR = 'corpus/features/disasm';
const WORK = 'scratch/t5/oracle';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const ONLY = arg('only', null);
const ONLY_PAIR = arg('pair', null);
const SKIP_BIG = process.argv.includes('--skip-big');

fs.mkdirSync(CORPUS_DIR, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function makeCache(cache, srcFile, outFile) {
  const engine = { exe: cache.engine.found.exe, env: cache.env };
  const r = spawnSync(engine.exe, [...CACHE_FLAGS, path.resolve('tools/disasm/make_jsc.cjs'),
    path.resolve(srcFile), path.resolve(outFile)], {
    env: { ...process.env, ...engine.env },
    encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24,
  });
  if (r.status !== 0 || !fs.existsSync(outFile)) {
    throw new Error(`cache engine failed (status ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return JSON.parse(fs.readFileSync(outFile + '.meta.json', 'utf8'));
}

/** `Star0` -> (`Star`, r0), mirroring normalize.mjs's expansion. */
function expandShortStar(ins) {
  const m = /^Star(\d+)$/.exec(ins.opcode ?? '');
  if (!m) return { opcode: ins.opcode, extraReg: null };
  return { opcode: 'Star', extraReg: `r${m[1]}` };
}

/** Erase constant-pool VALUES, keeping indices. */
function eraseConstantValues(fn) {
  return {
    ...fn,
    instructions: fn.instructions.map((ins) => ({
      ...ins,
      operands: ins.operands.map((op) => (op.kind === 'constant' ? { ...op, value: '' } : op)),
    })),
  };
}

// Two operand types V8 can name and the profile cannot: kNativeContextIndex
// (NATIVE_CONTEXT_FIELDS) and kAbortReason (src/codegen/bailout-reason.h).
// Neither is in any generated table, so src/disasm emits a shaped placeholder
// and these are counted rather than compared. Only CallJSRuntime and Abort use
// them, and Abort is only emitted under --debug-code.
const UNCOMPARABLE_OPERAND_TEXT = /^\[(nativeContextIndex_|abortReason_)/;
const OPAQUE_NAMING_OPCODES = /^(CallJSRuntime|Abort)$/;

/** Replace the names of operands the profile cannot resolve with one token. */
function eraseOpaqueNames(fn) {
  return {
    ...fn,
    instructions: fn.instructions.map((ins) => (OPAQUE_NAMING_OPCODES.test(ins.opcode ?? '')
      ? { ...ins, operands: ins.operands.map((op) => (op.kind === 'name' ? { ...op, name: 'OPAQUE' } : op)) }
      : ins)),
  };
}

function diffInstructions(mineFn, v8Fn, { skipSourcePositions = false, assertRuntimeNames = true } = {}) {
  const diffs = [];
  let uncomparableOperands = 0;
  let runtimeNameMismatches = 0;
  const n = Math.max(mineFn.instructions.length, v8Fn.instructions.length);
  for (let i = 0; i < n; i++) {
    const a = mineFn.instructions[i];
    const b = v8Fn.instructions[i];
    const at = `#${i}`;
    if (!a || !b) {
      diffs.push(`${at}: ${a ? 'extra on our side' : 'missing on our side'} (${(a ?? b).opcode} @${(a ?? b).offset})`);
      continue;
    }
    if (a.offset !== b.offset) diffs.push(`${at}: offset ${a.offset} vs ${b.offset}`);
    if (hex(a.bytes) !== hex(b.bytes)) diffs.push(`${at} @${b.offset}: bytes ${hex(a.bytes)} vs ${hex(b.bytes)}`);
    const ea = expandShortStar(a), eb = expandShortStar(b);
    if (ea.opcode !== eb.opcode) diffs.push(`${at} @${b.offset}: opcode ${a.opcode} vs ${b.opcode}`);
    if ((a.scale ?? null) !== (b.scale ?? null)) diffs.push(`${at} @${b.offset}: scale ${a.scale} vs ${b.scale}`);
    if (ea.extraReg !== eb.extraReg) diffs.push(`${at} @${b.offset}: short-star register ${ea.extraReg} vs ${eb.extraReg}`);
    if (a.operands.length !== b.operands.length) {
      diffs.push(`${at} @${b.offset}: ${a.operands.length} operands vs ${b.operands.length} (\`${a.operandText}\` | \`${b.operandText}\`)`);
    } else {
      for (let k = 0; k < a.operands.length; k++) {
        const oa = a.operands[k], ob = b.operands[k];
        if (ob.kind === 'constant' || oa.kind === 'constant') {
          if (oa.kind !== ob.kind) diffs.push(`${at} @${b.offset}: operand ${k} kind ${oa.kind} vs ${ob.kind}`);
          else if (oa.index !== ob.index) diffs.push(`${at} @${b.offset}: constant index ${oa.index} vs ${ob.index}`);
          continue;
        }
        if (UNCOMPARABLE_OPERAND_TEXT.test(oa.raw ?? '')) { uncomparableOperands++; continue; }
        if ((oa.raw ?? '') === (ob.raw ?? '')) continue;
        if (oa.kind === 'name' && ob.kind === 'name' && RUNTIME_NAMING_OPCODES.test(eb.opcode ?? '')) {
          runtimeNameMismatches++;
          if (!assertRuntimeNames) continue;
        }
        diffs.push(`${at} @${b.offset}: operand ${k} \`${oa.raw}\` vs \`${ob.raw}\``);
      }
    }
    if ((a.jumpTarget ?? null) !== (b.jumpTarget ?? null)) {
      diffs.push(`${at} @${b.offset}: jump target ${a.jumpTarget} vs ${b.jumpTarget}`);
    }
    const ja = a.jumpTable, jb = b.jumpTable;
    if (!!ja !== !!jb) diffs.push(`${at} @${b.offset}: jump table ${ja ? 'only ours' : "only V8's"}`);
    else if (ja && jb) {
      if (ja.length !== jb.length) diffs.push(`${at} @${b.offset}: jump table size ${ja.length} vs ${jb.length}`);
      else {
        for (let k = 0; k < ja.length; k++) {
          if (ja[k].caseValue !== jb[k].caseValue || ja[k].target !== jb[k].target) {
            diffs.push(`${at} @${b.offset}: jump table entry ${k} ${ja[k].caseValue}:@${ja[k].target} vs ${jb[k].caseValue}:@${jb[k].target}`);
          }
        }
      }
    }
    if (!skipSourcePositions) {
      if ((a.sourcePosition ?? null) !== (b.sourcePosition ?? null)) {
        diffs.push(`${at} @${b.offset}: source position ${a.sourcePosition} vs ${b.sourcePosition}`);
      }
      if (!!a.isStatement !== !!b.isStatement) diffs.push(`${at} @${b.offset}: isStatement ${a.isStatement} vs ${b.isStatement}`);
      if (!!a.isBreakable !== !!b.isBreakable) diffs.push(`${at} @${b.offset}: isBreakable ${a.isBreakable} vs ${b.isBreakable}`);
    }
  }
  return { diffs, uncomparableOperands, runtimeNameMismatches };
}

/** Erase runtime/intrinsic callee names, for the normalised compare on a
 *  non-pristine engine (see PAIRS[].assertRuntimeNames). */
function eraseRuntimeNames(fn) {
  return {
    ...fn,
    instructions: fn.instructions.map((ins) => (RUNTIME_NAMING_OPCODES.test(ins.opcode ?? '')
      ? { ...ins, operands: ins.operands.map((op) => (op.kind === 'name' ? { ...op, name: 'CALLEE' } : op)) }
      : ins)),
  };
}

/** Drop source positions from a parsed function, for the listing-mode compare. */
function stripSourcePositions(fn) {
  return {
    ...fn,
    instructions: fn.instructions.map((i) => ({ ...i, sourcePosition: null, isStatement: false, isExpression: false, isBreakable: false })),
  };
}

function observeFeatures(result, seen) {
  const add = (f) => seen.add(f);
  for (const ins of result.instructions) {
    if (ins.scale === 2) add('wide');
    if (ins.scale === 4) add('extraWide');
    if (ins.jumpTable) add('jumpTable');
    if (ins.opcode === 'SwitchOnSmiNoFeedback') add('switchOnSmiNoFeedback');
    if (ins.opcode === 'SwitchOnGeneratorState') add('switchOnGeneratorState');
    if (ins.opcode === 'SuspendGenerator') add('suspendGenerator');
    if (ins.opcode === 'ResumeGenerator') add('resumeGenerator');
    if (ins.opcode === 'JumpLoop') add('jumpLoop');
    if (ins.opcode === 'Return') add('return');
    if (ins.opcode === 'ForInPrepare') add('forInPrepare');
    if (ins.opcode === 'GetIterator') add('getIterator');
    if (ins.opcode === 'CallRuntime' || ins.opcode === 'CallRuntimeForPair') add('callRuntime');
    if (ins.opcode === 'InvokeIntrinsic') add('intrinsic');
    if (ins.opcode === 'CreateClosure') add('createClosure');
    if (ins.opcode === 'CreateBlockContext') add('createBlockContext');
    if (ins.opcode === 'CreateObjectLiteral') add('createObjectLiteral');
    if (ins.opcode === 'CreateArrayLiteral') add('createArrayLiteral');
    if (ins.opcode === 'CreateRegExpLiteral') add('createRegExpLiteral');
    if (ins.opcode === 'GetTemplateObject') add('getTemplateObject');
    if (ins.opcode === 'TestTypeOf') add('testTypeOf');
    if (ins.opcode === 'GetSuperConstructor' || ins.opcode === 'FindNonDefaultConstructorOrConstruct') add('getSuperConstructor');
    if (ins.opcode === 'CallWithSpread' || ins.opcode === 'ConstructWithSpread') add('callWithSpread');
    if (/^CallProperty/.test(ins.opcode)) add('callProperty');
    if (/^Construct/.test(ins.opcode)) add('construct');
    if (ins.opcode === 'DeletePropertyStrict') add('deleteStrict');
    if (/^JumpIfToBoolean/.test(ins.opcode)) add('toBooleanJump');
    if (ins.opcode === 'JumpIfUndefinedOrNull') add('jumpIfUndefinedOrNull');
    if (/^Jump/.test(ins.opcode) && ins.opcode !== 'JumpLoop') add('forwardJump');
    if (/^JumpIf/.test(ins.opcode)) add('conditionalJump');
    if (/Smi$/.test(ins.opcode)) add('smiOps');
    if (/^Test(Equal|LessThan|GreaterThan|In|Instanceof)/.test(ins.opcode)) add('compareOps');
    if (/Lookup/.test(ins.opcode)) add('lookupSlot');
    for (const o of ins.operands) {
      if (o.type === 'kRegList') add('regList');
      if (o.type === 'kRegOutList') add('regOutList');
      if (o.type === 'kRegOutPair' || o.type === 'kRegPair') add('regOutPair');
      if (o.type === 'kRegOutTriple') add('regOutTriple');
      if (o.type === 'kFeedbackSlot') add('feedbackSlot');
      if (o.type === 'kContextSlot') add('contextSlot');
      if (o.type === 'kFlag8') add('flag8');
      if (o.type === 'kFlag16' || o.type === 'kEmbeddedFeedback') add('flag16');
      if (o.reg?.k === 'local' && o.reg.i > 127) add('wideRegister');
      if (o.type === 'kRuntimeId' && o.name === 'DefineClass') add('defineClass');
      if (o.type === 'kRuntimeId' && /^(Throw|Create|CopyData)/.test(o.name ?? '')) add('runtimeNamed');
    }
  }
  if ((result.unit.handlers ?? []).length) add('handlerTable');
  return seen;
}

// ---------------------------------------------------------------------------

const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let hardFailures = 0;
const featuresSeen = new Set();
const summary = [];
const skipped = [];
const ALLOW_SKIP = process.argv.includes('--allow-skip');

/**
 * Report a mode that cannot run.
 * @returns {boolean} true if the caller may carry on anyway (it cannot)
 */
function record(pair, why) {
  const name = pair.label ?? `profile ${pair.tag}`;
  const hard = pair.required && !ALLOW_SKIP && !ONLY_PAIR;
  skipped.push({ name, mode: pair.mode, why, hard });
  if (hard) {
    hardFailures++;
    say(`::error::NOT MEASURED (\`${pair.mode}\`): ${why}`);
    say(`FAIL: ${name} -- input mode \`${pair.mode}\` did not run, and this mode is required.`);
    say('      Pass --allow-skip to downgrade this to a skip.');
  } else {
    say(`SKIP: ${why}`);
  }
  return false;
}

/** A `findCachedEngine` result -> run it, or report why not. */
function skipPair(pair, what, found) {
  if (found === null) return true;           // this mode needs no such engine
  if (found.found) return true;
  return record(pair, `${what}: ${found.why}`
    + (found.considered.length ? `; considered ${found.considered.join(', ')}` : ''));
}

for (const s of SOURCES) fs.writeFileSync(path.join(CORPUS_DIR, `${s.name}.js`), s.source);
say('# src/disasm oracle agreement');
say('');
say(`corpus: ${SOURCES.length} sources in ${CORPUS_DIR}/`);
say(`listing flags: ${LISTING_FLAGS.join(' ')}`);
say('');

for (const pair of PAIRS) {
  if (ONLY_PAIR && pair.tag !== ONLY_PAIR && pair.label !== ONLY_PAIR) continue;
  say('='.repeat(78));
  say(`## ${pair.label ?? `profile ${pair.tag}`} -- input mode \`${pair.mode}\``);
  say('');
  // A skip must not read as a pass. `required` modes count a missing engine
  // as a hard failure, because the whole point of this file is that the claim
  // is defended wherever it runs -- and a green job that measured nothing is
  // worse than a red one. `--allow-skip` is for a developer with one of the
  // two engines, and it says so in the output.
  if (!skipPair(pair, 'cache engine', pair.mode.startsWith('cache') ? pair.cache.engine : null)) continue;
  if (pair.mode === 'cache-t4' && !(await haveRealCachePath())) {
    if (!record(pair, 'src/cache + src/heap are not available yet (that is the point of adapter_legacy)')) continue;
  }
  if (!skipPair(pair, 'listing engine', typeof pair.listing === 'string' ? null : pair.listing)) continue;
  let listingEngine;
  try {
    listingEngine = resolveEngine(typeof pair.listing === 'string' ? pair.listing : pair.listing.found.exe);
    // `d8` alone does not say which build ran, and "which build ran" is the
    // whole question this file was failing to answer on CI.
    if (typeof pair.listing !== 'string') {
      const f = pair.listing.found;
      listingEngine.label = `d8 ${f.version} (${f.platform})`;
    }
  } catch (e) {
    if (!record(pair, `listing engine: ${e.message}`)) continue;
  }
  if (!listingEngine) continue;
  const profile = loadProfile(pair.profile);
  const jscDir = path.join(WORK, pair.tag);
  fs.mkdirSync(jscDir, { recursive: true });
  if (pair.mode.startsWith('cache')) {
    const f = pair.cache.engine.found;
    say(`cache engine  : ${pair.cache.label} -- ${f.exe} (v${f.version}, ${f.platform})`);
  } else say('cache engine  : none -- FunctionUnits are reconstructed from the listing (see tools/disasm/unit_from_listing.mjs)');
  say(`unit source   : ${pair.mode === 'cache' ? 'src/disasm/adapter_legacy.mjs'
    : pair.mode === 'cache-t4' ? 'src/cache + src/heap (T4)' : 'tools/disasm/unit_from_listing.mjs'}`);
  say(`listing engine: ${listingEngine.label}`);
  say(`profile       : ${profile.version} (${profile.variant})`);
  say('');
  say('| source | fns paired | instrs | direct diffs | normalised exact | jump tables | jt entries | wide | xwide | note |');
  say('|---|---:|---:|---:|---|---:|---:|---:|---:|---|');

  let totalInstr = 0, totalDiffs = 0, totalFns = 0, exactFns = 0, totalTables = 0, totalTableEntries = 0;
  let totalUncomparable = 0, unpaired = 0, wideAll = 0, xwideAll = 0, runtimeNameMismatches = 0;
  const lengthMismatchByOpcode = new Map();
  const details = [];

  for (const s of SOURCES) {
    if (ONLY && s.name !== ONLY) continue;
    if (SKIP_BIG && s.big) continue;
    const srcFile = path.join(CORPUS_DIR, `${s.name}.js`);
    let note = '';

    // --- V8's side -------------------------------------------------------
    let parsed, pools = [];
    try {
      const run = printBytecode(listingEngine, s.source, {
        name: `${pair.tag}__${s.name}`, workDir: path.join(WORK, 'listings'), flags: LISTING_FLAGS,
      });
      parsed = parseBytecodeDump(run.text);
      pools = poolsFromRawListing(run.text);
      if (parsed.unparsedLines.length) note += `${parsed.unparsedLines.length} unparsed listing lines; `;
    } catch (e) {
      say(`| ${s.name} | - | - | - | - | - | - | - | - | LISTING FAILED: ${e.message.slice(0, 100)} |`); hardFailures++; continue;
    }

    // --- our side --------------------------------------------------------
    const mine = [];
    try {
      if (pair.mode === 'cache' || pair.mode === 'cache-t4') {
        const jscFile = path.join(jscDir, `${s.name}.jsc`);
        if (!fs.existsSync(jscFile)) makeCache(pair.cache, srcFile, jscFile);
        const units = pair.mode === 'cache'
          ? unitsFromJsc(jscFile, profile).units
          : (await unitsFromCache(jscFile, pair.profile)).units;
        for (const u of units) mine.push(disassemble(u, { profile, strict: false }));
      } else {
        parsed.functions.forEach((fn, i) => {
          mine.push(disassemble(unitFromListing(fn, { profile, pool: pools[i] }), { profile, strict: false }));
        });
      }
    } catch (e) {
      say(`| ${s.name} | - | - | - | - | - | - | - | - | INPUT FAILED: ${e.message.slice(0, 140)} |`); hardFailures++; continue;
    }
    const ours = mine.map((r) => {
      observeFeatures(r, featuresSeen);
      for (const [k, v] of r.stats.lengthMismatch) lengthMismatchByOpcode.set(k, (lengthMismatchByOpcode.get(k) ?? 0) + v);
      return { result: r, parsed: toParsedForm(r), key: r.unit.bytecode.toString('hex') };
    });

    // --- pair by bytecode bytes -----------------------------------------
    const byKey = new Map();
    ours.forEach((o, i) => {
      if (!byKey.has(o.key)) byKey.set(o.key, []);
      byKey.get(o.key).push(i);
    });
    const used = new Set();
    let paired = 0, diffsHere = 0, exactHere = 0, instrHere = 0, tablesHere = 0, entriesHere = 0, wideHere = 0, xwideHere = 0;
    const v8Unpaired = [];
    for (const v8Fn of parsed.functions) {
      const key = hex(v8Fn.instructions.flatMap((i) => i.bytes));
      const cands = byKey.get(key);
      const j = cands?.find((k) => !used.has(k));
      if (j === undefined) { v8Unpaired.push(`${v8Fn.name || '<anon>'}(len ${v8Fn.bytecodeLength})`); continue; }
      used.add(j);
      paired++;
      const m = ours[j];
      instrHere += v8Fn.instructions.length;
      tablesHere += m.result.stats.jumpTables;
      entriesHere += m.result.stats.jumpTableEntries;
      wideHere += m.result.stats.prefixed - m.result.instructions.filter((i) => i.scale === 4).length;
      xwideHere += m.result.instructions.filter((i) => i.scale === 4).length;
      const skipSP = pair.mode === 'listing';
      const assertNames = pair.assertRuntimeNames !== false;
      const d = diffInstructions(m.parsed, v8Fn, { skipSourcePositions: skipSP, assertRuntimeNames: assertNames });
      totalUncomparable += d.uncomparableOperands;
      runtimeNameMismatches += d.runtimeNameMismatches;
      diffsHere += d.diffs.length;
      if (d.diffs.length) details.push({ source: s.name, fn: v8Fn.name || '<anon>', diffs: d.diffs.slice(0, 10), total: d.diffs.length });
      let lhs = skipSP ? stripSourcePositions(m.parsed) : m.parsed;
      let rhs = skipSP ? stripSourcePositions(v8Fn) : v8Fn;
      lhs = eraseOpaqueNames(eraseConstantValues(lhs));
      rhs = eraseOpaqueNames(eraseConstantValues(rhs));
      if (!assertNames) { lhs = eraseRuntimeNames(lhs); rhs = eraseRuntimeNames(rhs); }
      const cmp = compareFunctions(normalizeFunction(lhs), normalizeFunction(rhs));
      if (cmp.exactMatch) exactHere++;
      else details.push({
        source: s.name, fn: v8Fn.name || '<anon>', normalised: true, total: 1,
        diffs: cmp.firstDivergence
          ? [`normalised divergence at ${cmp.firstDivergence.index}: \`${cmp.firstDivergence.left}\` vs \`${cmp.firstDivergence.right}\``]
          : [`normalised streams differ (handlerMatch=${cmp.handlerMatch}, counts ${cmp.instructionCounts.join('/')})`],
      });
    }
    const allowed = s.allowUnpaired ?? 0;
    if (v8Unpaired.length) {
      note += `V8 functions not paired: ${v8Unpaired.join(', ')}${v8Unpaired.length <= allowed ? ' (expected)' : ''}; `;
      if (v8Unpaired.length > allowed) unpaired += v8Unpaired.length - allowed;
    }
    const extra = ours.length - used.size;
    if (extra > 0) note += `${extra} of our units had no V8 counterpart; `;

    totalFns += paired; exactFns += exactHere; totalInstr += instrHere;
    totalDiffs += diffsHere; totalTables += tablesHere; totalTableEntries += entriesHere;
    wideAll += wideHere; xwideAll += xwideHere;
    say(`| ${s.name} | ${paired}/${parsed.functions.length} | ${instrHere} | ${diffsHere} | ${exactHere}/${paired} | ${tablesHere} | ${entriesHere} | ${wideHere} | ${xwideHere} | ${note || 'ok'} |`);
    if (diffsHere || exactHere !== paired || v8Unpaired.length > allowed) hardFailures++;
  }

  say('');
  say(`functions paired             : ${totalFns}`);
  say(`instructions compared        : ${totalInstr}`);
  say(`direct per-instruction diffs : ${totalDiffs}  ${totalDiffs === 0 ? 'PASS' : 'FAIL'}`);
  say(`normalised exactMatch        : ${exactFns}/${totalFns}  ${exactFns === totalFns ? 'PASS' : 'FAIL'}`);
  say(`V8 functions left unpaired   : ${unpaired}  ${unpaired === 0 ? 'PASS' : 'FAIL'}`);
  say(`jump tables decoded          : ${totalTables} (${totalTableEntries} entries)`);
  say(`Wide / ExtraWide instructions: ${wideAll} / ${xwideAll}`);
  say(`length-vs-profile mismatches : ${lengthMismatchByOpcode.size === 0 ? 0 : [...lengthMismatchByOpcode].map(([k, v]) => `${k}:${v}`).join(' ')}`
    + `  ${lengthMismatchByOpcode.size === 0 ? 'PASS' : 'FAIL'}`);
  say(`operands V8 names but the profile cannot (kNativeContextIndex / kAbortReason): ${totalUncomparable}`);
  say(`runtime/intrinsic callee-name mismatches: ${runtimeNameMismatches}`
    + (pair.assertRuntimeNames === false ? ' (counted, not asserted -- engine build differs from the profile)' : `  ${runtimeNameMismatches === 0 ? 'PASS' : 'FAIL'}`));
  if (lengthMismatchByOpcode.size) hardFailures++;
  summary.push({
    tag: pair.tag, mode: pair.mode, engine: listingEngine.label,
    unitSource: pair.mode === 'cache' ? 'adapter_legacy' : pair.mode === 'cache-t4' ? 'src/cache + src/heap' : 'from listing',
    totalFns, exactFns, totalInstr, totalDiffs, unpaired, totalTables, totalTableEntries,
    wideAll, xwideAll, runtimeNameMismatches, assertNames: pair.assertRuntimeNames !== false,
  });
  say('');
  if (details.length) {
    say('### divergences');
    say('');
    for (const d of details.slice(0, 40)) {
      say(`* **${d.source}** / \`${d.fn}\`${d.normalised ? ' (normalised)' : ''} -- ${d.total} difference(s)`);
      for (const x of d.diffs) say(`  * ${x}`);
    }
    say('');
  }
}

say('='.repeat(78));
say('## agreement table');
say('');
say('| profile | input mode | unit source | listing engine | functions | exact | instructions | diffs | unpaired | jump tables | jt entries | Wide | ExtraWide | callee-name mismatches |');
say('|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const r of summary) {
  say(`| ${r.tag} | ${r.mode} | ${r.unitSource} | ${r.engine} | ${r.totalFns} | ${r.exactFns}/${r.totalFns} | ${r.totalInstr} | ${r.totalDiffs} | ${r.unpaired} | ${r.totalTables} | ${r.totalTableEntries} | ${r.wideAll} | ${r.xwideAll} | ${r.runtimeNameMismatches}${r.assertNames ? ' (asserted 0)' : ' (not asserted)'} |`);
}
say('');
say('## feature coverage');
say('');
const missing = WANTED.filter((f) => !featuresSeen.has(f));
say(`features the corpus claims : ${WANTED.length}`);
say(`features actually observed : ${featuresSeen.size}`);
say(`claimed but never observed : ${missing.length ? missing.join(', ') : '(none)'}  ${missing.length === 0 ? 'PASS' : 'FAIL'}`);
if (missing.length && !ONLY && !SKIP_BIG) hardFailures++;

// --------------------------------------------------------------- assertions
//
// docs/DISASM.md 10 and legacy/README.md both cite this file for a specific
// claim: TWO independent FunctionUnit readers, `cache` through
// src/disasm/adapter_legacy.mjs and `cache-t4` through src/cache + src/heap,
// agree with V8's own listing instruction-exact over the same functions. The
// table above used to be the only statement of that, which meant a mode that
// never ran still printed a green last line. These turn it into a check.
say('');
say('## asserted');
say('');
let assertionFailures = 0;
const assert = (ok, what, detail) => {
  if (!ok) { assertionFailures++; hardFailures++; }
  say(`* ${ok ? 'PASS' : '**FAIL**'} -- ${what}${detail ? `: ${detail}` : ''}`);
};

for (const pair of PAIRS) {
  if (ONLY_PAIR && pair.tag !== ONLY_PAIR && pair.label !== ONLY_PAIR) continue;
  const name = pair.label ?? `profile ${pair.tag}`;
  const row = summary.find((r) => r.mode === pair.mode && r.tag === pair.tag);
  if (!pair.required) continue;
  assert(!!row, `the required mode \`${pair.mode}\` of ${name} ran`,
    row ? `${row.totalFns} functions` : (skipped.find((s) => s.mode === pair.mode)?.why ?? 'no row'));
  if (!row) continue;
  assert(row.totalFns > 0, `\`${pair.mode}\` paired at least one function`, `${row.totalFns}`);
  assert(row.totalDiffs === 0, `\`${pair.mode}\` has no direct per-instruction diff`, `${row.totalDiffs}`);
  assert(row.exactFns === row.totalFns, `\`${pair.mode}\` is normalised-exact on every function`,
    `${row.exactFns}/${row.totalFns}`);
  assert(row.unpaired === 0, `\`${pair.mode}\` left no V8 function unpaired`, `${row.unpaired}`);
}

// The dual-reader claim itself: the two 14.4 modes read the SAME .jsc files
// through two different front ends, so they must see the same functions and
// the same instruction count. Different numbers would mean one reader is
// silently dropping units and the per-mode PASS lines above would both still
// be green.
const dual = summary.filter((r) => r.mode === 'cache' || r.mode === 'cache-t4');
if (!ONLY_PAIR) {
  assert(dual.length === 2, 'both 14.4 input paths ran',
    dual.length ? dual.map((r) => r.mode).join(' + ') : 'neither did');
  if (dual.length === 2) {
    assert(dual[0].totalFns === dual[1].totalFns && dual[0].totalInstr === dual[1].totalInstr,
      'adapter_legacy and src/cache + src/heap read the same functions and instructions',
      dual.map((r) => `${r.mode} ${r.totalFns}/${r.totalInstr}`).join(' vs '));
  }
}
if (skipped.length) {
  say('');
  say(`modes not measured: ${skipped.map((s) => `${s.mode} (${s.hard ? 'FAILED' : 'skipped'})`).join(', ')}`);
}

say('');
say('='.repeat(78));
say(hardFailures === 0 ? 'ORACLE AGREEMENT: ALL CHECKS PASSED' : `ORACLE AGREEMENT: ${hardFailures} CHECK(S) FAILED`
  + (assertionFailures ? ` (${assertionFailures} of them asserted above)` : ''));

fs.writeFileSync('scratch/t5/ORACLE_AGREEMENT.md', L.join('\n') + '\n');
console.log('\nwrote scratch/t5/ORACLE_AGREEMENT.md');
process.exitCode = hardFailures === 0 ? 0 : 1;
