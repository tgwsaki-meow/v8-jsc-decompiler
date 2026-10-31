// src/disasm/adapter_legacy.mjs
//
// A THIN, TEMPORARY bridge: the existing src/deserializer.js object graph ->
// the FunctionUnit of ARCHITECTURE.md 8.1.
//
// Why it exists: src/disasm/ is specified against 8.1, which src/cache/ +
// src/heap/ (T4) will produce. This adapter lets the disassembler be developed
// and, more importantly, VALIDATED against V8's own --print-bytecode today.
// It is expected to be deleted the moment T4 lands; nothing else in src/disasm/
// imports it, and src/cli/disasm.mjs picks it only as a fallback.
//
// It is deliberately conservative:
//   * it never invents a constant -- anything it cannot classify becomes
//     {t:'unresolved', why, detail}, as 8.1 requires;
//   * fields it cannot recover (startPosition, scope, uncompiled) are null,
//     not guessed, and listed in `warnings`;
//   * every object offset it uses comes from the profile's layouts.json, so
//     the one piece of version knowledge it needs is not hardcoded.
//
// Known gaps against 8.1, all reported per unit in `warnings`:
//   scope (needs the ScopeInfo decoder), startPosition/endPosition,
//   uncompiled, bigint/symbol/boilerplate constant classification.

import fs from 'node:fs';
import { JSCDeserializer, StrictV8Deserializer } from '../deserializer.js';
import { V8Profile } from '../profile.js';

/** Field offset -> index in the legacy `obj.slots` array (slot 0 is the map). */
function slotIndexOf(profile, className, field) {
  const tagged = profile.taggedSize;
  const off = profile.fieldOffset(className, field);
  if (off === null || off === undefined) {
    throw new Error(`layouts.json: ${className}.${field} has no static offset`);
  }
  if (off % tagged !== 0) throw new Error(`${className}.${field} at +${off} is not tagged-aligned`);
  return off / tagged - 1;
}

function deref(slot) {
  let s = slot;
  while (s && s.type === 'PendingForwardRef' && s.target) s = s.target;
  return s;
}

/**
 * Decode a varint-encoded, delta-encoded source position table.
 *
 * Mirrors DecodeEntry + AddAndSetEntry in src/codegen/source-position-table.cc:
 *
 *   tmp = DecodeUInt()      code_offset = tmp >> 2
 *                           is_breakable = (tmp >> 1) & 1
 *                           is_statement = tmp & 1
 *   source_position = DecodeInt()                 // zig-zag
 *   running.code_offset     += tmp.code_offset
 *   running.source_position += tmp.source_position
 *
 * Two details the profile does not state and that a naive reading gets wrong:
 *
 *  1. The running code offset starts at kFunctionEntryBytecodeOffset (-1), not
 *     0, because SourcePositionTableBuilder::previous_ is default-constructed
 *     and PositionTableEntry's default code_offset is that sentinel. The
 *     function-entry row is emitted first with exactly that offset, so every
 *     later offset is one less than a from-zero decode would give. Getting
 *     this wrong makes essentially every row miss its instruction.
 *  2. The accumulated `source_position` is SourcePosition::raw(), a packed
 *     int64, not a script offset. src/codegen/source-position.h:
 *         IsExternalField   bits 0..0
 *         ScriptOffsetField bits 1..30, stored as scriptOffset + 1
 *         InliningIdField   bits 31..50, stored as inliningId  + 1
 *     so ScriptOffset() == ((raw >> 1) & mask30) - 1, and a row is a
 *     JavaScript position iff bit 0 is clear. BytecodeArray::Disassemble
 *     iterates with the default kJavaScriptOnly filter, so external rows are
 *     dropped here too.
 *  SourcePosition is a plain C++ class rather than Torque, so profilegen does
 *  not emit its bit layout; `profile.constants.sourcePositionTable.rawPosition`
 *  is honoured when a future profile does carry it.
 */
export function decodeSourcePositionTable(bytes, profile) {
  const cfg = profile.constants.sourcePositionTable;
  const payloadBits = cfg.varint.payloadBitsPerByte;
  const moreMask = 1 << cfg.varint.moreBit;
  const valueMask = moreMask - 1;
  const rp = cfg.rawPosition ?? { isExternalBit: 0, scriptOffsetShift: 1, scriptOffsetWidth: 30, scriptOffsetBias: 1 };
  const scriptOffsetMask = 2 ** rp.scriptOffsetWidth - 1;
  const entryStart = profile.constants.globals?.kFunctionEntryBytecodeOffset ?? -1;
  const out = [];
  let i = 0;
  let codeOffset = entryStart;
  let sourcePosition = 0;
  const readRaw = () => {
    let value = 0, shift = 0, b;
    do {
      if (i >= bytes.length) throw new Error('source position table: varint runs past the end');
      b = bytes[i++];
      value += (b & valueMask) * 2 ** shift;
      shift += payloadBits;
    } while (b & moreMask);
    return value;
  };
  // DecodeInt uses zig-zag: (v >> 1) ^ -(v & 1)   (src/codegen/source-position-table.cc)
  const readSigned = () => {
    const v = readRaw();
    const half = Math.floor(v / 2);
    return (v & 1) ? -half - 1 : half;
  };
  while (i < bytes.length) {
    const first = readRaw();
    const deltaOffset = Math.floor(first / 2 ** cfg.firstEntry.codeOffsetShift);
    const isBreakable = !!(first & cfg.firstEntry.isBreakableMask);
    const isStatement = !!(first & cfg.firstEntry.isStatementMask);
    codeOffset += deltaOffset;
    sourcePosition += readSigned();
    const isExternal = !!(sourcePosition & (1 << rp.isExternalBit));
    if (isExternal) continue;                       // kJavaScriptOnly filter
    const scriptOffset = (Math.floor(sourcePosition / 2 ** rp.scriptOffsetShift) & scriptOffsetMask) - rp.scriptOffsetBias;
    out.push({ codeOffset, sourcePosition: scriptOffset, isStatement, isBreakable, rawPosition: sourcePosition });
  }
  return out;
}

function decodeHandlerTable(bytes, profile) {
  const h = profile.constants.handlerTable;
  const field = h.entryFieldSize;
  const entry = h.rangeEntryBytes;
  const bits = h.bitFields;
  const predMask = (1 << bits.HandlerPredictionField.width) - 1;
  const out = [];
  const count = Math.floor(bytes.length / entry);
  for (let k = 0; k < count; k++) {
    const at = k * entry;
    const rangeStart = bytes.readInt32LE(at + h.rangeStartIndex * field);
    const rangeEnd = bytes.readInt32LE(at + h.rangeEndIndex * field);
    const raw = bytes.readInt32LE(at + h.rangeHandlerIndex * field);
    const data = bytes.readInt32LE(at + h.rangeDataIndex * field);
    const prediction = (raw >>> bits.HandlerPredictionField.offset) & predMask;
    const wasUsed = !!((raw >>> bits.HandlerWasUsedField.offset) & 1);
    const handlerOffset = raw >> bits.HandlerOffsetField.offset;
    out.push({ rangeStart, rangeEnd, handlerOffset, prediction, wasUsed, data });
  }
  return out;
}

/** The value of a Smi stored in a 4-byte compressed tagged slot. */
function smiFromRawSlot(raw, profile) {
  const shift = profile.constants.tagging.kSmiTagSize + profile.constants.tagging.kSmiShiftSize;
  return raw.readInt32LE(0) >> shift;
}

/** Legacy string objects: read one if `obj` is a SeqString. */
function readString(obj, legacyProfile) {
  const o = deref(obj);
  if (!o || !o.rawPayload) return null;
  let mapName = null;
  const m = o.map;
  if (m && (m.type === 'RootArrayConstant' || m.type === 'RootArray')) {
    const idx = m.type === 'RootArrayConstant' ? m.rootIndex : m.id;
    mapName = legacyProfile?.getRoot(idx)?.cpp_name ?? null;
  }
  if (!mapName) return null;
  const two = mapName.includes('two_byte_string_map');
  const one = mapName.includes('one_byte_string_map');
  if (!one && !two) return null;
  const raw = o.rawPayload;
  if (raw.length < 8) return null;
  const len = raw.readInt32LE(4);
  if (len < 0) return null;
  if (two) return raw.length >= 8 + len * 2 ? raw.subarray(8, 8 + len * 2).toString('utf16le') : null;
  return raw.length >= 8 + len ? raw.subarray(8, 8 + len).toString('latin1') : null;
}

/** Legacy constant -> the 8.1 tagged union. */
function toTaggedConstant(slot, ctx) {
  const o = deref(slot);
  if (o === null || o === undefined) return { t: 'unresolved', why: 'emptySlot', detail: 'constant pool slot is empty' };

  if (o.type === 'RawSlot' && o.raw && o.raw.length === ctx.profile.taggedSize) {
    return { t: 'number', v: smiFromRawSlot(o.raw, ctx.profile) };
  }
  if (o.type === 'RootArrayConstant' || o.type === 'RootArray') {
    const idx = o.type === 'RootArrayConstant' ? o.rootIndex : o.id;
    const root = ctx.profile.getRoot(idx);
    if (!root) return { t: 'unresolved', why: 'unknownRoot', detail: `root index ${idx}` };
    const n = root.cppName ?? root.camelName ?? '';
    if (n === 'undefined_value') return { t: 'undefined' };
    if (n === 'null_value') return { t: 'null' };
    if (n === 'true_value') return { t: 'boolean', v: true };
    if (n === 'false_value') return { t: 'boolean', v: false };
    if (n === 'the_hole_value' || n === 'hole_value') return { t: 'hole' };
    if (root.kind === 'string' && typeof root.value === 'string') return { t: 'string', v: root.value };
    return { t: 'unresolved', why: 'rootNotAValue', detail: `${n} (${root.kind ?? '?'})` };
  }
  if (o.type === 'ReadOnlyHeapRef') {
    const hit = ctx.roHeap?.get(`${o.chunkIndex}:${o.chunkOffset}`);
    if (hit && typeof hit.value === 'string') return { t: 'string', v: hit.value };
    return { t: 'roRef', chunk: o.chunkIndex, offset: o.chunkOffset, ...(hit ? { resolved: hit.value ?? hit.kind } : {}) };
  }
  if (o.type) return { t: 'unresolved', why: 'serializerRef', detail: o.type };

  // A heap object. Strings first -- they are most of the pool.
  const s = readString(o, ctx.legacyProfile);
  if (s !== null) return { t: 'string', v: s };

  // HeapNumber: map + one raw double, so kDoubleSize bytes of payload across
  // 1 + kDoubleSize/kTaggedSize serialized slots.
  const dbl = ctx.profile.constants.sizes.kDoubleSize;
  if (o.rawPayload && o.rawPayload.length === dbl && o.sizeInTagged === 1 + dbl / ctx.profile.taggedSize) {
    return { t: 'number', v: o.rawPayload.readDoubleLE(0) };
  }
  // A TrustedFixedArray of Smis is a jump table (SwitchOnSmiNoFeedback), but in
  // this bytecode's pool the table is a RUN OF POOL SLOTS, not a nested array,
  // so this case is only reached for other Smi arrays; record it faithfully.
  if (o.slots && o.slots.length > 1 && o.slots.every((x, k) => k === 0 || (x && x.type === 'RawSlot'))) {
    const values = [];
    for (let k = 1; k < o.slots.length; k++) values.push(smiFromRawSlot(o.slots[k].raw, ctx.profile));
    return { t: 'smiArray', values };
  }
  const sfiBytecode = ctx.sfiByObjId.get(o.id);
  if (sfiBytecode !== undefined) return { t: 'sfi', sfiId: o.id, name: sfiBytecode.name ?? null };
  if (ctx.bytecodeObjIds.has(o.id)) return { t: 'unresolved', why: 'bytecodeArray', detail: `object ${o.id}` };
  return { t: 'unresolved', why: 'unclassifiedHeapObject', detail: `object ${o.id} (${o.slots?.length ?? 0} slots)` };
}

/**
 * Convert a legacy deserialization into FunctionUnit[] (8.1).
 * @param {object} profile a src/profile/index.mjs Profile
 */
export function unitsFromLegacy(deser, profile, opts = {}) {
  const legacyProfile = opts.legacyProfile ?? null;
  const objects = deser.objects;
  const SPT = slotIndexOf(profile, 'BytecodeArray', 'source_position_table');
  const HT = slotIndexOf(profile, 'BytecodeArray', 'handler_table');
  const CP = slotIndexOf(profile, 'BytecodeArray', 'constant_pool');
  const LEN = slotIndexOf(profile, 'BytecodeArray', 'length');
  const payloadBase = profile.fieldOffset('BytecodeArray', 'frame_size');
  const O_FRAME = profile.fieldOffset('BytecodeArray', 'frame_size') - payloadBase;
  const O_PARAM = profile.fieldOffset('BytecodeArray', 'parameter_size') - payloadBase;
  const O_MAXARG = profile.fieldOffset('BytecodeArray', 'max_arguments') - payloadBase;
  const O_NEWT = profile.fieldOffset('BytecodeArray', 'incoming_new_target_or_generator_register') - payloadBase;
  const O_BYTES = profile.fieldOffset('BytecodeArray', 'bytes') - payloadBase;
  const sys = profile.constants.sizes.kSystemPointerSize;

  // SharedFunctionInfo -> its BytecodeArray, for names and flags.
  const SFI_DATA = slotIndexOf(profile, 'SharedFunctionInfo', 'trusted_function_data');
  const SFI_NAME = slotIndexOf(profile, 'SharedFunctionInfo', 'name_or_scope_info');
  const sfiPayloadBase = profile.fieldOffset('SharedFunctionInfo', 'length');
  const O_FLAGS = profile.fieldOffset('SharedFunctionInfo', 'flags') - sfiPayloadBase;
  const O_LITID = profile.fieldOffset('SharedFunctionInfo', 'function_literal_id') - sfiPayloadBase;
  const O_FPC = profile.fieldOffset('SharedFunctionInfo', 'formal_parameter_count') - sfiPayloadBase;

  const tagged = profile.taggedSize;
  const isBytecode = (o) => o.space === 3 && o.slots?.some((s) => s && s.type === 'SelfIndirectPointer');
  const bytecodeObjs = objects.filter(isBytecode);
  const bytecodeObjIds = new Set(bytecodeObjs.map((o) => o.id));

  /** bytecodeObjId -> {name, literalId, isGenerator, isAsync, kind, isStrict} */
  const metaByBytecode = new Map();
  /** objId -> meta, for CreateClosure constants that name an SFI */
  const sfiByObjId = new Map();
  for (const o of objects) {
    const data = deref(o.slots?.[SFI_DATA]);
    if (!data || !bytecodeObjIds.has(data.id)) continue;
    const meta = { name: readString(o.slots?.[SFI_NAME], legacyProfile), literalId: null, isGenerator: false, isAsync: false, kind: null, isStrict: null };
    const raw = o.rawPayload;
    if (raw && raw.length >= O_LITID + 4) {
      try {
        const flags = raw.readUInt32LE(O_FLAGS);
        const kindOrdinal = profile.readBitfield('SharedFunctionInfoFlags', 'function_kind', flags);
        const kinds = profile.enumOf('FunctionKind');
        const kindName = Object.entries(kinds).find(([, v]) => v === kindOrdinal)?.[0] ?? null;
        meta.kind = kindName;
        meta.isGenerator = /Generator/i.test(kindName ?? '');
        meta.isAsync = /Async/i.test(kindName ?? '');
        meta.isStrict = !!profile.readBitfield('SharedFunctionInfoFlags', 'is_sparkplug_compiling', flags) ? null : null;
        meta.literalId = raw.readInt32LE(O_LITID);
        meta.formalParameterCount = raw.readUInt16LE(O_FPC);
      } catch { /* flags/enum not in the profile: leave as null */ }
    }
    metaByBytecode.set(data.id, meta);
    sfiByObjId.set(o.id, meta);
  }

  const roHeap = opts.roHeap ?? null;
  const ctx = { profile, legacyProfile, roHeap, sfiByObjId, bytecodeObjIds };

  const units = [];
  for (let i = 0; i < bytecodeObjs.length; i++) {
    const b = bytecodeObjs[i];
    const warnings = [];
    const raw = b.bytecodePayload || b.rawPayload;
    if (!raw || raw.length < O_BYTES) {
      warnings.push({ code: 'noBytecodePayload', detail: `object ${b.id}` });
      continue;
    }
    let bytecodeLength = raw.length - O_BYTES;
    const lenSlot = deref(b.slots[LEN]);
    if (lenSlot && lenSlot.raw) {
      const n = smiFromRawSlot(lenSlot.raw, profile);
      if (n > 0 && n <= raw.length - O_BYTES) bytecodeLength = n;
      else warnings.push({ code: 'implausibleLength', detail: `length field ${n}, payload ${raw.length - O_BYTES}` });
    }

    const frameSize = raw.readInt32LE(O_FRAME);
    const parameterCount = raw.readUInt16LE(O_PARAM);   // includes the receiver
    const maxArguments = raw.readUInt16LE(O_MAXARG);
    const newTargetOperand = raw.readInt32LE(O_NEWT);

    const cpObj = deref(b.slots[CP]);
    const constants = [];
    if (cpObj && cpObj.slots) {
      for (let k = 1; k < cpObj.slots.length; k++) constants.push(toTaggedConstant(cpObj.slots[k], ctx));
    } else if (cpObj) {
      warnings.push({ code: 'constantPoolNotReadable', detail: `object ${cpObj.id ?? '?'}` });
    }

    const htObj = deref(b.slots[HT]);
    let handlers = [];
    let handlerTableSize = 0;
    if (htObj && htObj.rawPayload && htObj.rawPayload.length > tagged) {
      const body = htObj.rawPayload.subarray(tagged);
      handlerTableSize = smiFromRawSlot(htObj.rawPayload, profile);
      try { handlers = decodeHandlerTable(body.subarray(0, Math.max(0, handlerTableSize)), profile); }
      catch (e) { warnings.push({ code: 'handlerTableUndecodable', detail: e.message }); }
    }

    const sptObj = deref(b.slots[SPT]);
    let sourcePositions = [];
    let sourcePositionTableSize = 0;
    if (sptObj && sptObj.rawPayload && sptObj.rawPayload.length > tagged) {
      sourcePositionTableSize = smiFromRawSlot(sptObj.rawPayload, profile);
      const body = sptObj.rawPayload.subarray(tagged, tagged + Math.max(0, sourcePositionTableSize));
      try { sourcePositions = decodeSourcePositionTable(body, profile); }
      catch (e) { warnings.push({ code: 'sourcePositionsUndecodable', detail: e.message }); }
    } else {
      warnings.push({ code: 'noSourcePositionTable', detail: 'the cache carries no source position table for this function' });
    }

    const meta = metaByBytecode.get(b.id) ?? {};
    units.push({
      sfiId: null,
      bytecodeId: b.id,
      functionLiteralId: meta.literalId ?? null,
      name: meta.name ?? '',
      kind: meta.kind ?? null,
      isGenerator: !!meta.isGenerator,
      isAsync: !!meta.isAsync,
      isStrict: meta.isStrict ?? null,
      startPosition: null,
      endPosition: null,

      bytecode: raw.subarray(O_BYTES, O_BYTES + bytecodeLength),
      frameSize,
      parameterCount,
      maxArguments,
      registerCount: Math.floor(frameSize / sys),
      incomingNewTargetOrGeneratorRegister: newTargetOperand,

      constants,
      handlers,
      handlerTableSize,
      sourcePositions,
      sourcePositionTableSize,
      scope: null,
      uncompiled: null,
      warnings: [
        ...warnings,
        { code: 'adapterGap', detail: 'scope, startPosition/endPosition and uncompiled are not recovered by adapter_legacy' },
      ],
      // provenance, so nothing downstream mistakes this for T4's output
      _source: 'adapter_legacy',
      _index: i,
    });
  }
  return units;
}

/** Read a .jsc with the legacy deserializer and return FunctionUnit[]. */
export function unitsFromJsc(file, profile, opts = {}) {
  const legacyProfile = opts.legacyProfile ?? new V8Profile();
  const buffer = fs.readFileSync(file);
  const h = new JSCDeserializer(legacyProfile).parseHeader(buffer);
  const payload = buffer.subarray(h.headerSize);
  const deser = new StrictV8Deserializer(payload, legacyProfile);
  deser.deserialize();
  const units = unitsFromLegacy(deser, profile, { ...opts, legacyProfile });
  return { header: h, units, totalObjects: deser.objects.length };
}

export default { unitsFromJsc, unitsFromLegacy, decodeSourcePositionTable };
