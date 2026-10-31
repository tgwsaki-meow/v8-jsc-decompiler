// tools/layoutpatch/index.mjs
//
//   node tools/layoutpatch/index.mjs --tag 14.4.258.16 [--out layouts-overlay] [--offline]
//
// Emits layouts-overlay/<tag>.json: the facts src/cache and src/heap need that
// profiles/<tag>/*.json does not carry. Every value is derived from the same
// pinned V8 sources profilegen uses, recorded with its sha256. Nothing here is
// typed in by hand.
//
// Why this tool exists -- four gaps, each verified against the profile where
// the profile does say something:
//
//  1. layouts.json drops Torque fields whose index/condition expression
//     contains a cast call. For ScopeInfo that is `context_local_names`,
//     `context_local_names_hashtable` and `function_variable_info`. These are
//     interior fields, so their absence does not merely lose data, it shifts
//     every later field. `context_local_names` is the variable-name table.
//     meta.json's `unresolved` does not mention them, so the gap is silent.
//
//  2. FunctionKind and FunctionSyntaxKind are plain C++ enums, not Torque
//     enums, so layouts.json has no `enums` entry for them -- yet
//     SharedFunctionInfoFlags.function_kind is 5 bits of exactly that enum and
//     it is the only source of isGenerator / isAsync / arrow / getter / setter.
//     function-kind.h also states the kind groupings as `base::IsInRange`
//     predicates, which are extracted rather than reinvented.
//
//  3. layouts.json's `enums.LanguageMode` records Torque's *declaration* order
//     (`extern enum LanguageMode extends bool { kStrict, kSloppy }`), which is
//     not the C++ value order (`enum LanguageMode : bool { kSloppy, kStrict }`).
//     For an `extern` enum Torque does not define the values, C++ does. The
//     overlay carries the C++ one and flags the disagreement.
//
//  4. The code-cache header needs `0xC0DE0000` (snapshot-data.h) and the
//     SourceHash bit widths (code-serializer.cc). Neither is in constants.json.
//
// Cross-check contract: for every class the overlay covers, every field
// layouts.json *does* carry must come out of this reader with the same type,
// kind, size, conditionality and -- up to the first data-dependent field --
// the same absolute offset. A single disagreement fails the run.

import fs from 'node:fs';
import path from 'node:path';
import { V8Source } from '../profilegen/fetch.mjs';
import { loadProfile } from '../../src/profile/index.mjs';
import * as tq from './torque-lite.mjs';

const GENERATOR = { name: 'layoutpatch', version: '1.0.0' };

// Torque object-layout files whose classes the front end decodes.
const LAYOUT_TQ = [
  'src/objects/scope-info.tq',
  'src/objects/shared-function-info.tq',
  'src/objects/bytecode-array.tq',
  'src/objects/fixed-array.tq',
  'src/objects/literal-objects.tq',
  'src/objects/template-objects.tq',
  'src/objects/string.tq',
  'src/objects/name.tq',
  'src/objects/heap-number.tq',
  'src/objects/heap-object.tq',
  'src/objects/trusted-object.tq',
  'src/objects/oddball.tq',
  'src/objects/hole.tq',
  'src/objects/script.tq',
  'src/objects/map.tq',
];

const CPP = {
  functionKind: 'src/objects/function-kind.h',
  functionSyntaxKind: 'src/objects/function-syntax-kind.h',
  globals: 'src/common/globals.h',
  snapshotData: 'src/snapshot/snapshot-data.h',
  codeSerializer: 'src/snapshot/code-serializer.cc',
  references: 'src/snapshot/references.h',
  hashing: 'src/base/hashing.h',
  version: 'src/utils/version.h',
};

function argv() {
  const a = process.argv.slice(2);
  const o = { out: 'layouts-overlay', offline: false, tag: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--tag') o.tag = a[++i];
    else if (a[i] === '--out') o.out = a[++i];
    else if (a[i] === '--offline') o.offline = true;
    else if (a[i] === '--profiles') o.profiles = a[++i];
    else throw new Error(`unknown argument ${a[i]}`);
  }
  if (!o.tag) throw new Error('--tag <v8-version> is required');
  return o;
}

// ------------------------------------------------------- type -> (kind, size)

/**
 * Build the type->(kind,size) dictionary out of the profile itself: every field
 * layouts.json carries already states its own kind and size, so a type the
 * profile has seen is resolved by observation, not by rule.
 */
function buildTypeTable(profile) {
  const table = new Map();
  const conflicts = [];
  for (const cls of Object.values(profile.tables.layouts.classes)) {
    for (const f of cls.allFields ?? cls.fields ?? []) {
      if (f.present === false) continue;
      const key = f.type;
      const val = { kind: f.kind, size: f.size, sizeName: f.sizeName, elementSize: f.elementSize };
      const prev = table.get(key);
      if (!prev) table.set(key, val);
      else if (prev.kind !== val.kind || prev.size !== val.size) conflicts.push({ type: key, a: prev, b: val });
    }
  }
  return { table, conflicts };
}

/** Does an `@if(FLAG)` / `@ifnot(FLAG)` annotation hold for this profile's build? */
function gateHolds(gate, profile) {
  const flags = profile.meta.torqueBuildFlags;
  if (!flags) throw new Error('layoutpatch: profile meta.json has no torqueBuildFlags; cannot resolve @if gates');
  const flag = (gate.arg ?? '').trim();
  if (!(flag in flags)) throw new Error(`layoutpatch: unknown Torque build flag ${JSON.stringify(flag)}`);
  if (gate.name !== 'if' && gate.name !== 'ifnot') throw new Error(`layoutpatch: unexpected gate @${gate.name}`);
  return gate.name === 'if' ? flags[flag] === true : flags[flag] !== true;
}

function resolveType(typeStr, profile, typeTable) {
  const sizes = profile.constants.sizes;
  const tagged = profile.taggedSize;
  const direct = typeTable.get(typeStr);
  if (direct) return { ...direct, how: 'observed-in-profile' };

  const structs = profile.tables.layouts.structs ?? {};
  if (structs[typeStr]) return { kind: 'struct', size: structs[typeStr].packedSize, how: 'profile-struct' };

  const prim = {
    int8: sizes.kInt8Size, uint8: sizes.kUInt8Size, char8: sizes.kUInt8Size,
    int16: sizes.kInt16Size, uint16: sizes.kUInt16Size, char16: sizes.kUInt16Size,
    int32: sizes.kInt32Size, uint32: sizes.kUInt32Size,
    float64: sizes.kDoubleSize, float32: sizes.kFloatSize, float16: sizes.kFloat16Size,
    intptr: sizes.kSystemPointerSize, uintptr: sizes.kSystemPointerSize,
    RawPtr: sizes.kSystemPointerSize,
    bool: sizes.kUInt8Size,
    void: 0,
  };
  if (typeStr in prim) return { kind: typeStr === 'void' ? 'void' : 'int', size: prim[typeStr], how: 'primitive' };
  if (/^TrustedPointer</.test(typeStr) || typeStr === 'TrustedPointer') return { kind: 'trusted', size: sizes.kTrustedPointerSize, how: 'pointer-form' };
  if (/^ProtectedPointer</.test(typeStr)) return { kind: 'protected', size: tagged, how: 'pointer-form' };
  if (/^ExternalPointer/.test(typeStr)) return { kind: 'external', size: sizes.kExternalPointerSlotSize, how: 'pointer-form' };
  if (/^CppHeapPointer</.test(typeStr)) return { kind: 'cppHeap', size: sizes.kCppHeapPointerSlotSize, how: 'pointer-form' };
  if (/^(SmiTagged|Weak|Lazy)</.test(typeStr)) return { kind: 'tagged', size: tagged, how: 'pointer-form' };
  // a class, a union of classes, or Smi -- one tagged slot
  if (/^[A-Z]/.test(typeStr) || typeStr.includes('|')) return { kind: 'tagged', size: tagged, how: 'tagged-default' };
  throw new Error(`layoutpatch: cannot size Torque type ${JSON.stringify(typeStr)}`);
}

// ------------------------------------------------------------------ the class

function buildOverlayClass(name, parsed, profile, typeTable, generatesConsts) {
  const profCls = profile.tables.layouts.classes[name];
  if (!profCls) throw new Error(`layoutpatch: profile has no class ${name}`);
  const taggedSize = profile.taggedSize;

  const fields = [];
  for (const f of parsed.fields) {
    // @if / @ifnot gating is resolved against the same build-flag map the
    // profile recorded (meta.json torqueBuildFlags), so the overlay and the
    // profile cannot pick different variants of a doubly-declared field such
    // as ScopeInfo's `optional_padding`.
    const gate = f.annotations.find((a) => a.name === 'if' || a.name === 'ifnot');
    const dropped = gate ? !gateHolds(gate, profile) : false;
    const resolved = resolveType(f.type, profile, typeTable);
    const rec = {
      name: f.name,
      type: f.type,
      kind: resolved.kind,
      size: resolved.size,
      sizeHow: resolved.how,
      conditional: f.conditional,
      indexed: f.indexed,
      present: dropped ? false : true,
      gatedOn: gate ? { sense: gate.name, flag: (gate.arg ?? '').trim() } : null,
    };
    if (f.conditional) rec.condition = { expr: f.conditionExpr, ast: tq.unwrapCasts(tq.parseExpression(f.conditionExpr)) };
    if (f.indexed) {
      rec.count = { expr: f.countExpr, ast: tq.unwrapCasts(tq.parseExpression(f.countExpr)) };
      rec.elementSize = resolved.size;
      rec.size = taggedSize; // a region, not a slot: `size` is unused for indexed fields
    }
    fields.push(rec);
  }

  // Static offsets, from the parent size, until the first data-dependent field.
  let offset = profCls.parentSize;
  let dynamic = false;
  for (const f of fields) {
    if (f.present === false) { f.offset = null; continue; }
    if (dynamic) { f.offset = null; continue; }
    f.offset = offset;
    if (f.conditional || f.indexed) { dynamic = true; continue; }
    offset += f.size;
  }

  return {
    name,
    source: profCls.source,
    parent: parsed.parent,
    parentSize: profCls.parentSize,
    taggedSize,
    generatesConsts,
    fields,
  };
}

/** Every field layouts.json carries must come out identical. */
function crossCheckClass(overlayCls, profile) {
  const profCls = profile.tables.layouts.classes[overlayCls.name];
  const profByName = new Map((profCls.fields ?? []).map((f) => [f.name, f]));
  const issues = [];
  const added = [];
  let compared = 0;
  for (const f of overlayCls.fields) {
    if (f.present === false) continue; // gated out by the build config, as in the profile
    const p = profByName.get(f.name);
    if (!p) { added.push(f.name); continue; }
    compared++;
    if (p.type.replace(/\s+/g, ' ') !== f.type.replace(/\s+/g, ' ')) issues.push(`${f.name}: type ${p.type} vs ${f.type}`);
    if (p.kind !== f.kind) issues.push(`${f.name}: kind ${p.kind} vs ${f.kind}`);
    const pIndexed = p.indexed === true;
    if (pIndexed !== f.indexed) issues.push(`${f.name}: indexed ${pIndexed} vs ${f.indexed}`);
    const pCond = p.present === 'conditional' || p.condition !== undefined;
    if (pCond !== f.conditional) issues.push(`${f.name}: conditional ${pCond} vs ${f.conditional}`);
    if (!f.indexed && p.size !== f.size) issues.push(`${f.name}: size ${p.size} vs ${f.size}`);
    if (f.indexed && p.elementSize !== undefined && p.elementSize !== f.elementSize) {
      issues.push(`${f.name}: elementSize ${p.elementSize} vs ${f.elementSize}`);
    }
    if (p.offset !== null && p.offset !== undefined && f.offset !== null && p.offset !== f.offset) {
      issues.push(`${f.name}: offset ${p.offset} vs ${f.offset}`);
    }
  }
  const missing = [...profByName.keys()].filter((n) => !overlayCls.fields.some((f) => f.name === n));
  if (missing.length) issues.push(`profile has fields this reader did not find: ${missing.join(', ')}`);
  return { issues, added, compared, profileFieldCount: profByName.size, overlayFieldCount: overlayCls.fields.length };
}

// --------------------------------------------------------------- C++ extracts

function extractCodeCacheConstants(snapshotDataH, codeSerializerCc) {
  const magicM = /kMagicNumber\s*=\s*(0x[0-9A-Fa-f]+)\s*\^\s*ExternalReferenceTable::kSize/.exec(snapshotDataH);
  if (!magicM) throw new Error('layoutpatch: cannot find kMagicNumber in snapshot-data.h');

  const fn = /uint32_t SerializedCodeData::SourceHash\(([\s\S]*?)\n\}/.exec(codeSerializerCc);
  if (!fn) throw new Error('layoutpatch: cannot find SerializedCodeData::SourceHash');
  const body = fn[1];
  const lenM = /using\s+LengthField\s*=\s*base::BitField<\s*uint32_t\s*,\s*(\d+)\s*,\s*(\d+)\s*>/.exec(body);
  if (!lenM) throw new Error('layoutpatch: cannot find SourceHash LengthField');
  const chain = [...body.matchAll(/using\s+(\w+)\s*=\s*(\w+)::Next<\s*(\w+)\s*,\s*(\d+)\s*>/g)];
  const fields = { length: { offset: Number(lenM[1]), width: Number(lenM[2]) } };
  const byAlias = { LengthField: fields.length };
  const nameOf = { HasWrappedArgumentsField: 'hasWrappedArguments', IsModuleField: 'isModule' };
  for (const [, alias, prev, , widthS] of chain) {
    const base = byAlias[prev];
    if (!base) throw new Error(`layoutpatch: SourceHash chain references unknown ${prev}`);
    const rec = { offset: base.offset + base.width, width: Number(widthS) };
    byAlias[alias] = rec;
    const key = nameOf[alias];
    if (!key) throw new Error(`layoutpatch: unexpected SourceHash field ${alias}`);
    fields[key] = rec;
  }
  for (const k of ['hasWrappedArguments', 'isModule']) {
    if (!fields[k]) throw new Error(`layoutpatch: SourceHash is missing ${k}`);
  }
  return { magicBase: Number(magicM[1]), sourceHash: fields };
}

function extractChecksum(snapshotUtilsCc) {
  const useZlib = /#ifdef V8_USE_ZLIB[\s\S]*?adler32\(0,\s*payload\.begin\(\)/.test(snapshotUtilsCc);
  return {
    algorithm: useZlib ? 'adler32' : 'fletcher32',
    seed: 0,
    note: 'adler32 seeded with 0, not the conventional 1 (src/snapshot/snapshot-utils.cc)',
    onlyWrittenWhen: 'v8_flags.verify_snapshot_checksum; otherwise the field is 0',
  };
}

/**
 * BigInt's layout is declared in C++ (`FLEXIBLE_ARRAY_MEMBER`), not in Torque,
 * so layouts.json has no `BigInt` class at all -- and a BigInt literal does
 * reach a constant pool. Extract the two bitfield members and the digit width
 * from src/objects/bigint.h.
 */
function extractBigIntLayout(bigintH, profile) {
  const bits = /static const uint32_t kLengthFieldBits = (\d+);/.exec(bigintH);
  const sign = /using SignBits = base::BitField<bool, (\d+), (\d+)>;/.exec(bigintH);
  const lengthNext = /using LengthBits = SignBits::Next<\s*\w+\s*,\s*kLengthFieldBits>;/.test(bigintH);
  const digit = /using digit_t = (\w+);/.exec(bigintH);
  if (!bits || !sign || !lengthNext || !digit) return null;
  const signField = { offset: Number(sign[1]), width: Number(sign[2]) };
  const lengthField = { offset: signField.offset + signField.width, width: Number(bits[1]) };
  // BigIntBase extends PrimitiveHeapObject; `bitfield_` is the first member and
  // `raw_digits` is an UnalignedValueMember flexible array right after it.
  const parentSize = profile.tables.layouts.classes.PrimitiveHeapObject?.size;
  if (parentSize == null) return null;
  const bitfieldSize = profile.constants.sizes.kUInt32Size;
  const digitSize = digit[1] === 'uintptr_t'
    ? profile.constants.sizes.kSystemPointerSize
    : null;
  if (digitSize == null) return null;
  // raw_digits is FLEXIBLE_ARRAY_MEMBER(UnalignedValueMember<digit_t>, ...),
  // and UnalignedValueMember declares
  //   alignas(alignof(Tagged_t)) char storage_[sizeof(T)]
  // (src/objects/tagged-field.h), so the digit array is kTaggedSize-aligned,
  // not byte-aligned. With pointer compression bitfield_ ends exactly on that
  // boundary; without it there are kTaggedSize - kUInt32Size bytes of padding
  // and reading the first digit 4 bytes early makes every BigInt come out
  // multiplied by 2^32.
  const taggedSize = profile.taggedSize;
  const unpadded = parentSize + bitfieldSize;
  const digitsOffset = Math.ceil(unpadded / taggedSize) * taggedSize;
  return {
    source: 'src/objects/bigint.h',
    parent: 'PrimitiveHeapObject',
    bitfieldOffset: parentSize,
    bitfieldSize,
    digitsOffset,
    digitsAlignment: taggedSize,
    digitsPadding: digitsOffset - unpadded,
    digitSize,
    digitType: digit[1],
    fields: { sign: signField, length: lengthField },
    note: 'raw_digits is an UnalignedValueMember<digit_t> flexible array; UnalignedValueMember is '
      + 'alignas(alignof(Tagged_t)) (src/objects/tagged-field.h), so the array starts at the next '
      + 'kTaggedSize boundary after bitfield_',
  };
}

/**
 * ElementsKind. `ArrayBoilerplateDescription.flags` *is* an ElementsKind, and
 * layouts.json records Torque's `extern enum` declaration order, which puts
 * NO_ELEMENTS at 0 while C++ puts PACKED_SMI_ELEMENTS there -- so every value
 * would be named one kind too high.
 *
 * The C++ enum is partly macro-generated (TYPED_ARRAYS expansion), so only the
 * literal prefix up to the first macro line is extracted. That prefix covers
 * every kind an array or object literal can carry; the result is marked partial
 * and values beyond it resolve to null rather than to a guess.
 */
function extractElementsKind(elementsKindH) {
  const re = /enum\s+ElementsKind\s*:\s*\w+\s*\{/.exec(elementsKindH);
  if (!re) return null;
  const body = elementsKindH.slice(re.index + re[0].length);
  const stripped = tq.stripComments(body);
  const lines = stripped.split('\n');
  const members = {};
  let next = 0;
  let stoppedAt = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || /[A-Z_]+\(/.test(line)) { stoppedAt = line; break; }
    for (const part of line.split(',')) {
      const t = part.trim();
      if (!t) continue;
      if (!/^[A-Z][A-Z0-9_]*$/.test(t)) { stoppedAt = stoppedAt ?? t; break; }
      members[t] = next++;
    }
    if (stoppedAt) break;
  }
  if (!Object.keys(members).length) return null;
  return {
    name: 'ElementsKind',
    members,
    partial: true,
    completeUpTo: next - 1,
    stoppedAt,
    source: 'src/objects/elements-kind.h',
    note: 'only the literal prefix before the TYPED_ARRAYS macro expansion is extracted; '
      + 'it covers every kind a literal boilerplate can carry',
  };
}

/**
 * SourcePosition. The source position table does NOT store a character offset:
 * it stores `SourcePosition::raw()`, a 64-bit bitfield. The character offset is
 * `ScriptOffsetField::decode(raw) - 1` (the +1 bias lets kNoSourcePosition = -1
 * be stored as 0), and bits above it carry the inlining id. V8's own
 * --print-bytecode prints `ScriptOffset()`, not the raw value.
 *
 * constants.json's sourcePositionTable section describes the varint and delta
 * encoding but not this bitfield, so it comes from src/codegen/source-position.h.
 */
function extractSourcePositionLayout(sourcePositionH) {
  const fields = {};
  const re = /using\s+(\w+)Field\s*=\s*base::BitField64<\s*(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*>/g;
  let m;
  while ((m = re.exec(sourcePositionH))) {
    fields[m[1][0].toLowerCase() + m[1].slice(1)] = { type: m[2], offset: Number(m[3]), width: Number(m[4]) };
  }
  if (!fields.isExternal || !fields.scriptOffset || !fields.inliningId) return null;
  // The +1 biases, read off the setters rather than assumed.
  const scriptBias = /value_ = ScriptOffsetField::update\(value_, script_offset \+ (\d+)\);/.exec(sourcePositionH);
  const inliningBias = /value_ = InliningIdField::update\(value_, inlining_id \+ (\d+)\);/.exec(sourcePositionH);
  const noPos = /kNoSourcePosition == (-?\d+)/.exec(sourcePositionH);
  if (!scriptBias || !inliningBias) return null;
  return {
    source: 'src/codegen/source-position.h',
    fields,
    scriptOffsetBias: Number(scriptBias[1]),
    inliningIdBias: Number(inliningBias[1]),
    kNoSourcePosition: noPos ? Number(noPos[1]) : null,
    note: 'scriptOffset = ScriptOffsetField::decode(raw) - scriptOffsetBias, valid only when isExternal is 0',
  };
}

/** HashTableBase's fixed index layout, used to read a NameToIndexHashTable. */
function extractHashTableLayout(hashTableH) {
  const idx = {};
  for (const [key, name] of [
    ['numberOfElementsIndex', 'kNumberOfElementsIndex'],
    ['numberOfDeletedElementsIndex', 'kNumberOfDeletedElementsIndex'],
    ['capacityIndex', 'kCapacityIndex'],
    ['prefixStartIndex', 'kPrefixStartIndex'],
  ]) {
    const m = new RegExp(`static const int ${name} = (\\d+);`).exec(hashTableH);
    if (!m) return null;
    idx[key] = Number(m[1]);
  }
  idx.source = 'src/objects/hash-table.h';
  idx.note = 'entries start at prefixStartIndex + Shape::kPrefixSize; Shape constants live with each table and are not extracted here';
  return idx;
}

function extractSnapshotSpaces(referencesH) {
  const e = tq.parseCppEnum(referencesH, 'SnapshotSpace');
  if (!e) throw new Error('layoutpatch: cannot find enum SnapshotSpace');
  return e.members;
}

function extractVersionHashRecipe(versionH, hashingH) {
  const hm = /static uint32_t Hash\(\)\s*\{\s*return static_cast<uint32_t>\(\s*base::hash_combine\(([^)]*)\)\);/.exec(
    versionH.replace(/\s+/g, ' '));
  const combine = /V8_INLINE size_t hash_combine\(size_t seed, size_t hash\)\s*\{([\s\S]*?)\n\}/.exec(hashingH);
  const m64 = combine ? /uint64_t\{(0x[0-9A-Fa-f]+)\}/.exec(combine[1]) : null;
  const r64 = combine ? /const uint32_t r = (\d+);/.exec(combine[1]) : null;
  return {
    expression: hm ? `hash_combine(${hm[1].trim()})` : null,
    inputs: hm ? hm[1].split(',').map((s) => s.trim().replace(/_$/, '')) : null,
    combine64: m64 && r64 ? { m: m64[1], r: Number(r64[1]) } : null,
    note: 'Version::Hash() == Hasher::Combine(major, minor, build, patch); see src/utils/version.h and src/base/hashing.h',
  };
}

// ------------------------------------------------------------------- main

async function main() {
  const o = argv();
  const profileDir = path.join(o.profiles ?? 'profiles', o.tag);
  const profile = loadProfile(profileDir, { strict: true });
  const src = new V8Source(o.tag, { offline: o.offline });

  const texts = {};
  for (const p of LAYOUT_TQ) texts[p] = (await src.require(p)).text;
  for (const [, p] of Object.entries(CPP)) texts[p] = (await src.require(p)).text;
  texts['src/snapshot/snapshot-utils.cc'] = (await src.require('src/snapshot/snapshot-utils.cc')).text;
  texts['src/objects/bigint.h'] = (await src.require('src/objects/bigint.h')).text;
  texts['src/objects/hash-table.h'] = (await src.require('src/objects/hash-table.h')).text;
  texts['src/objects/elements-kind.h'] = (await src.require('src/objects/elements-kind.h')).text;
  texts['src/codegen/source-position.h'] = (await src.require('src/codegen/source-position.h')).text;

  const { table: typeTable, conflicts } = buildTypeTable(profile);

  // Parse every layout .tq once.
  const parsedClasses = {};
  const generatesConsts = {};
  for (const p of LAYOUT_TQ) {
    Object.assign(generatesConsts, tq.parseGeneratesConsts(tq.stripComments(texts[p])));
    for (const [name, cls] of Object.entries(tq.parseTorqueClasses(texts[p]))) {
      parsedClasses[name] = { ...cls, source: p };
    }
  }

  // Cross-check every class this reader can derive that the profile also has.
  //
  // Before the profilegen back-port (ARCHITECTURE.md 9.9) this loop only kept
  // the classes that had *lost* a field, because the output was a patch. Now
  // that profilegen derives those fields itself the patch is always empty, and
  // the useful product is the comparison: two independent readers of the same
  // pinned .tq text must agree on every field, and a field this reader finds
  // that the profile does not have is a profilegen regression.
  const report = [];
  const classes = {};
  for (const [name, parsed] of Object.entries(parsedClasses)) {
    const profCls = profile.tables.layouts.classes[name];
    if (!profCls) continue;
    if (profCls.layoutSource === 'FIELD_LIST') continue;   // the .h is the layout; nothing Torque to compare
    const profNames = new Set((profCls.fields ?? []).map((f) => f.name));
    const overlayCls = buildOverlayClass(name, parsed, profile, typeTable, generatesConsts);
    const lost = overlayCls.fields.filter((f) => f.present !== false && !profNames.has(f.name)).map((f) => f.name);
    const check = crossCheckClass(overlayCls, profile);
    if (lost.length) check.issues.push(`the profile is missing ${lost.join(', ')}, which this reader derives from ${parsed.source}`);
    overlayCls.crossCheck = check;
    classes[name] = overlayCls;
    report.push({ class: name, source: parsed.source, lost, crossCheck: check });
  }

  // C++ enums the profile cannot carry.
  const functionKind = tq.parseCppEnum(texts[CPP.functionKind], 'FunctionKind');
  const functionSyntaxKind = tq.parseCppEnum(texts[CPP.functionSyntaxKind], 'FunctionSyntaxKind');
  const languageMode = tq.parseCppEnum(texts[CPP.globals], 'LanguageMode');
  if (!functionKind) throw new Error('layoutpatch: FunctionKind not found');
  if (!functionSyntaxKind) throw new Error('layoutpatch: FunctionSyntaxKind not found');
  if (!languageMode) throw new Error('layoutpatch: LanguageMode not found');

  const elementsKind = extractElementsKind(texts['src/objects/elements-kind.h']);
  if (!elementsKind) throw new Error('layoutpatch: ElementsKind not found');

  const predicates = tq.parseIsInRangePredicates(texts[CPP.functionKind], 'FunctionKind');
  const notUnderstood = Object.entries(predicates).filter(([, v]) => !v.understood).map(([k]) => k);

  // Resolve predicate ranges to ordinals now, so the consumer never maps names.
  const kindGroups = {};
  for (const [pred, v] of Object.entries(predicates)) {
    if (!v.understood) continue;
    const ranges = v.ranges.map(([a, b]) => {
      const lo = functionKind.members[a], hi = functionKind.members[b];
      if (lo === undefined || hi === undefined) throw new Error(`layoutpatch: ${pred} names unknown FunctionKind ${a}/${b}`);
      return [lo, hi];
    });
    kindGroups[pred] = ranges;
  }

  // Disagreement between Torque's declaration order and the C++ values.
  //
  // The profile now carries the C++ value in `enums.<X>.members` and keeps the
  // Torque positions in `enums.<X>.torqueDeclarationOrder`, so that is what
  // this compares against. Two things are asserted at once: that this reader's
  // independent C++ extraction equals the profile's, and that the Torque order
  // really is different -- if a future V8 made them agree, the warning would
  // become noise and should be removed deliberately rather than by accident.
  const enumDisagreements = [];
  const enumMismatches = [];
  for (const [name, cpp] of Object.entries({
    FunctionKind: functionKind,
    FunctionSyntaxKind: functionSyntaxKind,
    LanguageMode: languageMode,
    ElementsKind: elementsKind,
  })) {
    const prof = profile.tables.layouts.enums?.[name];
    if (!prof) { enumMismatches.push(`the profile has no enum ${name}`); continue; }
    if (prof.valueSource !== 'cpp') {
      enumMismatches.push(`enums.${name}.valueSource is ${JSON.stringify(prof.valueSource)}, not 'cpp'`);
    }
    const torque = prof.torqueDeclarationOrder ?? null;
    for (const [member, value] of Object.entries(cpp.members)) {
      if (prof.members[member] === undefined) {
        enumMismatches.push(`enums.${name} has no member ${member} (this reader derives ${member} = ${value})`);
        continue;
      }
      if (prof.members[member] !== value) {
        enumMismatches.push(`enums.${name}.${member}: profile ${prof.members[member]}, this reader ${value}`);
        continue;
      }
      if (torque && torque[member] !== undefined && torque[member] !== value) {
        enumDisagreements.push({ enum: name, member, torqueDeclarationOrder: torque[member], cppValue: value });
      }
    }
  }

  const codeCache = extractCodeCacheConstants(texts[CPP.snapshotData], texts[CPP.codeSerializer]);
  codeCache.checksum = extractChecksum(texts['src/snapshot/snapshot-utils.cc']);
  const snapshotSpaces = extractSnapshotSpaces(texts[CPP.references]);
  const versionHash = extractVersionHashRecipe(texts[CPP.version], texts[CPP.hashing]);
  const cppLayouts = {
    BigIntBase: extractBigIntLayout(texts['src/objects/bigint.h'], profile),
    HashTableBase: extractHashTableLayout(texts['src/objects/hash-table.h']),
    SourcePosition: extractSourcePositionLayout(texts['src/codegen/source-position.h']),
  };
  for (const [k, v] of Object.entries(cppLayouts)) {
    if (v === null) throw new Error(`layoutpatch: cannot extract the C++ layout of ${k}`);
  }

  // Everything the profile must also carry, compared value by value. This is
  // the whole point of the tool now: a second derivation, written separately
  // from profilegen's, reading the same pinned sources.
  const crossChecks = [];
  /**
   * Compare two derivations by their DATA, not by their JSON text.
   *
   * `JSON.stringify(a) === JSON.stringify(b)` made this oracle report three
   * false failures, and a cross-check that cries wolf is worse than none:
   *
   *   * **key order.** `HashTableBase` came out as
   *     `{numberOfElementsIndex,...,source,note}` here and
   *     `{source,numberOfElementsIndex,...}` in the profile. Every value was
   *     identical.
   *   * **prose.** `BigIntBase` and `SourcePosition` differed only in the
   *     wording of their `note` -- "is an UnalignedValueMember<digit_t>
   *     flexible array" against "is a FLEXIBLE_ARRAY_MEMBER of
   *     UnalignedValueMember<digit_t>", which say the same thing. A `note` is
   *     documentation for a human; two independent readers agreeing on every
   *     number and explaining it differently is agreement.
   *
   * So: keys sorted, and the documentation-only fields dropped. Anything that
   * is a layout fact is still compared exactly.
   */
  const PROSE_KEYS = new Set(['note', 'comment', 'why', 'doc']);
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (x === null || typeof x !== 'object') return x;
    const out = {};
    for (const k of Object.keys(x).sort()) {
      if (PROSE_KEYS.has(k)) continue;
      out[k] = canon(x[k]);
    }
    return out;
  };
  const addCheck = (what, mine, theirs) => {
    crossChecks.push({
      what,
      agrees: JSON.stringify(canon(mine)) === JSON.stringify(canon(theirs)),
      mine,
      profile: theirs,
    });
  };
  const pc = profile.constants.codeCacheHeader ?? {};
  addCheck('codeCache.magicBase', codeCache.magicBase, pc.magicBase);
  addCheck('codeCache.sourceHash', codeCache.sourceHash, pc.sourceHash);
  addCheck('codeCache.checksum.algorithm', codeCache.checksum.algorithm, pc.checksum?.algorithm);
  addCheck('snapshotSpaces', snapshotSpaces, profile.tables.layouts.enums?.SnapshotSpace?.members);
  addCheck('functionKindGroups', kindGroups, profile.tables.layouts.functionKindGroups);
  for (const [k, v] of Object.entries(cppLayouts)) {
    addCheck(`cppLayouts.${k}`, v, profile.tables.layouts.cppLayouts?.[k]);
  }
  for (const m of enumMismatches) crossChecks.push({ what: 'enums', agrees: false, detail: m });

  const out = {
    $schema: 'layouts-overlay.v1',
    v8Version: o.tag,
    generator: GENERATOR,
    generatedAt: new Date().toISOString(),
    why: 'an independent second derivation of the build facts in profiles/<tag>/, from the same '
      + 'pinned V8 sources, kept as a cross-check oracle. Nothing reads this file: since the '
      + 'profilegen back-port (ARCHITECTURE.md 9.9) src/cache/overlay.mjs builds the same view '
      + 'out of the profile itself.',
    profile: { dir: profileDir, taggedSize: profile.taggedSize, variant: profile.variant },
    crossChecks,
    classes,
    enums: {
      FunctionKind: functionKind,
      FunctionSyntaxKind: functionSyntaxKind,
      LanguageMode: languageMode,
      ElementsKind: elementsKind,
    },
    functionKindGroups: kindGroups,
    enumDisagreements,
    codeCache,
    snapshotSpaces,
    versionHash,
    cppLayouts,
    diagnostics: {
      classesCrossChecked: Object.keys(classes),
      classesPatched: [],
      report,
      typeTableConflicts: conflicts,
      predicatesNotUnderstood: notUnderstood,
    },
    sources: src.sources(),
  };

  const failures = [];
  for (const [name, c] of Object.entries(classes)) {
    if (c.crossCheck.issues.length) failures.push(`${name}: ${c.crossCheck.issues.join('; ')}`);
  }
  for (const c of crossChecks) {
    if (!c.agrees) {
      failures.push(c.detail
        ? `${c.what}: ${c.detail}`
        : `${c.what}: this reader derives ${JSON.stringify(c.mine)}, the profile carries ${JSON.stringify(c.profile)}`);
    }
  }
  if (!enumDisagreements.length) {
    failures.push('no enum member disagrees with the Torque declaration order any more; either V8 '
      + 'reordered its Torque declarations to match C++ (in which case drop this assertion '
      + 'deliberately) or this reader stopped extracting the C++ values');
  }
  if (conflicts.length) failures.push(`type table conflicts: ${conflicts.map((c) => c.type).join(', ')}`);

  fs.mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, `${o.tag}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n', 'utf8');

  const totalFields = report.reduce((n, r) => n + r.crossCheck.compared, 0);
  console.log(`layoutpatch ${o.tag} -> ${file}`);
  console.log(`  classes cross-checked: ${Object.keys(classes).length} (${totalFields} field comparisons), `
    + `fields the profile is missing: ${report.reduce((n, r) => n + r.lost.length, 0)}`);
  for (const r of report) {
    if (!r.lost.length && !r.crossCheck.issues.length && r.class !== 'ScopeInfo') continue;
    console.log(`    ${r.class} (${r.source}): profile declares ${r.crossCheck.profileFieldCount}, Torque declares ${r.crossCheck.overlayFieldCount}, `
      + `${r.crossCheck.compared} compared`);
    if (r.lost.length) console.log(`      MISSING FROM THE PROFILE: ${r.lost.join(', ')}`);
    console.log(`      cross-check: ${r.crossCheck.issues.length ? 'FAIL -> ' + r.crossCheck.issues.join('; ') : 'all shared fields identical'}`);
  }
  console.log(`  value cross-checks: ${crossChecks.filter((c) => c.agrees).length}/${crossChecks.length} agree with the profile`);
  console.log(`  FunctionKind: ${Object.keys(functionKind.members).length} members, ${Object.keys(kindGroups).length} groups`);
  console.log(`  FunctionSyntaxKind: ${Object.keys(functionSyntaxKind.members).length} members`);
  console.log(`  LanguageMode (C++): ${JSON.stringify(languageMode.members)}`);
  if (enumDisagreements.length) {
    console.log('  enum disagreements vs layouts.json (Torque declaration order is not the C++ value):');
    for (const d of enumDisagreements) console.log(`    ${d.enum}::${d.member}  torque=${d.torqueDeclarationOrder} cpp=${d.cppValue}`);
  }
  console.log(`  codeCache.magicBase = 0x${codeCache.magicBase.toString(16)}; sourceHash = ${JSON.stringify(codeCache.sourceHash)}`);
  console.log(`  snapshotSpaces = ${JSON.stringify(snapshotSpaces)}`);
  if (notUnderstood.length) console.log(`  predicates not understood (left out): ${notUnderstood.join(', ')}`);
  console.log(`  sources recorded: ${out.sources.length}`);

  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.stack || String(e)); process.exitCode = 1; });
