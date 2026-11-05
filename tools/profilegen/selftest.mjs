#!/usr/bin/env node
// tools/profilegen/selftest.mjs
//
// Asserts every acceptance criterion for the generated profiles and prints a
// pass/fail table. Reads only profiles/<tag>/ and rules/v8-14.4.258.16.json
// (read-only, as the independent opcode oracle).
//
//   node tools/profilegen/selftest.mjs
//   node tools/profilegen/selftest.mjs --profiles profiles --tag 14.4.258.16 --tag 14.6.202.34

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile } from '../../src/profile/index.mjs';

const args = process.argv.slice(2);
let profilesRoot = 'profiles';
const tags = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profiles') profilesRoot = args[++i];
  else if (args[i] === '--tag') tags.push(args[++i]);
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(args[i])) tags.push(args[i]);
}
if (!tags.length) tags.push('14.4.258.16', '14.6.202.34');

const PRIMARY = tags[0];
const SECONDARY = tags[1];

const results = [];
function check(group, name, fn) {
  let ok = false; let detail = '';
  try {
    const r = fn();
    if (r === true || r === undefined) { ok = true; }
    else if (r && typeof r === 'object') { ok = !!r.ok; detail = r.detail ?? ''; }
    else { ok = false; detail = String(r); }
  } catch (e) {
    ok = false;
    detail = e.message.split('\n')[0];
  }
  results.push({ group, name, ok, detail });
  return ok;
}

// ---------------------------------------------------------------- the profiles

const profiles = {};
for (const tag of tags) {
  check('load', `${tag} loads + validates + source sha256`, () => {
    const p = loadProfile(path.join(profilesRoot, tag), { strict: true });
    profiles[tag] = p;
    const sh = p.validation.sourceHashes;
    return {
      ok: p.validation.errors.length === 0 && (!sh.cachePresent || sh.mismatches.length === 0),
      detail: sh.cachePresent
        ? `${sh.ok}/${sh.checked} source sha256 verified, ${sh.missing.length} not cached`
        : 'source cache absent, hashes not verified',
    };
  });
}

// ------------------------------------------------- (a) root order acceptance

for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;
  check('roots', `${tag} derived read-only root order == StaticReadOnlyRootsPointerTable`, () => {
    const a = p.acceptance.roots;
    const sr = p.tables.staticRoots;
    return {
      ok: a.agreementCount === a.total && a.firstDivergentIndex === null && sr.entriesCount === p.readOnlyRootCount,
      detail: `agreement = ${a.agreement}, firstDivergentIndex = ${a.firstDivergentIndex}`,
    };
  });
  check('roots', `${tag} static-roots table length == declared std::array length`, () => {
    const sr = p.tables.staticRoots;
    return { ok: sr.declaredLength === sr.entriesCount, detail: `${sr.entriesCount} entries, declared ${sr.declaredLength}` };
  });
  check('roots', `${tag} TORQUE_DEFINED_MAP_ROOT_LIST derived, nothing padded`, () => {
    const u = p.unresolved.unresolvedRoots;
    const n = p.meta.counts.torqueMapRoots;
    return { ok: !u && n > 0, detail: `${n} map roots derived from .tq; unresolvedRoots key ${u ? 'PRESENT' : 'absent'}` };
  });
  check('roots', `${tag} every root carries a kind, and strings carry a value`, () => {
    const roots = Object.values(p.tables.roots.byIndex);
    const noKind = roots.filter((r) => !r.kind);
    const strings = roots.filter((r) => r.kind === 'string');
    const noValue = strings.filter((r) => r.value === undefined);
    return {
      ok: noKind.length === 0 && noValue.length === 0,
      detail: `${roots.length} roots, ${strings.length} strings, ${noKind.length} without kind, ${noValue.length} strings without a value`,
    };
  });
  check('roots', `${tag} static roots resolve by compressed address`, () => {
    const sr = p.tables.staticRoots;
    const withAddr = sr.orderedTable.filter((e) => e.address !== null);
    const probe = withAddr[0];
    const hit = p.resolveStaticRoot(probe.address);
    return {
      ok: withAddr.length === sr.entriesCount && hit && hit.camelName === probe.camelName,
      detail: `${withAddr.length}/${sr.entriesCount} have an address; probe 0x${probe.address.toString(16)} -> ${hit?.camelName}`,
    };
  });
}

// --------------------------------------------- (b) object layout acceptance

const BYTECODE_ARRAY_EXPECTED = {
  length: 0,
  wrapper: 4,
  source_position_table: 8,
  handler_table: 12,
  constant_pool: 16,
  frame_size: 20,
  parameter_size: 24,
  max_arguments: 26,
  incoming_new_target_or_generator_register: 28,
};
const BYTECODE_ARRAY_EXPECTED_HEADER = 32;

for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;

  check('layouts', `${tag} BytecodeArray offsets at kTaggedSize=4`, () => {
    if (p.taggedSize !== 4) return { ok: false, detail: `profile taggedSize is ${p.taggedSize}` };
    const c = p.layoutOf('BytecodeArray');
    const bad = [];
    for (const [name, want] of Object.entries(BYTECODE_ARRAY_EXPECTED)) {
      const f = c.fields.find((x) => x.name === name);
      if (!f) { bad.push(`${name} absent`); continue; }
      if (f.relativeOffset !== want) bad.push(`${name}=+${f.relativeOffset} want +${want}`);
    }
    const hdr = c.headerSize - c.parentSize;
    if (hdr !== BYTECODE_ARRAY_EXPECTED_HEADER) bad.push(`headerSize=+${hdr} want +${BYTECODE_ARRAY_EXPECTED_HEADER}`);
    if (c.parent !== 'ExposedTrustedObject') bad.push(`parent=${c.parent} want ExposedTrustedObject`);
    return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `relative to ${c.parent}::kHeaderSize (=${c.parentSize}), headerSize +${hdr}` };
  });

  check('layouts', `${tag} BytecodeArray .tq and FIELD_LIST agree`, () => {
    const c = p.layoutOf('BytecodeArray');
    const cc = c.crossCheck;
    return {
      ok: !!cc && cc.ok && cc.compared >= 10,
      detail: cc ? `${cc.compared} fields compared, ${cc.mismatches.length} mismatches` : 'no FIELD_LIST found',
    };
  });

  check('layouts', `${tag} all FIELD_LIST cross-checks pass`, () => {
    const fails = Object.entries(p.acceptance.layoutCrossChecks ?? {}).filter(([, v]) => !v.ok);
    const n = Object.keys(p.acceptance.layoutCrossChecks ?? {}).length;
    return { ok: fails.length === 0 && n > 0, detail: `${n} classes cross-checked, ${fails.length} failed` };
  });

  check('layouts', `${tag} ScopeInfo is a layout program, not a flat table`, () => {
    const c = p.layoutOf('ScopeInfo');
    const conditional = c.fields.filter((f) => f.present === 'conditional');
    const indexed = c.fields.filter((f) => f.indexed);
    const dataDependent = c.fields.filter((f) => f.offset === null);
    const named = c.fields.find((f) => f.name === 'context_local_names' || f.name === 'context_local_infos');
    return {
      ok: c.variableLength && conditional.length >= 6 && indexed.length >= 1 && dataDependent.length > 0 && !!named
        && conditional.every((f) => f.condition && f.condition.ast),
      detail: `${c.fields.length} fields, ${conditional.length} conditional, ${indexed.length} indexed, ${dataDependent.length} data-dependent offsets`,
    };
  });

  check('layouts', `${tag} kScopeInfoMaxInlinedLocalNamesSize derived`, () => {
    const v = p.constants.scopeInfo.kScopeInfoMaxInlinedLocalNamesSize;
    return { ok: typeof v === 'number' && v > 0, detail: `= ${v}` };
  });

  check('layouts', `${tag} every required class present`, () => {
    const missing = p.unresolved.missingLayoutClasses ?? [];
    const required = [
      'SharedFunctionInfo', 'BytecodeArray', 'ScopeInfo', 'FixedArray', 'FixedArrayBase',
      'TrustedFixedArray', 'ProtectedFixedArray', 'TrustedByteArray',
      'ObjectBoilerplateDescription', 'ArrayBoilerplateDescription',
      'RegExpBoilerplateDescription', 'TemplateObjectDescription',
      'UncompiledData', 'UncompiledDataWithoutPreparseData', 'UncompiledDataWithPreparseData',
      'UncompiledDataWithoutPreparseDataWithJob', 'UncompiledDataWithPreparseDataAndJob',
      'FeedbackMetadata', 'Script', 'HeapNumber',
      'SeqOneByteString', 'SeqTwoByteString', 'ConsString', 'SlicedString', 'ThinString',
    ];
    const absent = required.filter((n) => !p.tables.layouts.classes[n]);
    return { ok: absent.length === 0 && missing.length === 0, detail: absent.length ? `absent: ${absent.join(', ')}` : `${required.length} required classes present` };
  });

  check('layouts', `${tag} bitfield structs LSB-first in declaration order`, () => {
    const want = ['ScopeFlags', 'VariableProperties', 'SharedFunctionInfoFlags', 'SharedFunctionInfoFlags2', 'JSRegExpFlags'];
    const bad = [];
    for (const name of want) {
      const b = p.tables.layouts.bitfields[name];
      if (!b) { bad.push(`${name} absent`); continue; }
      let bit = 0;
      for (const f of b.fields) {
        if (f.offset !== bit) { bad.push(`${name}.${f.name} at bit ${f.offset}, expected ${bit}`); break; }
        bit += f.width;
      }
      if (b.containerBits !== null && bit > b.containerBits) bad.push(`${name} uses ${bit} bits of ${b.base}`);
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : want.map((n) => `${n}:${p.tables.layouts.bitfields[n].fields.length}f/${p.tables.layouts.bitfields[n].usedBits}b`).join(' ') };
  });

  check('layouts', `${tag} ScopeInfo conditions reference real bitfields and enums`, () => {
    const c = p.layoutOf('ScopeInfo');
    const flags = p.bitfieldOf('ScopeFlags');
    const names = new Set(flags.fields.map((f) => f.name));
    const bad = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'member' && n.object?.kind === 'name' && n.object.name === 'flags') {
        if (!names.has(n.field)) bad.push(`ScopeFlags has no ${n.field}`);
      }
      if (n.kind === 'enumRef') {
        let members = null;
        try { members = p.enumOf(n.enum); } catch { /* unknown enum */ }
        if (!members) bad.push(`unknown enum ${n.enum}`);
        else if (members[n.member] === undefined) bad.push(`${n.enum} has no ${n.member}`);
      }
      // `expr` is a cast's argument -- `FromConstexpr<VariableAllocationInfo>(
      // VariableAllocationInfo::NONE)` hides an enumRef inside one, so a walk
      // that stops at the cast would check nothing.
      for (const k of ['left', 'right', 'arg', 'cond', 'then', 'else', 'object', 'expr']) walk(n[k]);
    };
    for (const f of c.fields) { walk(f.condition?.ast); walk(f.count?.ast); }
    return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'all conditions resolve against ScopeFlags / Torque enums' };
  });
}

// ----------------------------------------------- (c) correct per-tag sources

for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;
  check('sources', `${tag} static roots from the per-variant header, not the pre-split file`, () => {
    const h = p.tables.staticRoots.header;
    const want = `src/roots/static-roots-${p.variant.replace('+', '-')}.h`;
    const src = p.meta.sources.find((s) => s.path === h);
    return { ok: h === want && !!src, detail: `${h}${src ? ` sha256 ${src.sha256.slice(0, 16)}` : ' (NOT in meta.sources)'}` };
  });
  check('sources', `${tag} roots.h fetched at this tag`, () => {
    const s = p.meta.sources.find((x) => x.path === 'src/roots/roots.h');
    return { ok: !!s, detail: s ? `sha256 ${s.sha256.slice(0, 16)}` : 'absent' };
  });
  check('sources', `${tag} nothing read from rules/raw/`, () => {
    const bad = p.meta.sources.filter((s) => /rules[\\/]raw/.test(s.path));
    return { ok: bad.length === 0, detail: `${p.meta.sources.length} source files, all upstream` };
  });
}

// --------------------------------- opcode oracle: the checked-in 14.4 table

check('oracle', `${PRIMARY} opcode table matches rules/v8-14.4.258.16.json`, () => {
  const p = profiles[PRIMARY];
  if (!p) return 'profile not loaded';
  const oracleFile = 'rules/v8-14.4.258.16.json';
  if (!fs.existsSync(oracleFile)) return { ok: false, detail: `${oracleFile} absent` };
  const have = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  if (have.v8_version !== PRIMARY) return { ok: false, detail: `oracle is for ${have.v8_version}, not ${PRIMARY}` };
  let mismatches = 0;
  const firstFew = [];
  for (const [value, op] of Object.entries(p.tables.bytecodes.byValue)) {
    const o = have.opcodes_by_val[value];
    if (!o) { mismatches++; if (firstFew.length < 3) firstFew.push(`value ${value} absent from oracle`); continue; }
    if (o.name !== op.name) { mismatches++; if (firstFew.length < 3) firstFew.push(`${value}: ${o.name} vs ${op.name}`); continue; }
    if (o.implicit_register_use !== op.implicitRegisterUse) { mismatches++; if (firstFew.length < 3) firstFew.push(`${op.name} implicit`); continue; }
    if ((o.operands || []).join(',') !== op.operands.join(',')) { mismatches++; if (firstFew.length < 3) firstFew.push(`${op.name} operands`); }
  }
  return {
    ok: have.total_opcodes === p.opcodeCount && p.opcodeCount === 212 && mismatches === 0,
    detail: `oracle ${have.total_opcodes} opcodes, derived ${p.opcodeCount}, ${mismatches} mismatches${firstFew.length ? ' (' + firstFew.join('; ') + ')' : ''}`,
  };
});

// ---------------------------------------------- decoder-level sanity per tag

for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;
  check('decode', `${tag} operand sizing rule, incl. Wide/ExtraWide scaling`, () => {
    const scales = p.tables.operands.operandScales;
    const reg = p.operandType('kReg');
    const flag16 = p.operandType('kFlag16');
    const ok = reg.scalable && !flag16.scalable
      && p.operandSize('kReg', 1) === reg.baseSize
      && p.operandSize('kReg', scales.kDouble) === reg.baseSize * 2
      && p.operandSize('kReg', scales.kQuadruple) === reg.baseSize * 4
      && p.operandSize('kFlag16', scales.kQuadruple) === flag16.baseSize;
    return { ok, detail: `kReg base ${reg.baseSize} scalable; kFlag16 base ${flag16.baseSize} fixed; scales ${Object.values(scales).join('/')}` };
  });
  check('decode', `${tag} Wide/ExtraWide prefixes identified`, () => {
    const pre = p.tables.bytecodes.prefixes;
    return {
      ok: pre.Wide?.scale === 2 && pre.ExtraWide?.scale === 4,
      detail: `Wide=0x${pre.Wide?.value?.toString(16)} scale ${pre.Wide?.scale}; ExtraWide=0x${pre.ExtraWide?.value?.toString(16)} scale ${pre.ExtraWide?.scale}`,
    };
  });
  check('decode', `${tag} short-star range and Illegal consistent`, () => {
    const r = p.shortStarRange;
    const illegal = p.illegalOpcode;
    return {
      ok: r && r.count === 16 && r.last === illegal - 1 && illegal === p.opcodeCount - 1,
      detail: `${r?.firstName}=0x${r?.first?.toString(16)}..${r?.lastName}=0x${r?.last?.toString(16)} (${r?.count}), Illegal=0x${illegal?.toString(16)}`,
    };
  });
  check('decode', `${tag} serializer tags: 35 tags, kNewObject spans the snapshot spaces`, () => {
    const t = p.tables.serializerTags;
    const no = t.rangedTags.kNewObject;
    return {
      ok: t.count === 35 && t.kNumberOfSnapshotSpaces === 4 && no && no.count === 4 && no.base === 0,
      detail: `${t.count} tags, ${t.kNumberOfSnapshotSpaces} spaces, kNewObject 0x${no?.base?.toString(16)}..0x${no?.end?.toString(16)}`,
    };
  });
  check('decode', `${tag} ranged tag decode round-trips`, () => {
    const t = p.tables.serializerTags;
    const bad = [];
    for (const [name, r] of Object.entries(t.rangedTags)) {
      const d = p.decodeRangedTag(r.base);
      if (!d || d.tag !== name || d.value !== r.minValue) bad.push(name);
    }
    return { ok: bad.length === 0, detail: `${Object.keys(t.rangedTags).length} ranged tags${bad.length ? ', bad: ' + bad.join(',') : ''}` };
  });
  check('decode', `${tag} CallRuntime operand is a runtime id that resolves to a name`, () => {
    const call = p.getOpcode('CallRuntime');
    const hasRuntimeId = call && call.operands.includes('kRuntimeId');
    const n = p.tables.runtime.count;
    const sample = p.runtimeName(0);
    const last = p.runtimeName(n - 1);
    return {
      ok: hasRuntimeId && n > 400 && !!sample && !!last && p.runtimeName(n) === null,
      detail: `CallRuntime[${call?.operands.join(',')}]; ${n} ids; id 0 = ${sample}; id ${n - 1} = ${last}`,
    };
  });
  check('decode', `${tag} InvokeIntrinsic operand resolves to an intrinsic name`, () => {
    const op = p.getOpcode('InvokeIntrinsic');
    const n = p.tables.intrinsics.count;
    return {
      ok: op && op.operands.includes('kIntrinsicId') && n > 0 && !!p.intrinsicName(0) && p.intrinsicName(n) === null,
      detail: `InvokeIntrinsic[${op?.operands.join(',')}]; ${n} intrinsics; id 0 = ${p.intrinsicName(0)}`,
    };
  });
  check('decode', `${tag} handler table layout + bitfields`, () => {
    const h = p.constants.handlerTable;
    const b = h.bitFields;
    const pred = b.HandlerPredictionField;
    const used = b.HandlerWasUsedField;
    const off = b.HandlerOffsetField;
    return {
      ok: h.rangeEntrySize === 4 && h.rangeEntryBytes === 16
        && pred?.offset === 0 && pred?.width === 3
        && used?.offset === 3 && used?.width === 1
        && off?.offset === 4 && off?.width === 28
        && h.catchPrediction && Object.keys(h.catchPrediction).length >= 5,
      detail: `${h.rangeEntrySize} int32/entry (${h.rangeEntryBytes}B); prediction ${pred?.offset}+${pred?.width}, wasUsed ${used?.offset}+${used?.width}, offset ${off?.offset}+${off?.width}; predictions ${Object.keys(h.catchPrediction ?? {}).length}`,
    };
  });
  check('decode', `${tag} source position table bit layout`, () => {
    const s = p.constants.sourcePositionTable;
    return {
      ok: s.varint.payloadBitsPerByte === 7 && s.varint.moreBit === 7
        && s.firstEntry.codeOffsetShift === 2 && s.firstEntry.isBreakableMask === 2
        && s.firstEntry.isBreakableShift === 1 && s.firstEntry.isStatementMask === 1
        && s.deltaEncoded && s.zigZagSigned,
      detail: `${s.varint.payloadBitsPerByte} payload bits + more bit ${s.varint.moreBit}; code>>${s.firstEntry.codeOffsetShift}, breakable &${s.firstEntry.isBreakableMask}>>${s.firstEntry.isBreakableShift}, statement &${s.firstEntry.isStatementMask}`,
    };
  });
  check('decode', `${tag} read-only page geometry and address formula`, () => {
    const ro = p.constants.readOnlyPage;
    const tag0 = p.constants.tagging.kHeapObjectTag;
    // the two spot checks from the recon: 0:72 -> empty_string, 0:3528 -> prototype_string
    const a1 = p.roRefAddress(0, 72);
    const a2 = p.roRefAddress(0, 3528);
    const r1 = p.resolveStaticRoot(a1);
    const r2 = p.resolveStaticRoot(a2);
    return {
      ok: ro.regularPageSize === (1 << ro.pageSizeBits) && ro.pageSizeBits === 18
        && ro.pageHeaderSize === 16 && tag0 === 1
        && r1?.cppName === 'empty_string' && r2?.cppName === 'prototype_string',
      detail: `page 2^${ro.pageSizeBits}=${ro.regularPageSize}, header ${ro.pageHeaderSize}, tag ${tag0}; 0:72->${r1?.cppName}, 0:3528->${r2?.cppName}`,
    };
  });
  check('decode', `${tag} .jsc header offsets`, () => {
    const h = p.constants.codeCacheHeader;
    return {
      ok: h.kMagicNumberOffset === 0 && h.kVersionHashOffset === 4 && h.kSourceHashOffset === 8
        && h.kFlagHashOffset === 12 && h.kReadOnlySnapshotChecksumOffset === 16
        && h.kPayloadLengthOffset === 20 && h.kChecksumOffset === 24 && h.kHeaderSize === 32,
      detail: Object.entries(h).map(([k, v]) => `${k.replace(/^k/, '').replace(/Offset$/, '')}=${v}`).join(' '),
    };
  });
  check('decode', `${tag} no version-specific literal leaked into src/profile/`, () => {
    const f = fs.readFileSync('src/profile/index.mjs', 'utf8');
    const stripped = f
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hex = [...stripped.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0]);
    // version-ish decimal literals: 3 or more digits, or any 2xx that could be an opcode count
    const bigNums = [...stripped.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)].map((m) => m[0]);
    return { ok: hex.length === 0 && bigNums.length === 0, detail: `hex literals ${hex.length}${hex.length ? ' (' + hex.join(',') + ')' : ''}, 3+ digit literals ${bigNums.length}${bigNums.length ? ' (' + bigNums.join(',') + ')' : ''}` };
  });
}

// ---------------------------------------- the known 14.4 -> 14.6 delta

if (SECONDARY && profiles[PRIMARY] && profiles[SECONDARY]) {
  const a = profiles[PRIMARY];
  const b = profiles[SECONDARY];
  const EMBEDDED_FEEDBACK_MOVERS = [
    'TestEqual', 'TestEqualStrict', 'TestLessThan', 'TestGreaterThan',
    'TestLessThanOrEqual', 'TestGreaterThanOrEqual',
  ];

  check('diff', `${PRIMARY} vs ${SECONDARY}: identical opcode numbering, 212 each`, () => {
    const renumbered = [];
    for (const [name, v] of Object.entries(a.tables.bytecodes.byName)) {
      const w = b.tables.bytecodes.byName[name];
      if (w === undefined || w !== v) renumbered.push(name);
    }
    return {
      ok: a.opcodeCount === 212 && b.opcodeCount === 212 && renumbered.length === 0,
      detail: `${a.opcodeCount} -> ${b.opcodeCount}, ${renumbered.length} renumbered`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: exactly 6 signature changes, all to kEmbeddedFeedback`, () => {
    const changed = [];
    for (const [name, v] of Object.entries(a.tables.bytecodes.byName)) {
      const oa = a.getOpcode(v);
      const ob = b.getOpcode(name);
      if (!ob) continue;
      if (oa.operands.join(',') !== ob.operands.join(',') || oa.implicitRegisterUse !== ob.implicitRegisterUse) {
        changed.push(name);
      }
    }
    const allMovers = changed.length === EMBEDDED_FEEDBACK_MOVERS.length
      && EMBEDDED_FEEDBACK_MOVERS.every((n) => changed.includes(n))
      && EMBEDDED_FEEDBACK_MOVERS.every((n) => b.getOpcode(n).operands.includes('kEmbeddedFeedback'));
    return { ok: allMovers, detail: `changed: ${changed.join(', ') || '(none)'}` };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: kEmbeddedFeedback is new and fixed-width`, () => {
    const inA = !!a.tables.operands.operandTypes.kEmbeddedFeedback;
    const t = b.tables.operands.operandTypes.kEmbeddedFeedback;
    const slot = a.operandType('kFeedbackSlot');
    return {
      ok: !inA && !!t && !t.scalable && t.baseSize === 2 && slot.scalable && slot.baseSize === 1,
      detail: `14.4 kFeedbackSlot: scalable base ${slot.baseSize}; 14.6 kEmbeddedFeedback: fixed base ${t?.baseSize}`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: ExtraWide length changes for the 5 kFeedbackSlot movers only`, () => {
    // TestEqualStrict was already kFlag16 (fixed 2 bytes) at 14.4, so moving it
    // to kEmbeddedFeedback (also fixed 2 bytes) leaves its encoded length alone.
    // The other five move from kFeedbackSlot, which is scalable.
    const scalableMovers = EMBEDDED_FEEDBACK_MOVERS.filter((n) => a.getOpcode(n).operands.includes('kFeedbackSlot'));
    const fixedMovers = EMBEDDED_FEEDBACK_MOVERS.filter((n) => !a.getOpcode(n).operands.includes('kFeedbackSlot'));
    const bad = [];
    for (const n of scalableMovers) {
      if (a.instructionLength(n, 4) === b.instructionLength(n, 4)) bad.push(`${n} unchanged`);
    }
    for (const n of fixedMovers) {
      if (a.instructionLength(n, 4) !== b.instructionLength(n, 4)) bad.push(`${n} changed unexpectedly`);
    }
    return {
      ok: bad.length === 0 && scalableMovers.length === 5 && fixedMovers.length === 1,
      detail: bad.length ? bad.join(' ')
        : `${scalableMovers.length} scalable movers change (${scalableMovers[0]}@x4 ${a.instructionLength(scalableMovers[0], 4)}->${b.instructionLength(scalableMovers[0], 4)}), ${fixedMovers[0]} stays ${a.instructionLength(fixedMovers[0], 4)}`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: root order diverges at defineProperty_string / Deferred_Module_string`, () => {
    const ra = Object.values(a.tables.roots.byIndex);
    const rb = Object.values(b.tables.roots.byIndex);
    let first = null;
    for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
      if (ra[i].cppName !== rb[i].cppName) { first = i; break; }
    }
    return {
      ok: first !== null && ra[first].cppName === 'defineProperty_string' && rb[first].cppName === 'Deferred_Module_string',
      detail: `first divergence at ${first}: ${ra[first]?.cppName} vs ${rb[first]?.cppName}`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: the prior report's index 504 is the same divergence minus the 142 Intl strings`, () => {
    // The recon measured 504 against an expansion that dropped the 142
    // V8_INTL_SUPPORT internalized strings and close_parenthesis_string.
    // Pruning exactly those from the corrected lists must reproduce 504.
    const prune = (p) => Object.values(p.tables.roots.byIndex)
      .filter((r) => !r.intlOnly && r.cppName !== 'close_parenthesis_string')
      .map((r) => r.cppName);
    const pa = prune(a); const pb = prune(b);
    let pruned = null;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) { pruned = i; break; }
    const ra = Object.values(a.tables.roots.byIndex);
    let first = null;
    for (let i = 0; i < Math.min(ra.length, Object.keys(b.tables.roots.byIndex).length); i++) {
      if (ra[i].cppName !== b.tables.roots.byIndex[String(i)].cppName) { first = i; break; }
    }
    const intl = a.tables.roots.intlOnlyRootCount;
    return {
      ok: pruned === 504 && first === 647 && intl === 142 && first - intl - 1 === 504,
      detail: `corrected ${first}; minus ${intl} Intl strings and close_parenthesis_string = ${pruned}`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: +6 roots, none removed`, () => {
    const ra = Object.values(a.tables.roots.byIndex).map((r) => r.cppName);
    const rb = Object.values(b.tables.roots.byIndex).map((r) => r.cppName);
    const sa = new Set(ra); const sb = new Set(rb);
    const added = rb.filter((n) => !sa.has(n));
    const removed = ra.filter((n) => !sb.has(n));
    return {
      ok: added.length === 6 && removed.length === 0 && rb.length - ra.length === 6,
      detail: `${ra.length} -> ${rb.length}; added ${added.join(' ')}; removed ${removed.join(' ') || '(none)'}`,
    };
  });

  check('diff', `${PRIMARY} vs ${SECONDARY}: serializer tags unchanged`, () => {
    const ta = a.tables.serializerTags.tags;
    const tb = b.tables.serializerTags.tags;
    const diff = Object.keys({ ...ta, ...tb }).filter((k) => ta[k] !== tb[k]);
    return { ok: diff.length === 0, detail: `${Object.keys(ta).length} tags, ${diff.length} differ` };
  });
}

// ------------------------------------- (e) the five silent gaps, and the guard
//
// ARCHITECTURE.md 9.6 (four) and 10.7 (the fifth) were back-ported into the
// extractors by T10. Each check below asserts the fact a consumer needs, not
// merely that a key exists, and the last two assert the mechanism that is
// supposed to stop the next one happening: a declared expectations manifest
// that fails generation.

/** The expectations view, rebuilt from a *written* profile. */
function viewOf(p) {
  return {
    layouts: p.tables.layouts,
    constants: p.constants,
    serializerTags: p.tables.serializerTags,
    bytecodes: p.tables.bytecodes,
    operands: p.tables.operands,
    roots: p.tables.roots,
    runtime: p.tables.runtime,
    intrinsics: p.tables.intrinsics,
    cppEnums: { functionKindBitSize: p.tables.layouts.enums?.FunctionKind?.declaredBitSize ?? null },
    meta: { build: p.meta.build, taggedSize: p.taggedSize, variant: p.variant, tag: p.version },
  };
}

/** Each entry removes one thing an extractor produces. All must be caught. */
const SABOTAGE = [
  ['ScopeInfo.context_local_names', (v) => {
    v.layouts.classes.ScopeInfo.fields = v.layouts.classes.ScopeInfo.fields.filter((f) => f.name !== 'context_local_names');
  }],
  ['ScopeInfo.function_variable_info', (v) => {
    v.layouts.classes.ScopeInfo.fields = v.layouts.classes.ScopeInfo.fields.filter((f) => f.name !== 'function_variable_info');
  }],
  ['ScopeInfo.context_local_names.count-expression', (v) => {
    const f = v.layouts.classes.ScopeInfo.fields.find((x) => x.name === 'context_local_names');
    delete f.count;
  }],
  ['ScopeInfo.kMaxInlinedLocalNamesSize', (v) => { delete v.layouts.torqueConstants.kMaxInlinedLocalNamesSize; }],
  ['enums.FunctionKind', (v) => { delete v.layouts.enums.FunctionKind; }],
  ['enums.FunctionSyntaxKind', (v) => { delete v.layouts.enums.FunctionSyntaxKind; }],
  // the subtle one: present, well-formed, and carrying the Torque order
  ['enums.LanguageMode', (v) => {
    v.layouts.enums.LanguageMode.valueSource = 'torque-declaration-order';
    v.layouts.enums.LanguageMode.members = { kStrict: 0, kSloppy: 1 };
  }],
  ['enums.ContextSlot', (v) => { delete v.layouts.enums.ContextSlot.members.MIN_CONTEXT_SLOTS; }],
  ['enums.ContextSlot.header-length', (v) => { v.layouts.enums.ContextSlot.members.MIN_CONTEXT_EXTENDED_SLOTS += 1; }],
  ['enums.ElementsKind', (v) => { v.layouts.enums.ElementsKind.valueSource = 'torque-declaration-order'; }],
  ['enums.ScopeType', (v) => { delete v.layouts.enums.ScopeType.members.MODULE_SCOPE; }],
  ['enums.SnapshotSpace.count', (v) => { delete v.layouts.enums.SnapshotSpace.members.kTrusted; }],
  ['layouts.functionKindGroups', (v) => { delete v.layouts.functionKindGroups.IsGeneratorFunction; }],
  ['constants.codeCacheHeader.magicBase', (v) => { delete v.constants.codeCacheHeader.magicBase; }],
  ['constants.codeCacheHeader.sourceHash', (v) => { delete v.constants.codeCacheHeader.sourceHash.isModule; }],
  ['layouts.cppLayouts.SourcePosition', (v) => { delete v.layouts.cppLayouts.SourcePosition; }],
  ['layouts.cppLayouts.BigIntBase', (v) => { delete v.layouts.cppLayouts.BigIntBase; }],
  ['SharedFunctionInfoFlags.function_kind', (v) => {
    const b = v.layouts.bitfields.SharedFunctionInfoFlags;
    b.fields = b.fields.filter((f) => f.name !== 'function_kind');
  }],
  ['meta.build', (v) => { delete v.meta.build; }],
];

let expectationsModule = null;
try { expectationsModule = await import('./expectations.mjs'); } catch { /* reported below */ }

let layoutpatchModule = null;
try { layoutpatchModule = await import('../layoutpatch/index.mjs'); } catch { /* reported below */ }

for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;

  check('gaps', `${tag} gap 1: ScopeInfo keeps the three fields whose expressions contain a cast call`, () => {
    const c = p.layoutOf('ScopeInfo');
    const by = new Map(c.fields.map((f) => [f.name, f]));
    const bad = [];
    const names = new Map(c.fields.map((f, i) => [f.name, i]));
    const cln = by.get('context_local_names');
    const hash = by.get('context_local_names_hashtable');
    const fvi = by.get('function_variable_info');
    if (!cln?.indexed || !cln.count?.ast) bad.push('context_local_names is not an indexed region with a parsed count');
    if (hash?.present !== 'conditional' || !hash?.condition?.ast) bad.push('context_local_names_hashtable is not conditional with a parsed condition');
    if (fvi?.present !== 'conditional' || !fvi?.condition?.ast) bad.push('function_variable_info is not conditional with a parsed condition');
    // they are interior fields: the ones after them must still come after them
    if (names.get('context_local_names') > names.get('context_local_infos')) bad.push('context_local_names is declared after context_local_infos');
    if (names.get('function_variable_info') > names.get('outer_scope_info')) bad.push('function_variable_info is declared after outer_scope_info');
    const hasCast = (n) => (n && typeof n === 'object'
      ? n.kind === 'cast' || ['left', 'right', 'cond', 'then', 'else', 'object', 'expr', 'arg'].some((k) => hasCast(n[k]))
      : false);
    if (!hasCast(cln?.count?.ast)) bad.push('the count expression has no cast node, so it is not the real one');
    if (!hasCast(fvi?.condition?.ast)) bad.push('the condition has no cast node, so it is not the real one');
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('; ')
        : `${c.fields.length} fields in declaration order, ${c.fields.filter((f) => f.present === 'conditional').length} conditional, `
          + `${c.fields.filter((f) => f.indexed).length} indexed`,
    };
  });

  check('gaps', `${tag} gap 2: FunctionKind / FunctionSyntaxKind are extracted from C++ with their ranges`, () => {
    const l = p.tables.layouts;
    const fk = l.enums.FunctionKind;
    const fsk = l.enums.FunctionSyntaxKind;
    const groups = l.functionKindGroups ?? {};
    const flag = p.bitfieldOf('SharedFunctionInfoFlags').fields.find((f) => f.name === 'function_kind');
    const bad = [];
    if (fk?.valueSource !== 'cpp') bad.push(`FunctionKind valueSource ${fk?.valueSource}`);
    if (fsk?.valueSource !== 'cpp') bad.push(`FunctionSyntaxKind valueSource ${fsk?.valueSource}`);
    if (!fk || Object.keys(fk.members).length < 20) bad.push('FunctionKind has too few members');
    if (!groups.IsGeneratorFunction || !groups.IsAsyncFunction || !groups.IsArrowFunction) bad.push('missing a kind group');
    const max = Math.max(...Object.values(fk?.members ?? { x: 0 }));
    if (max >= 2 ** flag.width) bad.push(`FunctionKind max ${max} does not fit in ${flag.width} bits`);
    if (fk?.declaredBitSize !== null && fk?.declaredBitSize !== flag.width) bad.push(`kFunctionKindBitSize ${fk?.declaredBitSize} != bitfield width ${flag.width}`);
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('; ')
        : `FunctionKind ${Object.keys(fk.members).length} members (max ${max}, ${flag.width} bits declared ${fk.declaredBitSize}), `
          + `${Object.keys(groups).length} groups; FunctionSyntaxKind ${Object.keys(fsk.members).length}`,
    };
  });

  check('gaps', `${tag} gap 3: the C++ value wins and the Torque order is kept and flagged`, () => {
    const l = p.tables.layouts;
    const bad = [];
    const lm = l.enums.LanguageMode;
    if (lm.members.kSloppy !== 0 || lm.members.kStrict !== 1) bad.push(`LanguageMode members ${JSON.stringify(lm.members)} are not the C++ values`);
    if (lm.torqueDeclarationOrder?.kStrict !== 0) bad.push('the Torque declaration order was not recorded');
    const ek = l.enums.ElementsKind;
    if (ek.members.PACKED_SMI_ELEMENTS !== 0) bad.push('ElementsKind does not start at PACKED_SMI_ELEMENTS');
    if (ek.torqueDeclarationOrder?.NO_ELEMENTS !== 0) bad.push('ElementsKind Torque order was not recorded');
    const d = l.enumDisagreements ?? [];
    const enums = new Set(d.map((x) => x.enum));
    for (const n of ['LanguageMode', 'ElementsKind', 'ContextSlot']) if (!enums.has(n)) bad.push(`${n} disagreements not recorded`);
    if (!p.unresolved.enumValueDisagreements) bad.push('meta.json -> unresolved.enumValueDisagreements is absent');
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('; ')
        : `${d.length} member(s) across ${[...enums].join(', ')}; LanguageMode = ${JSON.stringify(lm.members)} (torque ${JSON.stringify(lm.torqueDeclarationOrder)})`,
    };
  });

  check('gaps', `${tag} gap 4: the magic base, the SourceHash bit widths and the checksum rule`, () => {
    const h = p.constants.codeCacheHeader;
    const sh = h.sourceHash ?? {};
    const bad = [];
    if (h.magicBase !== 0xc0de0000) bad.push(`magicBase 0x${(h.magicBase ?? 0).toString(16)}`);
    if (sh.length?.offset !== 0 || sh.length?.width !== 29) bad.push(`sourceHash.length ${JSON.stringify(sh.length)}`);
    if (sh.hasWrappedArguments?.offset !== 29 || sh.hasWrappedArguments?.width !== 1) bad.push('sourceHash.hasWrappedArguments');
    if (sh.isModule?.offset !== 30 || sh.isModule?.width !== 1) bad.push('sourceHash.isModule');
    if (h.checksum?.algorithm !== 'adler32' || h.checksum?.seed !== 0) bad.push(`checksum ${JSON.stringify(h.checksum?.algorithm)} seed ${h.checksum?.seed}`);
    // the corpus magic, as a worked example of the rule
    const corpusMagic = 0xc0de0674;
    const tableSize = (corpusMagic ^ h.magicBase) >>> 0;
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('; ')
        : `magicBase 0x${h.magicBase.toString(16)}; length ${sh.length.width} bits + wrapped@${sh.hasWrappedArguments.offset} + module@${sh.isModule.offset}; `
          + `${h.checksum.algorithm} seed ${h.checksum.seed}; 0x${corpusMagic.toString(16)} ^ base = ExternalReferenceTable::kSize ${tableSize}`,
    };
  });

  check('gaps', `${tag} gap 5: ContextSlot carries every member, with the C++ values`, () => {
    const e = p.tables.layouts.enums.ContextSlot;
    const m = e?.members ?? {};
    const bad = [];
    if (e?.valueSource !== 'cpp') bad.push(`valueSource ${e?.valueSource}`);
    if (m.SCOPE_INFO_INDEX !== 0) bad.push(`SCOPE_INFO_INDEX ${m.SCOPE_INFO_INDEX}`);
    if (m.PREVIOUS_INDEX !== 1) bad.push(`PREVIOUS_INDEX ${m.PREVIOUS_INDEX}`);
    if (!(m.MIN_CONTEXT_SLOTS >= 1)) bad.push(`MIN_CONTEXT_SLOTS ${m.MIN_CONTEXT_SLOTS}`);
    if (m.MIN_CONTEXT_EXTENDED_SLOTS !== m.MIN_CONTEXT_SLOTS + 1) bad.push('MIN_CONTEXT_EXTENDED_SLOTS is not MIN_CONTEXT_SLOTS + 1');
    if (Object.keys(m).length < 70) bad.push(`only ${Object.keys(m).length} members`);
    // what src/ir/context.mjs derives independently, by counting the two
    // Slot<Context, ...> members of contexts.tq
    if (m.MIN_CONTEXT_SLOTS !== 2 || m.MIN_CONTEXT_EXTENDED_SLOTS !== 3) {
      bad.push(`header length ${m.MIN_CONTEXT_SLOTS}/${m.MIN_CONTEXT_EXTENDED_SLOTS}, src/ir/context.mjs derives 2/3`);
    }
    return {
      ok: bad.length === 0,
      detail: bad.length ? bad.join('; ')
        : `${Object.keys(m).length} members; header length ${m.MIN_CONTEXT_SLOTS}, extended ${m.MIN_CONTEXT_EXTENDED_SLOTS} `
          + `(src/ir/context.mjs derives 2/3 from contexts.tq)`,
    };
  });

  check('gaps', `${tag} the Torque reader skipped nothing field-shaped`, () => {
    const s = p.unresolved.torqueStatementsSkipped;
    const n = s?.entries?.length ?? 0;
    return {
      ok: n === 0,
      detail: n === 0 ? 'no class / struct / bitfield / enum statement went unparsed'
        : s.entries.slice(0, 4).map((e) => `${e.file}:${e.line} ${e.reason}`).join(' | '),
    };
  });

  check('gaps', `${tag} meta.json records the sandbox / pointer-compression switches`, () => {
    const b = p.meta.build;
    if (!b) return { ok: false, detail: 'meta.json has no build section' };
    const ok = typeof b.sandbox === 'boolean' && typeof b.pointerCompression === 'boolean'
      && b.taggedSize === p.taggedSize && (b.taggedSize === 4) === b.pointerCompression
      && typeof b.trustedPointerSize === 'number';
    return {
      ok,
      detail: `sandbox=${b.sandbox} pointerCompression=${b.pointerCompression} externalCodeSpace=${b.externalCodeSpace} `
        + `staticRoots=${b.staticRoots} kTaggedSize=${b.taggedSize} kTrustedPointerSize=${b.trustedPointerSize}`,
    };
  });

  check('gaps', `${tag} every declared expectation is met by the written profile`, () => {
    if (!expectationsModule) return { ok: false, detail: 'expectations.mjs did not import' };
    const r = expectationsModule.checkExpectations(viewOf(p));
    return {
      ok: r.missing.length === 0,
      detail: r.missing.length ? r.missing.map((m) => `${m.id}: ${m.reason}`).join(' | ')
        : `${r.satisfied}/${r.checked} entries present`,
    };
  });

  check('gaps', `${tag} removing any one extractor's output is caught, not ignored`, () => {
    if (!expectationsModule) return { ok: false, detail: 'expectations.mjs did not import' };
    const base = viewOf(p);
    const undetected = [];
    for (const [id, sabotage] of SABOTAGE) {
      const v = structuredClone(base);
      sabotage(v);
      const r = expectationsModule.checkExpectations(v);
      if (!r.missing.some((m) => m.id === id)) undetected.push(id);
    }
    return {
      ok: undetected.length === 0,
      detail: undetected.length ? `NOT caught: ${undetected.join(', ')}`
        : `${SABOTAGE.length} single-entry removals, each caught by its own expectation`,
    };
  });
}

// ------------------------------- (f) the consumer's view of a non-Torque field
//
// tools/layoutpatch/index.mjs resolves a Torque type to (kind, size) by
// observing the types layouts.json already carries. A field promoted from a
// FIELD_LIST or from a `V8_OBJECT class X { TaggedMember<T> f_; }` body has no
// Torque type at all -- layouts.json records `type: null` -- and entering those
// fields in the dictionary put every one of them under the single key `null`.
// The first pair whose widths differed was then reported as a conflict in the
// type `null`, which printed as an empty name.
//
// Only kTaggedSize=8 exposes it: at 4 an AccessorPair TaggedMember is 4 bytes,
// exactly like a FeedbackMetadata uint32, so the collision is silent. Every
// committed profile is kTaggedSize=4, and the only caller of this reader is the
// oracle workflow, which generates one kTaggedSize=8 profile for the runner's
// own V8. These three checks stand in for that profile.

/** The committed layouts, as the consumer sees them, with the widths it would see at kTaggedSize=8. */
function layoutsAtTaggedSize8(p) {
  const classes = structuredClone(p.tables.layouts.classes);
  for (const cls of Object.values(classes)) {
    for (const f of [...(cls.fields ?? []), ...(cls.allFields ?? [])]) {
      if (f.sizeName === 'kTaggedSize' && f.size === 4) f.size = 8;
    }
  }
  return { tables: { layouts: { ...p.tables.layouts, classes } } };
}

if (PRIMARY && profiles[PRIMARY]) {
  const p = profiles[PRIMARY];

  check('typetable', 'a C++-promoted field never enters the Torque type dictionary', () => {
    if (!layoutpatchModule) return { ok: false, detail: 'layoutpatch/index.mjs did not import' };
    const widened = layoutsAtTaggedSize8(p);
    const nullTyped = [];
    for (const [name, cls] of Object.entries(widened.tables.layouts.classes)) {
      for (const f of cls.allFields ?? cls.fields ?? []) {
        if (f.type === null || f.type === undefined) nullTyped.push(`${f.declaredIn ?? name}.${f.name}:${f.size}`);
      }
    }
    const { table, conflicts } = layoutpatchModule.buildTypeTable(widened);
    const widths = new Set(nullTyped.map((s) => s.split(':')[1]));
    return {
      ok: conflicts.length === 0 && nullTyped.length > 0 && widths.size > 1 && !table.has(null) && !table.has(undefined),
      detail: conflicts.length
        ? `${conflicts.length} conflict(s): ${conflicts.map((c) => JSON.stringify(c.type)).join(', ')}`
        : `${nullTyped.length} untyped field(s) of ${widths.size} distinct widths left out: ${nullTyped.join(' ')}`,
    };
  });

  check('typetable', 'an untyped field in a Torque-derived class throws and names itself', () => {
    if (!layoutpatchModule) return { ok: false, detail: 'layoutpatch/index.mjs did not import' };
    const v = structuredClone({ tables: { layouts: { classes: p.tables.layouts.classes } } });
    const victim = Object.entries(v.tables.layouts.classes)
      .find(([, c]) => c.layoutSource === 'torque' && (c.fields ?? []).length);
    if (!victim) return { ok: false, detail: 'no Torque-derived class with fields to sabotage' };
    const [name, cls] = victim;
    const field = cls.fields[0].name;
    cls.fields[0].type = null;
    delete cls.allFields;
    let message = null;
    try { layoutpatchModule.buildTypeTable(v); } catch (e) { message = e.message; }
    return {
      ok: !!message && message.includes(`${name}.${field}`) && message.includes('torque'),
      detail: message ? message.replace(/\s+/g, ' ') : `${name}.${field} with type null was accepted in silence`,
    };
  });

  check('typetable', 'a real conflict names the type, both fields and both widths', () => {
    if (!layoutpatchModule) return { ok: false, detail: 'layoutpatch/index.mjs did not import' };
    const v = structuredClone({ tables: { layouts: { classes: p.tables.layouts.classes } } });
    // Two classes whose own field lists share a Torque type; widen the second.
    const seen = new Map();
    let a = null; let b = null;
    for (const [name, cls] of Object.entries(v.tables.layouts.classes)) {
      for (const f of cls.allFields ?? cls.fields ?? []) {
        if (typeof f.type !== 'string' || typeof f.size !== 'number') continue;
        const where = `${f.declaredIn ?? name}.${f.name}`;
        if (!seen.has(f.type)) { seen.set(f.type, { where, f }); continue; }
        if (seen.get(f.type).where === where) continue;
        a = seen.get(f.type); b = { where, f };
        break;
      }
      if (b) break;
    }
    if (!b) return { ok: false, detail: 'no Torque type occurs on two different fields' };
    b.f.size = a.f.size + 4;
    const { conflicts } = layoutpatchModule.buildTypeTable(v);
    const c = conflicts.find((x) => x.type === b.f.type);
    const ok = !!c && c.a.where === a.where && c.b.where === b.where
      && c.a.size !== c.b.size && String(c.type).length > 0;
    return {
      ok,
      detail: c ? `${JSON.stringify(c.type)}: ${c.a.where} ${c.a.kind}/${c.a.size} vs ${c.b.where} ${c.b.kind}/${c.b.size}`
        : `widening ${b.where} was not reported as a conflict`,
    };
  });
}

// --------------------------------------------------------------------- report

const groups = [...new Set(results.map((r) => r.group))];
const nameWidth = Math.min(78, Math.max(...results.map((r) => r.name.length)));
let failed = 0;
console.log('');
for (const g of groups) {
  console.log(`  ${g.toUpperCase()}`);
  for (const r of results.filter((x) => x.group === g)) {
    if (!r.ok) failed++;
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(nameWidth)}  ${r.detail}`);
  }
  console.log('');
}
console.log(`  ${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);

// unresolved items, printed even when everything passes
for (const tag of tags) {
  const p = profiles[tag];
  if (!p) continue;
  const u = p.unresolved;
  const keys = Object.keys(u);
  if (!keys.length) continue;
  console.log(`\n  UNRESOLVED (${tag})`);
  for (const k of keys) {
    const v = u[k];
    const txt = Array.isArray(v) ? `${v.length} item(s)` : (typeof v === 'object' && v ? (v.note ?? JSON.stringify(v).slice(0, 160)) : String(v));
    console.log(`    ${k}: ${txt}`);
  }
}

process.exitCode = failed ? 1 : 0;
