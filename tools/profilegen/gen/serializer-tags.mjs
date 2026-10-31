// tools/profilegen/gen/serializer-tags.mjs
//
// SerializerDeserializer::Bytecode and the ranged-tag constants.
//
// src/snapshot/serializer-deserializer.h:
//     enum Bytecode : uint8_t { kNewObject = 0x00, ... kHotObject = 0x90 };
// Explicit `= 0x40` anchors restart the numbering; everything else
// auto-increments, so the enum is read exactly as C reads it.
//
// The ranged tags occupy a span rather than one byte. Their width comes from
// the *Count constants in the same header, and the decode rule is
// BytecodeValueEncoder::Decode: value = byte - kBytecode + kMinValue.
// kNewObject spans 0x00..0x03 because SpaceEncoder<kNewObject> is
// BytecodeValueEncoder<kNewObject, 0, kNumberOfSnapshotSpaces - 1>; the
// static_assert(4 == kNumberOfSnapshotSpaces) in the header is the anchor.

import { Cpp, evalIntExpr } from '../cpp.mjs';

const RANGE_CONSTS = [
  'kRootArrayConstantsCount', 'kFixedRawDataCount', 'kFixedRepeatRootCount', 'kHotObjectCount',
  'kFirstEncodableFixedRawDataSize', 'kFirstEncodableRepeatRootCount',
  'kDoubleAlignmentSentinel', 'kEmptyBackingStoreRefSentinel',
];

export async function deriveSerializerTags(src, defines) {
  const f = await src.require('src/snapshot/serializer-deserializer.h');
  const cpp = new Cpp(defines);
  const active = cpp.run(f.text, { label: 'serializer-deserializer.h' });

  const en = /enum\s+Bytecode\s*:\s*uint8_t\s*\{([\s\S]*?)\n\s*\};/.exec(active);
  if (!en) throw new Error('serializer-deserializer.h: enum Bytecode not found');

  const tags = {};
  let next = 0;
  for (const piece of en[1].split(/[,\n]/)) {
    const m = /^\s*(k[A-Za-z0-9_]+)\s*(?:=\s*(0x[0-9a-fA-F]+|\d+))?\s*$/.exec(piece);
    if (!m) continue;
    if (m[2] !== undefined) next = Number(m[2]);
    tags[m[1]] = next;
    next += 1;
  }

  const consts = {};
  for (const n of RANGE_CONSTS) {
    const m = new RegExp(`\\b${n}\\s*=\\s*([^;,]+)`).exec(active);
    if (m) consts[n] = evalIntExpr(m[1], consts).value;
  }

  const sa = /static_assert\((\d+)\s*==\s*kNumberOfSnapshotSpaces\)/.exec(active);
  const kNumberOfSnapshotSpaces = sa ? Number(sa[1]) : null;

  // ranged tags: {tag, width, minValue} so a decoder needs no literals
  const ranged = {};
  const add = (tag, count, minValue) => {
    if (tags[tag] === undefined || count === undefined) return;
    ranged[tag] = { base: tags[tag], count, minValue, end: tags[tag] + count - 1 };
  };
  add('kNewObject', kNumberOfSnapshotSpaces, 0);
  add('kRootArrayConstants', consts.kRootArrayConstantsCount, 0);
  add('kFixedRawData', consts.kFixedRawDataCount, consts.kFirstEncodableFixedRawDataSize);
  add('kFixedRepeatRoot', consts.kFixedRepeatRootCount, consts.kFirstEncodableRepeatRootCount);
  add('kHotObject', consts.kHotObjectCount, 0);

  return {
    count: Object.keys(tags).length,
    tags,
    constants: consts,
    kNumberOfSnapshotSpaces,
    rangedTags: ranged,
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
  };
}
