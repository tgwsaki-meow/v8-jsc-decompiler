// O1 on the real corpus -- bytecode equivalence for one `extracted_jsc/*.jsc`.
//
//   stream A   corpus .jsc                            ──our decoder──→ bytecode
//   stream B   our output ──compile only──→ .jsc      ──our decoder──→ bytecode
//                          normalise, pair, compare, classify
//
// ===========================================================================
// WHY THIS CAN EXIST AT ALL, GIVEN THAT o1_bytecode.mjs SAYS IT CANNOT
// ===========================================================================
//
// `o1_bytecode.mjs` gets both streams from a real V8 via `--print-bytecode`,
// and a V8 run EXECUTES the script after printing. There is no compile-only
// `--print-bytecode`. That is why fixture O1 is restricted to code we wrote.
//
// The blocker is the PRINTING, not the comparing. Nothing in the pipeline
// below needs an engine to print anything:
//
//   * stream A is decoded from the corpus cache by `src/disasm`, which is the
//     instrument `tools/disasm/oracle_agreement.mjs` measured instruction-exact
//     on 1680/1680 functions against V8's own listing, and which
//     `tests/t4/acceptance.mjs` covers with 1200 assertions / 0 failures.
//   * stream B needs a `.jsc` for our own output, and `new vm.Script(src,
//     {produceCachedData:true})` produces one while running nothing. Under
//     `--no-lazy` every function in the text is compiled during the
//     constructor, so the cache is as eager as the corpus is (ARCHITECTURE.md
//     9.4: 239979 SFI = 239979 BytecodeArray, 0 UncompiledData). Measured
//     here: without `--no-lazy` a two-inner-function script yields 1
//     BytecodeArray, with it 4.
//   * stream B is then decoded by the SAME `src/disasm`.
//
// Both streams go through one decoder and one normaliser, so a decoder bug
// cancels instead of biasing -- the opposite trade from o1_bytecode.mjs, which
// gets engine truth at the price of having to run the program.
//
// EXECUTION POLICY. `extracted_jsc/`, `decompiled_js/`, `linuxQQ/` and
// anything derived from them are never executed. `assertNeverExecuted()` and
// `assertCompileOnlySpawn()` below enforce it on the argv of every child this
// module starts, in the same spirit as `corpus.mjs::assertExecutable` does for
// the other direction. The work directory is deliberately NOT under
// `scratch/t3/work`, because `corpus.mjs::WORK_ROOTS` declares that tree
// executable for O3; output derived from the corpus must never land there.
//
// ===========================================================================
// WHAT IS ERASED BEYOND normalize.mjs's CONTRACT, AND WHY
// ===========================================================================
//
// `normalize.mjs` already erases register numbers, feedback slots, constant
// pool indices and jump offsets, and documents why each is an allocation
// artefact. Applied to two caches produced by two different serializer runs it
// is not quite enough, because one class of token still carries a per-cache
// identifier:
//
//   `<SharedFunctionInfo #123 foo>`  `<ScopeInfo #45 BLOCK_SCOPE>`
//
// The `#N` is `src/heap`'s object id -- the slot the object happens to occupy
// in THAT cache's object graph. V8's own listing prints no such number
// (`<SharedFunctionInfo foo>`); `src/disasm/format.mjs::renderConstant` adds it
// because a decoder reader wants it. Comparing it across two caches compares
// two unrelated counters, so `CreateClosure` would mismatch in every function
// that makes a closure, for a reason that has nothing to do with the program.
//
// `eraseAllocationIds()` therefore rewrites `#<digits>` to `#*` inside a
// `<...>` descriptor, on BOTH streams, and the count is reported per file
// (`erasure.allocationIds`) so the reader can see how much of the match rate
// rests on it. The descriptor's TYPE and NAME survive, which is what carries
// meaning: `<SharedFunctionInfo #* foo>` still differs from
// `<SharedFunctionInfo #* bar>` and from `<ScopeInfo #* BLOCK_SCOPE>`.
//
// Nothing else is added. In particular NOT erased, though it would raise the
// number: the function name inside a descriptor, boilerplate descriptor
// lengths, flag immediates, parameter registers, register-range lengths.
//
// ===========================================================================
// WHAT THIS PATH SEES THAT THE FIXTURE PATH CANNOT: LITERAL ELEMENT VALUES
// ===========================================================================
//
// `o1_bytecode.mjs` declares a blind spot, and its reason is exact: V8 prints
// an array or object literal as `<ArrayBoilerplateDescription
// PACKED_SMI_ELEMENTS, <FixedArray[3]>>` and never prints the element values
// (tools/probes/probe_pool.mjs), so on a path whose stream A IS a real V8
// listing, `f([1,2,3])` and `f([2,2,3])` are the same text.
//
// That reason does not apply here. BOTH of this path's streams come from our
// own decoder, and the decoder already reads the values:
// `src/heap/objects.mjs::decodeArrayBoilerplate` returns `elements`,
// `decodeObjectBoilerplate` returns `entries`, and the `DeclareGlobals`
// declaration array arrives decoded as `{t:'array', className:'FixedArray',
// values:[sfi, slot, "topVar", ...]}`. The values were being dropped one layer
// later, in `src/disasm/format.mjs::renderConstant`, which prints a length and
// no contents -- correctly, because that is V8's text and
// `tools/disasm/oracle_agreement.mjs` measures that renderer against V8's own
// listing instruction-exact on 1680/1680 functions. The blind spot on this
// path was therefore self-inflicted by code reuse, not inherited from the
// engine, and closing it costs no execution and no new oracle.
//
// `toParsedForm(d, {literalValues: true})` below renders the contents on both
// streams through a SECOND renderer that the V8-agreement path never asks for.
// The default renderer is untouched, which is why that measurement -- the one
// the "both streams through one decoder" argument rests on -- is unaffected.
// `normalize.mjs` is untouched too, for the same reason: oracle_agreement.mjs
// normalises with it.
//
// Four residuals remain. Each is named and counted per file, in `literalA` /
// `literalB`, so none of them is an unqualified claim:
//
//   `refused.FixedDoubleArrayMap`
//        an array literal whose elements are all doubles. V8 stores those in a
//        FixedDoubleArray, whose layout is `@cppObjectLayoutDefinition`, so
//        `layouts.json` carries no class for it, and whose Torque element type
//        (`float64_or_undefined_or_hole`) is a 9-byte struct against the
//        8-byte on-heap double, so the stride cannot be taken from the profile
//        either. The decoder refuses by map name instead of guessing a stride,
//        and the renderer prints `!undecoded:FixedDoubleArrayMap`. Two
//        different double literals therefore still compare equal, with that
//        name attached. Fixing it is `tools/profilegen` work -- the stride is a
//        fact about V8 and belongs in a profile derived from pinned sources,
//        never a literal in a reader. The elements KIND is now rendered, so
//        `[1.5]` against `[1,2]` is visible even here; `[1.5]` against `[2.5]`
//        is not.
//   `idsOmitted`
//        a container-internal reference to a SharedFunctionInfo or a ScopeInfo.
//        `src/heap` identifies those by per-cache object id and carries no
//        name, so the id is erased at render time, in the same `#*` spelling
//        `eraseAllocationIds` uses at top level (see renderConstantDeep).
//        Consequence for `DeclareGlobals`: every declared VAR name is now
//        compared (it is a string), and so are the position and arity of every
//        declared function, but WHICH function a declaration points at is not.
//   `hashed`
//        a container above the inline cap is compared by a sha256 of its
//        rendered contents. A difference is still detected; it is not legible
//        in the diff.
//   quoted `#<digits>` inside a literal string
//        `eraseAllocationIds` used to rewrite them. `{color:"#333"}` is
//        everywhere in bundled code, and with literal values rendered those
//        strings now sit inside a `<...>` descriptor, which is the only context
//        the erasure looks at. It is therefore quote-aware now, and the one
//        case it still cannot resolve -- a string containing an unescaped `"`,
//        which V8's own PrintUC16 does not escape -- is noted at the function.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadUnits } from '../load/index.mjs';
import { disassemble } from '../disasm/index.mjs';
import { toParsedForm } from '../disasm/format.mjs';
import { normalizeFunction } from './normalize.mjs';
import { compareFunctions, lcsLength } from './compare.mjs';
import { pairFunctions } from './o1_bytecode.mjs';
import { readJscHeader, findElectron } from './mint.mjs';

// ---------------------------------------------------------------------------
// execution policy
// ---------------------------------------------------------------------------

/** Trees whose contents, and whose derivatives, must never be executed. */
export const NEVER_EXECUTE = ['extracted_jsc', 'decompiled_js', 'linuxQQ'].map((d) => path.resolve(d));
/** `corpus.mjs` declares this tree executable for O3. Nothing corpus-derived may land in it. */
const O3_EXECUTABLE_TREE = path.resolve('scratch/t3/work');

export class ExecutionPolicyError extends Error {}

const inside = (p, root) => { const a = path.resolve(p); return a === root || a.startsWith(root + path.sep); };

/** True when `p` is corpus code, or output derived from it. */
export function isCorpusDerived(p) {
  const abs = path.resolve(p);
  return NEVER_EXECUTE.some((bad) => inside(abs, bad)) || /\.(B|r1|r2)\.(jsc|js)$/.test(abs);
}

/**
 * Refuse to make `p` the program a process runs.
 *
 * Corpus-derived text is allowed to be COMPILED -- that is the whole method --
 * but it must never be the script an interpreter executes. This is the check
 * for the script position of an argv; `assertCompileOnlySpawn` applies it.
 */
export function assertNeverExecuted(p) {
  const abs = path.resolve(p);
  for (const bad of NEVER_EXECUTE) {
    if (inside(abs, bad)) {
      throw new ExecutionPolicyError(
        `refusing to run ${abs}: ${path.basename(bad)}/ is third-party code and is only ever read`);
    }
  }
  return abs;
}

/** Throw if a corpus-derived artefact is about to be written where O3 may run it. */
export function assertNotInExecutableTree(p) {
  if (inside(p, O3_EXECUTABLE_TREE)) {
    throw new ExecutionPolicyError(
      `refusing to write corpus-derived output to ${path.resolve(p)}: corpus.mjs::WORK_ROOTS `
      + 'declares scratch/t3/work executable for O3, and corpus-derived text must never be runnable');
  }
  return path.resolve(p);
}

/** The only child script this module is allowed to hand corpus-derived text to. */
const MINT_CHILD = path.resolve('src/verify/mint_child.cjs');
/** Engine flags that would make the child run, rather than compile, its input. */
const EXECUTING_FLAGS = [/^-e$/, /^--eval/, /^-p$/, /^--print$/, /^--print-bytecode/, /^--require/, /^-r$/, /^--import/, /^--input-type/];

/**
 * Assert that an argv about to be spawned compiles its input and cannot run it.
 *
 * This is the structural half of the policy: the only engine this module
 * starts is `mint_child.cjs`, whose whole body is `new vm.Script(src,
 * {produceCachedData:true})` / `createCachedData()` -- no `runInThisContext`,
 * no `vm.runInNewContext`, no module linking. Anything else, or any flag that
 * would evaluate the argument instead of compiling a file, is refused here
 * rather than reviewed later.
 */
export function assertCompileOnlySpawn(argv) {
  const script = argv.find((a) => !a.startsWith('-'));
  assertNeverExecuted(script ?? '');
  if (path.resolve(script ?? '') !== MINT_CHILD) {
    throw new ExecutionPolicyError(
      `refusing to spawn an engine on corpus-derived text with ${script}: `
      + `only ${MINT_CHILD} (compile-only) is allowed`);
  }
  for (const a of argv) {
    if (a === script) break;
    for (const re of EXECUTING_FLAGS) {
      if (re.test(a)) throw new ExecutionPolicyError(`refusing engine flag ${a}: it evaluates rather than compiles`);
    }
  }
  return argv;
}

// ---------------------------------------------------------------------------
// the extra erasure, counted
// ---------------------------------------------------------------------------

const ALLOC_ID_RE = /(<[^<>]*?)#\d+/g;

/**
 * The [start, end) spans of double-quoted runs in one normalised instruction.
 *
 * Needed because a `#<digits>` inside a STRING is content, not an allocation
 * id: `{color:"#333"}` is everywhere in bundled code, and now that literal
 * element values are rendered, such a string sits inside a `<...>` descriptor
 * -- the only context the id erasure looks at. Erasing it would be
 * deterministic on both streams, so it would not break an equality; it would
 * make `["#333"]` and `["#334"]` compare EQUAL, which is a blind spot and the
 * thing this change exists to remove.
 *
 * Limit: `renderConstant` escapes a string the way V8's String::PrintUC16
 * does, and that does not escape `"`, so a string value containing a quote
 * makes the spans after it ambiguous. The scan stays deterministic (same text
 * in, same spans out, on both streams), so the cost is precision inside such a
 * string, never a false equality between two different streams.
 */
function quotedSpans(text) {
  const spans = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++;
    if (bs % 2 === 1) continue;                 // an escaped quote
    if (start < 0) start = i; else { spans.push([start, i + 1]); start = -1; }
  }
  if (start >= 0) spans.push([start, text.length]);
  return spans;
}

/**
 * Rewrite per-cache object ids inside heap-object descriptors to `#*`.
 * @returns {{text: string, erased: number}}
 */
export function eraseAllocationIds(text) {
  if (!text.includes('#')) return { text, erased: 0 };
  const spans = text.includes('"') ? quotedSpans(text) : null;
  let erased = 0;
  const out = text.replace(ALLOC_ID_RE, (m, head, at) => {
    const hash = at + head.length;
    if (spans && spans.some(([s, e]) => hash >= s && hash < e)) return m;
    erased++;
    return head + '#*';
  });
  return { text: out, erased };
}

const SFI_NAME_RE = /<SharedFunctionInfo #\*[^>]*>/g;

/**
 * Erase the function NAME inside a `<SharedFunctionInfo …>` constant.
 *
 * NOT part of the normalisation, and deliberately not folded into the match
 * rate. It exists because `CreateClosure` names its target's SFI, and the name
 * of an anonymous function literal is information the `.jsc` does not carry
 * (the emitter has to invent one to emit a declaration at all), which is
 * exactly the class of loss the owner accepts as unrecoverable. Keeping it
 * makes every closure creation of an anonymous function mismatch; erasing it
 * silently would hide a real renaming of a NAMED function.
 *
 * So both numbers are reported: `exactFunctions` keeps the name,
 * `exactModuloClosureNames` erases it, and the gap between them is the cost of
 * that one decision.
 */
export function stripClosureNames(s) {
  return s.replace(SFI_NAME_RE, '<SharedFunctionInfo #*>');
}

// ---------------------------------------------------------------------------
// erasure accounting -- how many operand fields the measurement threw away
// ---------------------------------------------------------------------------

/**
 * Count, over one function's parsed instructions, every operand field whose
 * value the normaliser replaced. Two tiers, kept apart on purpose:
 *
 *   `valueErased`    the value itself is gone and only its PRESENCE is
 *                    compared: feedback slot indices. A wrong feedback slot
 *                    cannot be detected -- which is sound, because the index
 *                    is a running counter, but it is an erasure of a value.
 *   `encodingErased` the value survives in another spelling: a register index
 *                    becomes a first-appearance class (def/use preserved), a
 *                    constant index becomes the constant, a jump delta becomes
 *                    a label on the target instruction, a `.Wide` prefix is
 *                    dropped because the four values that force it are erased.
 *
 * Reported per file so "51% match with 9 operand fields erased per
 * instruction" cannot hide behind the percentage.
 */
export function erasureProfile(fn) {
  const e = {
    instructions: fn.instructions.length,
    operands: 0,
    registerClass: 0, parameterKept: 0, specialRegKept: 0, regRange: 0,
    feedbackSlot: 0, constantIndex: 0, jumpDelta: 0, immKept: 0, flagKept: 0,
    nameKept: 0, otherOperand: 0,
    scalePrefix: 0, sourcePosition: 0, unresolvedConstant: 0,
  };
  for (const ins of fn.instructions) {
    if (ins.scale) e.scalePrefix++;
    if (ins.sourcePosition != null) e.sourcePosition++;
    for (let i = 0; i < ins.operands.length; i++) {
      const op = ins.operands[i];
      e.operands++;
      switch (op.kind) {
        case 'reg': e.registerClass++; break;
        case 'regRange': e.regRange++; break;
        case 'param': e.parameterKept++; break;
        case 'specialReg': e.specialRegKept++; break;
        case 'feedback': case 'embeddedFeedback': e.feedbackSlot++; break;
        case 'constant':
          e.constantIndex++;
          if (op.value == null || op.value === '') e.unresolvedConstant++;
          break;
        case 'imm':
          if (/^Jump/.test(ins.opcode ?? '') && i === 0) e.jumpDelta++; else e.immKept++;
          break;
        case 'flag': e.flagKept++; break;
        case 'name': e.nameKept++; break;
        default: e.otherOperand++;
      }
    }
  }
  e.valueErased = e.feedbackSlot;
  e.encodingErased = e.registerClass + e.regRange + e.constantIndex + e.jumpDelta + e.scalePrefix;
  return e;
}

const addInto = (acc, e) => { for (const k of Object.keys(e)) acc[k] = (acc[k] ?? 0) + e[k]; return acc; };

// ---------------------------------------------------------------------------
// one .jsc -> normalised functions, through our decoder only
// ---------------------------------------------------------------------------

/**
 * Decode and normalise every compiled function of one `.jsc`.
 *
 * `strict: false` on purpose: a unit that cannot be decoded has to become a
 * counted warning, not an exception that costs the whole file its number.
 *
 * @param {string} jscPath
 * @param {{profile: string}} opts
 */
export function normalizedFunctionsFromJsc(jscPath, opts) {
  const t0 = Date.now();
  const { units, profile, read } = loadUnits(jscPath, opts.profile, { scopeInfos: false });
  const out = [];
  const warnings = {};
  const erasure = {};
  // What the literal-value rendering did on this file: how much it showed, and
  // every case it refused, by name. Reported per file so that "literal values
  // are compared now" is a counted statement and not a claim.
  const literal = {
    constants: 0, deepened: 0, hashed: 0, idsOmitted: 0,
    functions: 0, functionsDeepened: 0, functionsRefused: 0, refused: {},
  };
  let decodeFailures = 0;
  const failures = [];
  for (const u of units) {
    if (!u.bytecode) continue;
    let d;
    try {
      d = disassemble(u, { profile, strict: false, resolveConstants: true });
    } catch (e) {
      decodeFailures++;
      if (failures.length < 6) failures.push({ sfiId: u.sfiId, name: u.name ?? null, error: String(e.message).slice(0, 200) });
      continue;
    }
    for (const w of d.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1;
    // `literalValues: true` is the whole fix for §3.5's blind spot on this
    // path, and it is legal here for one reason only: both streams are OUR
    // rendering, so both get the same richer vocabulary. The V8-agreement path
    // must keep the default -- see renderConstantDeep in src/disasm/format.mjs.
    const parsed = toParsedForm(d, { literalValues: true });
    addInto(erasure, erasureProfile(parsed));
    const lv = parsed.literalValues;
    if (lv) {
      literal.constants += lv.constants;
      literal.deepened += lv.deepened;
      literal.hashed += lv.hashed;
      literal.idsOmitted += lv.idsOmitted;
      literal.functions++;
      if (lv.deepened) literal.functionsDeepened++;
      let refusedHere = 0;
      for (const [k, v] of Object.entries(lv.refused)) { literal.refused[k] = (literal.refused[k] ?? 0) + v; refusedHere += v; }
      if (refusedHere) literal.functionsRefused++;
    }
    const n = normalizeFunction(parsed);
    // `stream` is a second full copy of `perInstruction`; nothing below reads
    // it and a 10 MB input has ~2e6 instructions.
    delete n.stream;
    let erased = 0;
    for (let i = 0; i < n.perInstruction.length; i++) {
      const r = eraseAllocationIds(n.perInstruction[i]);
      if (r.erased) { n.perInstruction[i] = r.text; erased += r.erased; }
    }
    n.sfiId = u.sfiId;
    n.bytecodeId = u.bytecodeId ?? null;
    n.isTopLevel = Boolean(u.isTopLevel);
    n.kind = u.kind ?? null;
    n.allocationIdsErased = erased;
    out.push(n);
  }
  erasure.allocationIds = out.reduce((a, f) => a + f.allocationIdsErased, 0);
  return {
    functions: out, erasure, literal, warnings, decodeFailures, failures,
    units: units.length,
    header: read?.header ?? null,
    profileVersion: profile?.version ?? null,
    elapsedMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

/**
 * Pair stream A's functions with stream B's.
 *
 * Corpus O1 has one pairing key the fixture O1 never had: our own emitter
 * records, per `sfiId`, the identifier it gave that function
 * (`src/emit/index.mjs`'s `emitName` map, surfaced as `perFunction[].name`).
 * Stream B's `.jsc` is the compilation of that very text, so V8's SFI name for
 * the function IS that identifier. Pairing on it is therefore identity by
 * construction, not a similarity guess -- it is the only mode here whose
 * result does not need a caveat, and it is reported as its own mode (`sfi`).
 *
 * Whatever it does not cover is handed to `o1_bytecode.mjs::pairFunctions`
 * unchanged, which reports `name` / `greedy` / `positional` per pair. The
 * caller must report the match rate split by mode: a number carried by
 * positional pairing means much less than one carried by `sfi`.
 *
 * Unpaired functions on either side are returned, never dropped: a function we
 * emitted that V8 did not produce, or one V8 produced that we did not emit, is
 * a result.
 */
export function pairCorpusFunctions(left, right, nameBySfi) {
  const pairs = [];
  const byName = new Map();
  right.forEach((f, i) => {
    const k = f.name ?? '';
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(i);
  });
  const usedR = new Set();
  const leftRest = [];
  // deterministic: sfiId order
  const leftSorted = [...left].sort((a, b) => (a.sfiId ?? 0) - (b.sfiId ?? 0));
  for (const lf of leftSorted) {
    const want = lf.isTopLevel ? '' : nameBySfi?.get(lf.sfiId);
    if (want === undefined || want === null) { leftRest.push(lf); continue; }
    const cands = byName.get(want);
    const j = cands?.find((k) => !usedR.has(k));
    if (j === undefined) { leftRest.push(lf); continue; }
    usedR.add(j);
    pairs.push({ left: lf, right: right[j], how: 'sfi' });
  }
  const rightRest = right.filter((_, i) => !usedR.has(i));
  let mode = pairs.length ? 'sfi' : 'none';
  let fallback = null;
  if (leftRest.length && rightRest.length) {
    fallback = pairFunctions(leftRest, rightRest);
    pairs.push(...fallback.pairs);
    mode = pairs.length === fallback.pairs.length ? fallback.mode : `sfi+${fallback.mode}`;
  }
  const pairedL = new Set(pairs.map((p) => p.left));
  const pairedR = new Set(pairs.map((p) => p.right));
  return {
    pairs, mode,
    leftOnly: left.filter((f) => !pairedL.has(f)),
    rightOnly: right.filter((f) => !pairedR.has(f)),
  };
}

// ---------------------------------------------------------------------------
// divergence classification -- the deliverable
// ---------------------------------------------------------------------------

const TEST_OPCODES = new Set([
  'TestEqual', 'TestEqualStrict', 'TestLessThan', 'TestGreaterThan',
  'TestLessThanOrEqual', 'TestGreaterThanOrEqual', 'TestReferenceEqual',
  'TestInstanceOf', 'TestIn', 'TestUndetectable', 'TestNull', 'TestUndefined',
  'TestTypeOf',
]);
const pairSet = (pairs) => {
  const m = new Map();
  for (const [a, b] of pairs) { m.set(a, b); m.set(b, a); }
  return m;
};
/** `o.x` vs `o[k]`: a keyed access where the original named the key, or vice versa. */
const NAMED_KEYED = pairSet([
  ['GetNamedProperty', 'GetKeyedProperty'],
  ['SetNamedProperty', 'SetKeyedProperty'],
  ['DefineNamedOwnProperty', 'DefineKeyedOwnProperty'],
  ['GetNamedPropertyFromSuper', 'GetKeyedProperty'],
]);
/**
 * `{x: v}` vs `o.x = v`. A real semantic change, not a spelling: Define*OwnProperty
 * creates an own data property and ignores a setter on the prototype chain,
 * Set*Property goes through it. Same for an array literal element
 * (`StaInArrayLiteral`) rewritten as a keyed store.
 */
const DEFINE_SET = pairSet([
  ['DefineNamedOwnProperty', 'SetNamedProperty'],
  ['DefineKeyedOwnProperty', 'SetKeyedProperty'],
  ['StaInArrayLiteral', 'SetKeyedProperty'],
  ['StaInArrayLiteral', 'DefineKeyedOwnProperty'],
]);
const MOVE_OPCODES = new Set(['Star', 'Ldar', 'Mov']);
const TDZ_CHECKS = new Set(['ThrowReferenceErrorIfHole', 'ThrowSuperNotCalledIfHole', 'ThrowSuperAlreadyCalledIfNotHole', 'ThrowIfNotSuperConstructor']);
const COERCIONS = new Set(['ToBoolean', 'ToName', 'ToNumber', 'ToNumeric', 'ToObject', 'ToString', 'LogicalNot', 'ToBooleanLogicalNot']);
const CALL_RE = /^(Call|Construct|InvokeIntrinsic|CallRuntime)/;
const CONTEXT_STORE_RE = /^Sta(Current)?(Immutable)?ContextSlot/;
const CONTEXT_LOAD_RE = /^Lda(Immutable)?(Current)?ContextSlot/;

/** What a single opcode is about, for the `missing-*` / `extra-*` buckets. */
function opcodeTag(o) {
  if (MOVE_OPCODES.has(o)) return 'temp-materialisation';
  if (o === 'ThrowReferenceErrorIfHole') return 'tdz-check';
  if (TDZ_CHECKS.has(o)) return 'super-check';
  if (COERCIONS.has(o)) return 'coercion';
  if (CONTEXT_STORE_RE.test(o)) return 'context-store';
  if (CONTEXT_LOAD_RE.test(o)) return 'context-load';
  if (/^(Push|Pop)Context$/.test(o)) return 'context-push';
  if (/^Jump/.test(o) || o === 'Return' || o === 'Throw' || o === 'ReThrow') return 'control-flow';
  if (CALL_RE.test(o)) return 'call';
  if (/^Create/.test(o)) return 'allocation';
  if (/Propert/.test(o)) return 'property-access';
  if (/^Throw/.test(o)) return 'throw';
  if (/^(Suspend|Resume|SwitchOnGenerator)/.test(o)) return 'generator';
  if (/^(Lda|Sta)/.test(o)) return 'load-store';
  return 'other';
}

/** Multiset difference of two opcode lists. */
function multisetDiff(a, b) {
  const count = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const ca = count(a), cb = count(b);
  const onlyA = [], onlyB = [];
  for (const [k, n] of ca) { const d = n - (cb.get(k) ?? 0); for (let i = 0; i < d; i++) onlyA.push(k); }
  for (const [k, n] of cb) { const d = n - (ca.get(k) ?? 0); for (let i = 0; i < d; i++) onlyB.push(k); }
  return { onlyA, onlyB };
}

/** Name a one-for-one opcode substitution. */
function classifyOpcodePair(A, B) {
  if (TEST_OPCODES.has(A) && TEST_OPCODES.has(B)) return 'compare-opcode';
  if (NAMED_KEYED.get(A) === B) return 'named-vs-keyed-property';
  if (DEFINE_SET.get(A) === B) return 'define-vs-set-property';
  if (B === 'LdaUndefined' || B === 'LdaNull') return 'undefined-for-a-value';
  if (A === 'LdaUndefined' || A === 'LdaNull') return 'a-value-for-undefined';
  if (COERCIONS.has(A) || COERCIONS.has(B)) return 'coercion-opcode';
  if (CONTEXT_STORE_RE.test(A) !== CONTEXT_STORE_RE.test(B)) return 'context-store-form';
  if (CONTEXT_LOAD_RE.test(A) !== CONTEXT_LOAD_RE.test(B)) return 'context-load-form';
  if (MOVE_OPCODES.has(A) && MOVE_OPCODES.has(B)) return 'register-move-form';
  if (CALL_RE.test(A) && CALL_RE.test(B)) return 'call-form';
  if (/^Lda/.test(A) && /^Lda/.test(B)) return 'load-form';
  if (/^Sta/.test(A) && /^Sta/.test(B)) return 'store-form';
  return 'opcode-substitution';
}

/**
 * Tokenise a normalised instruction on TOP-LEVEL spaces.
 *
 * A plain `split(' ')` cut a constant at every space inside it, so one
 * constant that differed showed up as several differing tokens of mixed kinds
 * and the hunk was classified `operand-value` rather than by the constant.
 * With literal values rendered a constant contains spaces routinely
 * (`K(<ObjectBoilerplateDescription[2] {"x": 1, "y": 2}>)`), which would have
 * made the literal-value families unnameable. Bracket- and quote-aware, so
 * one operand is one token; `->L3` is special-cased because its `>` is not a
 * closing bracket.
 */
function splitTokens(s) {
  const out = [];
  let depth = 0, quote = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '"' && s[i - 1] !== '\\') quote = false; continue; }
    if (c === '"') { quote = true; cur += c; continue; }
    if (c === '-' && s[i + 1] === '>') { cur += '->'; i++; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}' || c === '>') { depth = Math.max(0, depth - 1); cur += c; continue; }
    if (c === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** opcode of a normalised instruction string (skipping any `Ln:` label). */
function opcodeOf(s) {
  const t = splitTokens(s);
  let i = 0;
  if (t[i] && /^L\d+:$/.test(t[i])) i++;
  return t[i] ?? '';
}
function operandsOf(s) {
  const t = splitTokens(s);
  let i = 0;
  if (t[i] && /^L\d+:$/.test(t[i])) i++;
  return t.slice(i + 1);
}

// --- the two families that only exist because literal values are rendered ---

/** A boilerplate descriptor: an array, object or tagged-template literal. */
const LITERAL_DESCRIPTOR_RE = /<(?:Array|Object|Template)[A-Za-z]*Description/;
/** A bare FixedArray constant. In a script's pool this is the DeclareGlobals list. */
const ARRAY_CONSTANT_RE = /<(?:Trusted|Protected)?FixedArray\[/;

/**
 * The SHAPE of a rendered container constant: class, elements kind, length and
 * any refusal -- never the values.
 *
 * The ranked table is keyed by `family | detail`, so a detail built from the
 * values themselves would turn every distinct literal in the corpus into its
 * own row. The values are in the minimal repro instead.
 */
function literalShape(tok) {
  const m = /<([A-Za-z]+)\s*([A-Z_]+)?(\[[\d?]+\])?/.exec(tok);
  if (!m) return 'K?';
  const u = /!undecoded:([A-Za-z0-9_.:-]+)/.exec(tok);
  return `${m[1]}${m[2] ? ' ' + m[2] : ''}${m[3] ?? ''}${u ? ' !undecoded:' + u[1] : ''}`;
}

/** Name a constant-vs-constant difference that is a literal's CONTENTS. */
function literalFamily(opcode, left, right) {
  const both = left + '\u0000' + right;
  const family = LITERAL_DESCRIPTOR_RE.test(both) ? 'literal-element-value'
    : ARRAY_CONSTANT_RE.test(both) ? 'array-constant-value'   // in practice the DeclareGlobals list
    : null;
  if (!family) return null;
  const sa = literalShape(left), sb = literalShape(right);
  // Same class, kind and length, different contents, is the commonest case and
  // the one the shape string cannot show by itself -- say so rather than print
  // `X vs X`. The values are in the minimal repro.
  const detail = sa === sb ? `${opcode} ${sa} contents differ` : `${opcode} ${sa} vs ${sb}`;
  return { family, detail: detail.slice(0, 160) };
}

const CAP = 4_000_000;   // n*m ceiling for the full edit script

/**
 * Edit script over two normalised instruction streams.
 * Common prefix/suffix are trimmed first, which is what keeps the quadratic
 * core small for the usual case of a few local differences.
 * @returns {{hunks: Array, tooLarge: boolean}}
 */
export function editHunks(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ma = a.slice(s, ea), mb = b.slice(s, eb);
  if (ma.length === 0 && mb.length === 0) return { hunks: [], tooLarge: false };
  if (ma.length === 0) return { hunks: [{ at: s, minus: [], plus: mb }], tooLarge: false };
  if (mb.length === 0) return { hunks: [{ at: s, minus: ma, plus: [] }], tooLarge: false };
  if (ma.length * mb.length > CAP) {
    return { hunks: [{ at: s, minus: ma.slice(0, 8), plus: mb.slice(0, 8), truncated: true }], tooLarge: true };
  }
  // LCS table + backtrack. Int32Array rows: (n+1)*(m+1) <= CAP+... entries.
  const n = ma.length, m = mb.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[at(i, j)] = ma[i - 1] === mb[j - 1]
        ? dp[at(i - 1, j - 1)] + 1
        : Math.max(dp[at(i - 1, j)], dp[at(i, j - 1)]);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (ma[i - 1] === mb[j - 1]) { ops.push({ o: '=', l: ma[i - 1] }); i--; j--; }
    else if (dp[at(i - 1, j)] >= dp[at(i, j - 1)]) { ops.push({ o: '-', l: ma[i - 1] }); i--; }
    else { ops.push({ o: '+', r: mb[j - 1] }); j--; }
  }
  while (i > 0) { ops.push({ o: '-', l: ma[i - 1] }); i--; }
  while (j > 0) { ops.push({ o: '+', r: mb[j - 1] }); j--; }
  ops.reverse();
  const hunks = [];
  let cur = null, idx = s;
  for (const op of ops) {
    if (op.o === '=') { if (cur) { hunks.push(cur); cur = null; } idx++; continue; }
    if (!cur) cur = { at: idx, minus: [], plus: [] };
    if (op.o === '-') { cur.minus.push(op.l); idx++; } else cur.plus.push(op.r);
  }
  if (cur) hunks.push(cur);
  return { hunks, tooLarge: false };
}

/** Is `x` a permutation of `y`? */
function isPermutation(x, y) {
  if (x.length !== y.length || x.length === 0) return false;
  const a = [...x].sort(), b = [...y].sort();
  if (a.join('\u0000') !== b.join('\u0000')) return false;
  return x.join('\u0000') !== y.join('\u0000');
}

/**
 * Name the shape of one hunk.
 * `family` is the ranked bucket; `detail` is the concrete pair, kept so the
 * ranked list can be drilled into without re-running the measurement.
 */
export function classifyHunk(h) {
  const mo = h.minus.map(opcodeOf), po = h.plus.map(opcodeOf);
  if (h.truncated) return { family: 'undiffed-too-large', detail: `${mo[0] ?? '-'} / ${po[0] ?? '-'}` };

  // one-for-one: the informative case
  if (h.minus.length === 1 && h.plus.length === 1) {
    const [A, B] = [mo[0], po[0]];
    if (A === B) {
      const oa = operandsOf(h.minus[0]), ob = operandsOf(h.plus[0]);
      if (stripClosureNames(h.minus[0]) === stripClosureNames(h.plus[0])) {
        return { family: 'closure-name', detail: `${A} ${h.minus[0].match(SFI_NAME_RE)?.[0] ?? ''} vs ${h.plus[0].match(SFI_NAME_RE)?.[0] ?? ''}`.slice(0, 160) };
      }
      if (isPermutation(oa, ob)) return { family: 'operand-order', detail: A };
      const diff = [];
      for (let i = 0; i < Math.max(oa.length, ob.length); i++) if (oa[i] !== ob[i]) diff.push([oa[i], ob[i]]);
      const kindOf = (s) => s === undefined ? 'absent'
        : /^R\d+(\+\d+)?$/.test(s) ? 'register'
        : /^A\d+(\+\d+)?$/.test(s) ? 'parameter'
        : /^K\(/.test(s) || /^K#/.test(s) ? 'constant'
        : /^->L\d+$/.test(s) ? 'jumpTarget'
        : /^<.*>$/.test(s) ? 'specialReg'
        : /^#/.test(s) ? 'flag'
        : /^\[/.test(s) ? 'immediate'
        : /^\{/.test(s) ? 'jumpTable'
        : 'other';
      const kinds = [...new Set(diff.map(([x, y]) => `${kindOf(x)}->${kindOf(y)}`))];
      if (kinds.length === 1 && kinds[0] === 'register->register') {
        // a register CLASS differs: this instruction reads/writes a different
        // definition than the original did. Real, and not an allocation
        // artefact -- the classes are a def/use-preserving bijection.
        return { family: 'register-class', detail: A };
      }
      if (kinds.length === 1 && kinds[0] === 'constant->constant') {
        // A literal's CONTENTS get their own families: before this change they
        // could not differ at all (§3.5's blind spot), so folding them into
        // `constant-value` would hide the one thing the fix exposes.
        const lit = literalFamily(A, diff[0][0], diff[0][1]);
        if (lit) return lit;
        return { family: 'constant-value', detail: `${A} ${diff[0][0]} vs ${diff[0][1]}`.slice(0, 160) };
      }
      if (kinds.length === 1 && kinds[0] === 'jumpTarget->jumpTarget') return { family: 'jump-target', detail: A };
      if (oa.length !== ob.length) return { family: 'operand-arity', detail: `${A} ${oa.length} vs ${ob.length}` };
      return { family: 'operand-value', detail: `${A} ${kinds.join(',')}`.slice(0, 160) };
    }
    return { family: classifyOpcodePair(A, B), detail: `${A} -> ${B}` };
  }

  // -------------------------------------------------------------------------
  // Anything else: reduce to the OPCODE MULTISET DIFFERENCE first.
  //
  // Positional reading of an n-for-m hunk is what produced a top bucket called
  // `replaced-block` holding 422 functions and saying nothing. The multiset
  // difference says what actually changed: rewriting `o.x = v` as a property
  // definition is `DefineNamedOwnProperty` out, `SetNamedProperty` in, plus
  // whatever register traffic the new shape needs. Register moves are the
  // noisiest part of every hunk and are therefore set aside into `moveDelta`,
  // which is kept in the detail so the reduction is visible and never silent.
  //
  // This is the one place the ranked list could flatter the output, so the
  // rule is deliberately conservative: a hunk only gets a named family when
  // the difference reduces to ONE opcode on each side (or to none), otherwise
  // it stays in `replaced-block` with both opcode sets printed.
  // -------------------------------------------------------------------------
  const { onlyA, onlyB } = multisetDiff(mo, po);
  const coreA = onlyA.filter((o) => !MOVE_OPCODES.has(o));
  const coreB = onlyB.filter((o) => !MOVE_OPCODES.has(o));
  const moveDelta = (onlyB.length - coreB.length) - (onlyA.length - coreA.length);
  const moveNote = moveDelta ? ` (${moveDelta > 0 ? '+' : ''}${moveDelta} move)` : '';

  if (coreA.length === 1 && coreB.length === 1) {
    return { family: classifyOpcodePair(coreA[0], coreB[0]), detail: `${coreA[0]} -> ${coreB[0]}${moveNote}` };
  }
  if (coreA.length === 0 && coreB.length === 0) {
    // only register traffic and/or order differs
    if (onlyA.length === 0 && onlyB.length === 0) {
      return { family: 'reordered-block', detail: `${mo.length}:${po.length} ${[...new Set(mo)].slice(0, 3).join('+')}` };
    }
    const side = onlyA.length > onlyB.length ? 'missing' : 'extra';
    return { family: `${side}-temp-materialisation`, detail: `${mo.length}:${po.length} ${[...new Set([...onlyA, ...onlyB])].join('+')}` };
  }
  const describe = (ops) => {
    const u = [...new Set(ops)];
    return u.slice(0, 4).join('+') + (u.length > 4 ? `+${u.length - 4} more` : '');
  };
  if (coreB.length === 0) {
    const tags = [...new Set(coreA.map(opcodeTag))];
    return { family: `missing-${tags.length === 1 ? tags[0] : 'mixed'}`, detail: describe(coreA) + moveNote };
  }
  if (coreA.length === 0) {
    const tags = [...new Set(coreB.map(opcodeTag))];
    return { family: `extra-${tags.length === 1 ? tags[0] : 'mixed'}`, detail: describe(coreB) + moveNote };
  }
  return {
    family: 'replaced-block',
    detail: `${mo.length}:${po.length} ${describe(coreA)} / ${describe(coreB)}${moveNote}`.slice(0, 160),
  };
}

/** A short side-by-side window around a hunk, for the repro. */
function window(a, b, h, radius = 3) {
  const lo = Math.max(0, h.at - radius);
  return {
    at: h.at,
    left: a.slice(lo, h.at + h.minus.length + radius),
    right: b.slice(lo, h.at + h.plus.length + radius),
  };
}

// ---------------------------------------------------------------------------
// the whole measurement for one file
// ---------------------------------------------------------------------------

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Spawn a compile-only mint. Separate from mint.mjs because O1-corpus needs
 *  `--no-lazy` (which mint.mjs's fixed argv does not pass) and because the
 *  argv must go through `assertCompileOnlySpawn`. */
export function mintCompileOnly({ srcPath, outPath, exe, timeoutMs = 600_000, flags = ['--no-lazy'] }) {
  assertNotInExecutableTree(outPath);
  const argv = [...flags, MINT_CHILD, path.resolve(srcPath), path.resolve(outPath), 'script'];
  assertCompileOnlySpawn(argv);
  const logPath = outPath + '.mintlog.txt';
  fs.rmSync(outPath, { force: true });
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(exe, argv, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', fd, fd], windowsHide: true, timeout: timeoutMs,
    });
  } finally { fs.closeSync(fd); }
  const log = fs.readFileSync(logPath, 'utf8').trim();
  if (r.status === 0 && fs.existsSync(outPath)) {
    const buf = fs.readFileSync(outPath);
    return { ok: true, bytes: buf.length, header: readJscHeader(buf), log: log.slice(0, 300) };
  }
  return {
    ok: false,
    error: `mint exited ${r.status ?? 'null'}${r.signal ? ' signal ' + r.signal : ''}${r.error ? ' ' + r.error.message : ''}: ${log.slice(-400)}`,
  };
}

/** The matching-V8 minter: Electron 40 = V8 14.4.258.16, the corpus's version. */
export function requireMatchingMinter() {
  const e = findElectron();
  if (!e) {
    throw new Error(
      'no Electron 40 under .v8bin-cache/: stream B must be minted by the corpus\'s own V8 '
      + '(14.4.258.16). Run `node tools/oracle/fetch_electron.mjs 40.0.0 win32-x64` and extract '
      + 'electron.exe from the archive. Minting with the local node (14.6) would compare two V8 '
      + 'versions and attribute their differences to the decompiler.');
  }
  return e;
}

/**
 * Compare two normalised streams, classify every divergence.
 * @returns per-pair rows plus the per-file cause table
 */
export function compareAndClassify(pairs, { sampleCap = 3, streamCap = 80 } = {}) {
  const per = [];
  const causes = new Map();   // family -> { instructions, hunks, functions:Set, details:Map, repro }
  let undiffed = 0;
  for (const p of pairs) {
    const c = compareFunctions(p.left, p.right);
    const row = {
      name: c.name, how: p.how, sfiId: p.left.sfiId ?? null,
      exact: c.exactMatch,
      opcodeSimilarity: +c.opcodeSimilarity.toFixed(6),
      instructionSimilarity: +c.instructionSimilarity.toFixed(6),
      instructionCounts: c.instructionCounts,
      prefixMatch: c.prefixMatch,
      handlerMatch: c.handlerMatch,
    };
    if (!c.exactMatch) {
      const a = p.left.perInstruction, b = p.right.perInstruction;
      // the secondary number: identical once invented function names are gone
      if (a.length === b.length && c.handlerMatch) {
        let same = true;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i] && stripClosureNames(a[i]) !== stripClosureNames(b[i])) { same = false; break; }
        }
        row.exactModuloClosureNames = same;
      } else row.exactModuloClosureNames = false;
      const { hunks, tooLarge } = editHunks(a, b);
      if (tooLarge) undiffed++;
      row.hunks = hunks.length;
      const seen = new Set();
      for (const h of hunks) {
        const k = classifyHunk(h);
        let e = causes.get(k.family);
        if (!e) { e = { instructions: 0, hunks: 0, functions: new Set(), details: new Map(), repro: null }; causes.set(k.family, e); }
        e.hunks++;
        e.instructions += h.minus.length + h.plus.length;
        const fnKey = row.sfiId ?? row.name;
        e.functions.add(fnKey);
        // per-shape FUNCTION counts, not just hunk counts: the work queue is
        // ranked by functions affected, and one function can carry a shape
        // twenty times.
        let d = e.details.get(k.detail);
        if (!d) { d = { hunks: 0, functions: new Set() }; e.details.set(k.detail, d); }
        d.hunks++;
        d.functions.add(fnKey);
        // minimal repro: the smallest function in which this family appears
        const size = a.length + b.length;
        if (!e.repro || size < e.repro.size) {
          e.repro = {
            size, name: row.name, sfiId: row.sfiId, how: p.how, detail: k.detail,
            instructionCounts: c.instructionCounts,
            whole: size <= streamCap,
            left: size <= streamCap ? a : window(a, b, h).left,
            right: size <= streamCap ? b : window(a, b, h).right,
            at: h.at,
          };
        }
        seen.add(k.family);
      }
      row.families = [...seen];
      if (c.firstDivergence) {
        row.firstDivergence = { index: c.firstDivergence.index, left: c.firstDivergence.left, right: c.firstDivergence.right };
      }
    }
    per.push(row);
  }
  const causeRows = [...causes.entries()].map(([family, e]) => ({
    family, functions: e.functions.size, hunks: e.hunks, instructions: e.instructions,
    // [detail, hunks, functions]
    details: [...e.details.entries()].map(([k, v]) => [k, v.hunks, v.functions.size])
      .sort((x, y) => y[2] - x[2] || y[1] - x[1]).slice(0, 12),
    repro: e.repro,
  })).sort((a, b) => b.functions - a.functions);
  return { per, causes: causeRows, undiffed, sampleCap };
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * O1 (+ O2) for one corpus `.jsc`.
 *
 * `decompileOne(jscPath, tag) -> { ok, codePath, nameBySfi, report, error }`
 * is injected rather than imported so the caller decides whether the
 * decompiler runs in this process or in a child with its own heap cap. Nothing
 * here executes anything: the only engine started is `mintCompileOnly`.
 */
export function o1CorpusOne(jscPath, opts) {
  const { profile, workDir, minter, decompileOne } = opts;
  // The input is read, never run. What has to be asserted is the DESTINATION:
  // every artefact derived from it lands in a tree no other tool in this repo
  // will execute (`corpus.mjs::WORK_ROOTS` is the tree that is executable).
  assertNotInExecutableTree(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const id = path.basename(jscPath).replace(/\.jsc$/, '');
  const row = {
    file: path.basename(jscPath), id, status: 'ok',
    inputBytes: fs.statSync(jscPath).size,
    profile, minter: path.basename(minter),
  };

  // ---------------------------------------------------- stream A
  let A;
  try {
    A = normalizedFunctionsFromJsc(jscPath, { profile });
  } catch (e) {
    row.status = 'decode-A-failed';
    row.error = `${e.constructor.name}: ${e.message}`.slice(0, 400);
    return row;
  }
  row.aFunctions = A.functions.length;
  row.aUnits = A.units;
  row.aInstructions = A.erasure.instructions ?? 0;
  row.aDecodeWarnings = A.warnings;
  row.aDecodeFailures = A.decodeFailures;
  row.aHeader = A.header ? { versionHash: A.header.versionHash, flagHash: A.header.flagHash } : null;
  row.erasureA = A.erasure;
  row.literalA = A.literal;
  if (A.functions.length === 0) { row.status = 'no-functions-A'; return row; }

  // ---------------------------------------------------- our output
  const d1 = decompileOne(jscPath, 'r1');
  row.decompile1 = {
    ok: d1.ok, ms: d1.ms ?? null, stage: d1.stage ?? null, error: d1.error ?? null,
    holes: d1.holes ?? null, functionsFailed: d1.functionsFailed ?? null, orphans: d1.orphans ?? null,
  };
  row.holes = d1.holes ?? null;
  if (!d1.ok) { row.status = d1.stage === 'timeout' ? 'decompile-timeout' : 'decompile-failed'; row.error = d1.error; return row; }
  row.code1Bytes = d1.codeBytes ?? fs.statSync(d1.codePath).size;
  row.emittedFunctions = d1.emittedFunctions ?? null;
  const code1 = fs.readFileSync(d1.codePath, 'utf8');
  row.code1Sha = sha(code1);

  // ---------------------------------------------------- stream B: compile only
  const jscB = path.join(workDir, `${id}.B.jsc`);
  const m = mintCompileOnly({ srcPath: d1.codePath, outPath: jscB, exe: minter, timeoutMs: opts.mintTimeoutMs ?? 600_000 });
  row.mint = { ok: m.ok, bytes: m.bytes ?? null, error: m.error ?? null };
  if (!m.ok) { row.status = 'output-does-not-compile'; row.error = m.error; return row; }
  row.bHeader = m.header ? { versionHash: m.header.versionHash, flagHash: m.header.flagHash } : null;
  // The two headers come from two decoders: `src/cache` reports numbers,
  // `readJscHeader` reports '0x...' strings. Compare the values, not the
  // spellings. This gate is the whole reason stream B is minted by Electron
  // and not by the local node -- see `requireMatchingMinter`.
  const hx = (v) => (v == null ? null : (typeof v === 'number' ? '0x' + (v >>> 0).toString(16) : String(v)));
  if (A.header && m.header && hx(A.header.versionHash) !== hx(m.header.versionHash)) {
    row.status = 'version-mismatch';
    row.error = `stream A cache is ${hx(A.header.versionHash)}, stream B is ${hx(m.header.versionHash)}; `
      + 'the minter is not the corpus\'s V8 and the comparison would blame version drift on the decompiler';
    return row;
  }
  row.aHeader = { versionHash: hx(A.header?.versionHash), flagHash: hx(A.header?.flagHash) };
  // The corpus was not produced with --no-lazy, so the flag hashes differ by
  // construction. It gates cache ACCEPTANCE inside V8 and has no effect on the
  // bytecode of a function, so it is reported, not asserted.
  row.flagHashDiffers = hx(A.header?.flagHash) !== hx(m.header?.flagHash);

  let B;
  try {
    B = normalizedFunctionsFromJsc(jscB, { profile });
  } catch (e) {
    row.status = 'decode-B-failed';
    row.error = `${e.constructor.name}: ${e.message}`.slice(0, 400);
    return row;
  }
  row.bFunctions = B.functions.length;
  row.bInstructions = B.erasure.instructions ?? 0;
  row.bDecodeWarnings = B.warnings;
  row.bDecodeFailures = B.decodeFailures;
  row.erasureB = B.erasure;
  row.literalB = B.literal;

  // ---------------------------------------------------- pair + compare
  const nameBySfi = new Map(Object.entries(d1.nameBySfi ?? {}).map(([k, v]) => [Number(k), v]));
  row.emitNamesKnown = nameBySfi.size;
  const { pairs, mode, leftOnly, rightOnly } = pairCorpusFunctions(A.functions, B.functions, nameBySfi);
  // The A-side count that may be used as a denominator: only a file that got
  // this far contributed functions to a comparison. Summing `aFunctions` over
  // files that failed earlier would quietly shrink every rate.
  row.aFunctionsCompared = A.functions.length;
  row.aInstructionsCompared = A.erasure.instructions ?? 0;
  row.pairingMode = mode;
  row.pairedFunctions = pairs.length;
  row.byPairingMode = {};
  for (const p of pairs) row.byPairingMode[p.how] = (row.byPairingMode[p.how] ?? 0) + 1;
  row.leftOnly = leftOnly.length;
  row.rightOnly = rightOnly.length;
  row.leftOnlySamples = leftOnly.slice(0, 6).map((f) => ({ sfiId: f.sfiId, name: f.name, instructions: f.instructionCount }));
  row.rightOnlySamples = rightOnly.slice(0, 6).map((f) => ({ name: f.name, instructions: f.instructionCount }));

  const { per, causes, undiffed } = compareAndClassify(pairs);
  row.undiffedPairs = undiffed;
  row.exactFunctions = per.filter((p) => p.exact).length;
  row.exactModuloClosureNames = per.filter((p) => p.exact || p.exactModuloClosureNames).length;
  row.exactByMode = {};
  for (const p of per) if (p.exact) row.exactByMode[p.how] = (row.exactByMode[p.how] ?? 0) + 1;
  const sims = per.map((p) => p.opcodeSimilarity);
  row.meanOpcodeSimilarity = sims.length ? +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(6) : null;
  row.medianOpcodeSimilarity = sims.length ? +median(sims).toFixed(6) : null;
  const isims = per.map((p) => p.instructionSimilarity);
  row.meanInstructionSimilarity = isims.length ? +(isims.reduce((a, b) => a + b, 0) / isims.length).toFixed(6) : null;
  // histogram of the per-function opcode similarity, in tenths
  row.histogram = Array.from({ length: 11 }, () => 0);
  for (const s of sims) row.histogram[Math.min(10, Math.floor(s * 10))]++;
  row.simByMode = {};
  for (const p of per) {
    const e = row.simByMode[p.how] ?? (row.simByMode[p.how] = { n: 0, sum: 0, exact: 0 });
    e.n++; e.sum += p.opcodeSimilarity; if (p.exact) e.exact++;
  }
  for (const k of Object.keys(row.simByMode)) {
    row.simByMode[k].mean = +(row.simByMode[k].sum / row.simByMode[k].n).toFixed(6);
    delete row.simByMode[k].sum;
  }
  row.causes = causes;
  // the worst and best few, for the report
  const sorted = [...per].sort((a, b) => a.opcodeSimilarity - b.opcodeSimilarity);
  row.worst = sorted.slice(0, 5).map((p) => ({ name: p.name, how: p.how, sim: p.opcodeSimilarity, counts: p.instructionCounts, firstDivergence: p.firstDivergence }));

  // ---------------------------------------------------- O2, nearly free
  // round 2 decompiles the .jsc we already minted for stream B.
  const d2 = decompileOne(jscB, 'r2');
  row.o2 = { reached: d2.ok, stage: d2.stage ?? null, error: d2.error ?? null };
  if (d2.ok) {
    const code2 = fs.readFileSync(d2.codePath, 'utf8');
    row.o2.code2Bytes = Buffer.byteLength(code2, 'utf8');
    row.o2.code2Sha = sha(code2);
    row.o2.stable = code1 === code2;
    if (!row.o2.stable) {
      row.o2.firstDifference = firstTextDifference(code1, code2);
      row.o2.byteDelta = row.o2.code2Bytes - row.code1Bytes;
      row.o2.functionsDelta = (d2.emittedFunctions ?? 0) - (d1.emittedFunctions ?? 0);
    }
  }

  row.status = (row.exactFunctions === per.length && row.leftOnly === 0 && row.rightOnly === 0) ? 'match' : 'ok';
  if (!opts.keepArtifacts) {
    for (const p of [jscB, jscB + '.mintlog.txt', d1.codePath, d2.codePath]) fs.rmSync(p ?? '', { force: true });
  }
  return row;
}

/** First differing character of two emitted texts, with context. */
export function firstTextDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const lineNo = a.slice(0, i).split('\n').length;
      return { offset: i, line: lineNo, left: a.slice(Math.max(0, i - 60), i + 60), right: b.slice(Math.max(0, i - 60), i + 60) };
    }
  }
  return { offset: n, note: 'one output is a prefix of the other', left: a.slice(n, n + 120), right: b.slice(n, n + 120) };
}

export default { o1CorpusOne, normalizedFunctionsFromJsc, pairCorpusFunctions, compareAndClassify };
