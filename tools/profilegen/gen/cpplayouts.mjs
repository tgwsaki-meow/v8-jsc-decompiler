// tools/profilegen/gen/cpplayouts.mjs
//
// Four C++ declarations that neither Torque nor a FIELD_LIST describes, each of
// which a decoder needs:
//
//  * BigIntBase   -- declared with FLEXIBLE_ARRAY_MEMBER in
//                    src/objects/bigint.h, so layouts.json has no BigInt class
//                    at all, and a BigInt literal does reach a constant pool.
//  * HashTableBase -- the fixed index prefix of every hash table
//                    (src/objects/hash-table.h). ScopeInfo's
//                    `context_local_names_hashtable` is one of these.
//  * SourcePosition -- the source position table does not store a character
//                    offset, it stores `SourcePosition::raw()`, a 64-bit
//                    bitfield (src/codegen/source-position.h). The character
//                    offset is `ScriptOffsetField::decode(raw) - 1`.
//  * ClassBoilerplate -- the one entry here that is not a layout at all. Its
//                    seven fields ARE Torque's; what they MEAN is stated only
//                    in C++ (src/objects/literal-objects.h): the `ValueKind`
//                    enum, the `DefineClassArgumentsIndices` enum and the
//                    `ComputedEntryFlags` bit widths. Without them a class
//                    member's kind and a computed member's key index cannot be
//                    read at all. Kept here because the alternative is a
//                    fourth extractor for one header.
//
// constants.json already describes the source-position *table* (varints, delta
// and zig-zag encoding); this is the bitfield inside each entry's second value.

import { parseBitFieldChain } from './constants.mjs';
import { Cpp } from '../cpp.mjs';

export const CPP_LAYOUT_SOURCES = [
  'src/objects/bigint.h',
  'src/objects/hash-table.h',
  'src/codegen/source-position.h',
  'src/objects/literal-objects.h',
];

/**
 * `using IsExternalField = base::BitField64<bool, 0, 1>;` -> `isExternal`.
 * The profile uses the lower-camel field name without the `Field` suffix.
 */
function camelField(name) {
  const n = name.replace(/Field$|Bits$/, '');
  return n[0].toLowerCase() + n.slice(1);
}

/**
 * BigIntBase: `bitfield_` (uint32) then a flexible array of
 * `UnalignedValueMember<digit_t>`.
 *
 * UnalignedValueMember is `alignas(alignof(Tagged_t)) char storage_[sizeof(T)]`
 * (src/objects/tagged-field.h), so the digit array starts at the next
 * kTaggedSize boundary after the bitfield -- with pointer compression the
 * bitfield ends exactly on that boundary, without it there are
 * kTaggedSize - kUInt32Size bytes of padding. Reading the first digit four
 * bytes early makes every BigInt come out multiplied by 2^32.
 */
export function deriveBigIntLayout(text, { sizes, taggedSize, parentSize }) {
  const bits = /static const uint32_t kLengthFieldBits = (\d+);/.exec(text);
  const sign = /using SignBits = base::BitField<bool, (\d+), (\d+)>;/.exec(text);
  const lengthNext = /using LengthBits = SignBits::Next<\s*\w+\s*,\s*kLengthFieldBits>;/.test(text);
  const digit = /using digit_t = (\w+);/.exec(text);
  const missing = [];
  if (!bits) missing.push('kLengthFieldBits');
  if (!sign) missing.push('SignBits');
  if (!lengthNext) missing.push('LengthBits = SignBits::Next<_, kLengthFieldBits>');
  if (!digit) missing.push('digit_t');
  if (parentSize === null || parentSize === undefined) missing.push('PrimitiveHeapObject::size');
  if (missing.length) return { layout: null, missing };
  const DIGIT_SIZE = { uintptr_t: sizes.kSystemPointerSize, uint64_t: 8, uint32_t: 4 };
  const digitSize = DIGIT_SIZE[digit[1]];
  if (digitSize === undefined) return { layout: null, missing: [`digit_t = ${digit[1]} (unknown width)`] };
  const signField = { offset: Number(sign[1]), width: Number(sign[2]) };
  const lengthField = { offset: signField.offset + signField.width, width: Number(bits[1]) };
  const bitfieldSize = sizes.kUInt32Size;
  const unpadded = parentSize + bitfieldSize;
  const digitsOffset = Math.ceil(unpadded / taggedSize) * taggedSize;
  return {
    layout: {
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
      note: 'raw_digits is a FLEXIBLE_ARRAY_MEMBER of UnalignedValueMember<digit_t>, which is '
        + 'alignas(alignof(Tagged_t)) (src/objects/tagged-field.h), so the array starts at the next '
        + 'kTaggedSize boundary after bitfield_',
    },
    missing: [],
  };
}

/** HashTableBase's fixed index prefix. */
export function deriveHashTableLayout(text) {
  const out = { source: 'src/objects/hash-table.h' };
  const missing = [];
  for (const [key, name] of [
    ['numberOfElementsIndex', 'kNumberOfElementsIndex'],
    ['numberOfDeletedElementsIndex', 'kNumberOfDeletedElementsIndex'],
    ['capacityIndex', 'kCapacityIndex'],
    ['prefixStartIndex', 'kPrefixStartIndex'],
  ]) {
    const m = new RegExp(`static const int ${name} = (\\d+);`).exec(text);
    if (!m) { missing.push(name); continue; }
    out[key] = Number(m[1]);
  }
  out.note = 'entries start at prefixStartIndex + Shape::kPrefixSize; the Shape constants live with '
    + 'each table class in C++ and are not extracted here';
  return { layout: missing.length ? null : out, missing };
}

/** The SourcePosition::raw() bitfield, plus the +1 biases read off the setters. */
export function deriveSourcePositionLayout(text) {
  const chain = parseBitFieldChain(text);
  const fields = {};
  for (const [name, f] of Object.entries(chain)) fields[camelField(name)] = f;
  const missing = [];
  for (const k of ['isExternal', 'scriptOffset', 'inliningId']) if (!fields[k]) missing.push(`${k}Field`);
  const scriptBias = /value_ = ScriptOffsetField::update\(value_, script_offset \+ (\d+)\);/.exec(text);
  const inliningBias = /value_ = InliningIdField::update\(value_, inlining_id \+ (\d+)\);/.exec(text);
  const noPos = /kNoSourcePosition == (-?\d+)/.exec(text);
  if (!scriptBias) missing.push('ScriptOffsetField::update(value_, script_offset + N)');
  if (!inliningBias) missing.push('InliningIdField::update(value_, inlining_id + N)');
  if (missing.length) return { layout: null, missing };
  return {
    layout: {
      source: 'src/codegen/source-position.h',
      fields,
      scriptOffsetBias: Number(scriptBias[1]),
      inliningIdBias: Number(inliningBias[1]),
      kNoSourcePosition: noPos ? Number(noPos[1]) : null,
      note: 'scriptOffset = ScriptOffsetField::decode(raw) - scriptOffsetBias, valid only when isExternal is 0; '
        + 'the bias exists so that kNoSourcePosition (-1) stores as 0',
    },
    missing: [],
  };
}

/**
 * ClassBoilerplate's C++-only vocabulary.
 *
 * The seven *fields* are Torque's (src/objects/literal-objects.tq), but what
 * the fields MEAN is stated only in C++, and a reader that does not have it
 * cannot tell a getter from a method:
 *
 *   enum ValueKind { kData, kGetter, kSetter, kAutoAccessor }
 *       which half of an accessor a template entry holds.
 *   enum DefineClassArgumentsIndices
 *       kConstructorArgumentIndex / kPrototypeArgumentIndex /
 *       kFirstDynamicArgumentIndex: the entries whose value index is below
 *       kFirstDynamicArgumentIndex are the ones ClassBoilerplate::New adds
 *       itself (`constructor` -> 1), not members of the source class.
 *   ComputedEntryFlags
 *       the (ValueKind, key index) Smi packing of a computed-name member,
 *       written as a DEFINE_BIT_FIELDS chain whose widths are in the macro.
 *   kMinimumClassPropertiesCount / kMinimumPrototypePropertiesCount
 *       the descriptor slack, i.e. how many of a template's slots are reserve
 *       rather than content.
 *
 * Every number is read out of the pinned header; none is written here.
 */
export function deriveClassBoilerplateFacts(rawText) {
  const missing = [];
  const out = { source: 'src/objects/literal-objects.h' };

  const valueKind = /enum\s+ValueKind\s*\{([^}]*)\}/.exec(rawText);
  if (!valueKind) missing.push('enum ValueKind');
  else {
    out.valueKind = {};
    let next = 0;
    for (const part of valueKind[1].split(',')) {
      const m = /^\s*(k[A-Za-z_]\w*)\s*(?:=\s*(-?\d+)\s*)?$/.exec(part);
      if (!m) continue;
      next = m[2] === undefined ? next : Number(m[2]);
      out.valueKind[m[1]] = next;
      next++;
    }
    if (Object.keys(out.valueKind).length === 0) missing.push('enum ValueKind members');
  }

  const argsEnum = /enum\s+DefineClassArgumentsIndices\s*\{([\s\S]*?)\}/.exec(rawText);
  if (!argsEnum) missing.push('enum DefineClassArgumentsIndices');
  else {
    out.argumentIndices = {};
    let next = 0;
    for (const part of argsEnum[1].replace(/\/\/[^\n]*/g, '').split(',')) {
      const m = /^\s*(k[A-Za-z_]\w*)\s*(?:=\s*(-?\d+)\s*)?$/.exec(part);
      if (!m) continue;
      next = m[2] === undefined ? next : Number(m[2]);
      out.argumentIndices[m[1]] = next;
      next++;
    }
    for (const k of ['kConstructorArgumentIndex', 'kPrototypeArgumentIndex', 'kFirstDynamicArgumentIndex']) {
      if (out.argumentIndices[k] === undefined) missing.push(`DefineClassArgumentsIndices::${k}`);
    }
  }

  // #define COMPUTED_ENTRY_BIT_FIELDS(V, _) V(ValueKindBits, ValueKind, 2, _) \
  //                                        V(KeyIndexBits, unsigned, 29, _)
  // DEFINE_BIT_FIELDS accumulates the widths in declaration order from bit 0
  // (src/base/bit-field.h: Next<T, size> starts at kShift + kSize).
  const macro = /#define\s+COMPUTED_ENTRY_BIT_FIELDS\(V,\s*_\)([\s\S]*?)\n\s*DEFINE_BIT_FIELDS\(COMPUTED_ENTRY_BIT_FIELDS\)/.exec(rawText);
  if (!macro) missing.push('COMPUTED_ENTRY_BIT_FIELDS');
  else {
    out.computedEntryFlags = { fields: {} };
    let offset = 0;
    const entry = /V\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_][\w: ]*)\s*,\s*(\d+)\s*,\s*_\s*\)/g;
    for (let m = entry.exec(macro[1]); m !== null; m = entry.exec(macro[1])) {
      const width = Number(m[3]);
      out.computedEntryFlags.fields[camelField(m[1])] = { offset, width, type: m[2].trim() };
      offset += width;
    }
    out.computedEntryFlags.usedBits = offset;
    for (const k of ['valueKind', 'keyIndex']) {
      if (!out.computedEntryFlags.fields[k]) missing.push(`COMPUTED_ENTRY_BIT_FIELDS ${k}`);
    }
  }

  for (const [key, name] of [['minimumClassPropertiesCount', 'kMinimumClassPropertiesCount'],
    ['minimumPrototypePropertiesCount', 'kMinimumPrototypePropertiesCount']]) {
    const m = new RegExp(`static const int ${name} = (\\d+);`).exec(rawText);
    if (!m) { missing.push(name); continue; }
    out[key] = Number(m[1]);
  }

  out.note = 'the member list is in static_/instance_properties_template (a DescriptorArray, or a '
    + 'name dictionary once a class has a computed-name member or more than kMaxNumberOfDescriptors '
    + 'properties) and in static_/instance_computed_properties; an entry\'s value is '
    + 'Smi(argument index) for a data member and an AccessorPair of two such Smis for an accessor '
    + '(ClassBoilerplate::New, AddToDictionaryTemplate / AddToDescriptorArrayTemplate). A FIELD '
    + 'is in neither: ClassBoilerplate::New `continue`s on ClassLiteral::Property::FIELD.';
  return { layout: missing.length ? null : out, missing };
}

/**
 * @param {object} src V8Source
 * @param {{defines: object, sizes: object, taggedSize: number, classes: object}} opts
 */
export async function deriveCppLayouts(src, { defines, sizes, taggedSize, classes }) {
  const unresolved = [];
  const out = {};
  const texts = {};
  const raw = {};
  for (const p of CPP_LAYOUT_SOURCES) {
    const f = await src.get(p, { optional: true });
    if (!f.text) { unresolved.push({ layout: p, source: p, line: null, reason: `header not available (HTTP ${f.status})` }); continue; }
    raw[p] = f.text;
    // These headers are read for declarations inside `#ifdef`-guarded regions
    // (V8_ENABLE_SANDBOX changes nothing here today, but the guard is honoured
    // rather than assumed away).
    texts[p] = new Cpp(defines).run(f.text, { label: p });
  }

  const bigint = texts['src/objects/bigint.h']
    ? deriveBigIntLayout(texts['src/objects/bigint.h'], {
      sizes, taggedSize, parentSize: classes.PrimitiveHeapObject?.size ?? null,
    })
    : { layout: null, missing: ['src/objects/bigint.h'] };
  if (bigint.layout) out.BigIntBase = bigint.layout;
  else unresolved.push({ layout: 'BigIntBase', source: 'src/objects/bigint.h', line: null, reason: `cannot derive: ${bigint.missing.join(', ')} not found` });

  const ht = texts['src/objects/hash-table.h']
    ? deriveHashTableLayout(texts['src/objects/hash-table.h'])
    : { layout: null, missing: ['src/objects/hash-table.h'] };
  if (ht.layout) out.HashTableBase = ht.layout;
  else unresolved.push({ layout: 'HashTableBase', source: 'src/objects/hash-table.h', line: null, reason: `cannot derive: ${ht.missing.join(', ')} not found` });

  const sp = texts['src/codegen/source-position.h']
    ? deriveSourcePositionLayout(texts['src/codegen/source-position.h'])
    : { layout: null, missing: ['src/codegen/source-position.h'] };
  if (sp.layout) out.SourcePosition = sp.layout;
  else unresolved.push({ layout: 'SourcePosition', source: 'src/codegen/source-position.h', line: null, reason: `cannot derive: ${sp.missing.join(', ')} not found` });

  // The macro body this reads is a #define, so it is taken from the header as
  // fetched rather than from the preprocessed text, which has expanded it away.
  const cb = raw['src/objects/literal-objects.h']
    ? deriveClassBoilerplateFacts(raw['src/objects/literal-objects.h'])
    : { layout: null, missing: ['src/objects/literal-objects.h'] };
  if (cb.layout) out.ClassBoilerplate = cb.layout;
  else unresolved.push({ layout: 'ClassBoilerplate', source: 'src/objects/literal-objects.h', line: null, reason: `cannot derive: ${cb.missing.join(', ')} not found` });

  return { cppLayouts: out, unresolved };
}

export default {
  deriveCppLayouts, deriveBigIntLayout, deriveHashTableLayout, deriveSourcePositionLayout,
  deriveClassBoilerplateFacts, CPP_LAYOUT_SOURCES,
};
