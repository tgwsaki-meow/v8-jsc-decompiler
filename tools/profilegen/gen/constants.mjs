// tools/profilegen/gen/constants.mjs
//
// The scalar constants a decoder needs, derived from source rather than typed in.
//
// Sources and what each one gives us:
//   src/common/globals.h          kTaggedSize, kPageSizeBits, kObjectAlignment,
//                                 kHeapObjectTag, kScopeInfoMaxInlinedLocalNamesSize, ...
//   src/heap/memory-chunk.h       sizeof(MemoryChunk) -> the RO page header size
//   src/heap/memory-chunk-layout.h  ObjectStartOffsetInDataPage()
//   src/codegen/handler-table.h   the 4-int32 range-entry layout + its bitfields
//   src/codegen/source-position-table.cc  the varint / zig-zag / delta encoding
//   src/snapshot/code-serializer.h + snapshot-data.h  the .jsc header offsets
//
// Seeded facts: the C++ `sizeof` primitives for an LP64 / x64 target
// (kInt32Size = 4 and friends). globals.h defines those as `sizeof(int32_t)`,
// which no amount of macro expansion will evaluate; they are properties of the
// ABI, not of the V8 version, and they are listed explicitly in
// meta.json -> seededConstants so nothing is hidden.

import { Cpp, evalIntExpr } from '../cpp.mjs';

/** sizeof() facts for x64 / LP64. Not version-specific; see the note above. */
export function seedConstants({ taggedSize = 4 } = {}) {
  return {
    kBitsPerByte: 8,
    kBitsPerByteLog2: 3,
    kBitsPerSystemPointer: 64,
    kBitsPerSystemPointerLog2: 6,
    kCharSize: 1,
    kShortSize: 2,
    kIntSize: 4,
    kInt8Size: 1, kUInt8Size: 1,
    kInt16Size: 2, kUInt16Size: 2,
    kInt32Size: 4, kUInt32Size: 4,
    kInt64Size: 8, kUInt64Size: 8,
    kFloat16Size: 2, kFloatSize: 4, kDoubleSize: 8,
    kIntptrSize: 8, kUIntptrSize: 8, kSizetSize: 8,
    kSystemPointerSize: 8, kSystemPointerSizeLog2: 3,
    kRegisterSize: 8,
    kPCOnStackSize: 8, kFPOnStackSize: 8,
    kElidedFrameSlots: 0,
    kExternalAllocationSoftLimit: 64 * 1024 * 1024,
    // the one build-config seed: pointer compression decides Tagged_t's width
    kTaggedSize: taggedSize,
    kTaggedSizeLog2: taggedSize === 4 ? 2 : 3,
  };
}

// `constexpr int kFoo = ...;` and also plain `const int kFoo = ...;` -- globals.h
// still uses the latter for the tagging constants (kHeapObjectTag, kSmiTag, ...).
const CONSTEXPR_RE =
  /(?:^|\n)\s*(?:V8_EXPORT_PRIVATE\s+)?(?:static\s+)?(?:inline\s+)?(?:constexpr|const)\s+(?:int|unsigned|size_t|intptr_t|uintptr_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|int64_t|uint64_t|Tagged_t|AddressRange)\s+(k[A-Za-z0-9_]+)\s*=\s*([^;]+);/g;

/** Resolve a raw `name -> expression` map to integers, iterating to a fixed point. */
function resolveConstants(raw, seeds, cpp) {
  const out = { ...seeds };
  const pending = new Map(raw);
  for (let pass = 0; pass < 12 && pending.size; pass++) {
    let progressed = false;
    for (const [name, expr] of [...pending]) {
      if (name in out) { pending.delete(name); continue; }
      let e = expr;
      try { e = cpp ? cpp.expand(expr, new Set()) : expr; } catch { /* keep raw */ }
      const { value, unknown } = evalIntExpr(e, out);
      if (unknown.length === 0 && Number.isFinite(value)) {
        out[name] = value;
        pending.delete(name);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { resolved: out, unresolved: [...pending.keys()].sort() };
}

/** base::BitField<T, shift, size> chains, including `Prev::Next<T, size>`. */
export function parseBitFieldChain(text) {
  const fields = {};
  // `using Name = base::BitField<Type, shift, size>;` (also BitField8/16/64)
  for (const m of text.matchAll(/using\s+(\w+)\s*=\s*base::BitField(?:8|16|64)?\s*<\s*([^,<>]+(?:<[^<>]*>)?)\s*,\s*(\d+)\s*,\s*(\d+)\s*>/g)) {
    fields[m[1]] = { type: m[2].trim(), offset: Number(m[3]), width: Number(m[4]) };
  }
  // `using Name = Prev::Next<Type, size>;`
  let changed = true;
  const nexts = [...text.matchAll(/using\s+(\w+)\s*=\s*(\w+)::Next\s*<\s*([^,<>]+(?:<[^<>]*>)?)\s*,\s*(\d+)\s*>/g)];
  while (changed) {
    changed = false;
    for (const m of nexts) {
      if (fields[m[1]]) continue;
      const prev = fields[m[2]];
      if (!prev) continue;
      fields[m[1]] = { type: m[3].trim(), offset: prev.offset + prev.width, width: Number(m[4]) };
      changed = true;
    }
  }
  return fields;
}

/**
 * sizeof(MemoryChunk) from its non-static data members.
 *
 * `text` must already be preprocessed, because the second member is
 * `uint32_t metadata_index_` under V8_ENABLE_SANDBOX and
 * `MemoryChunkMetadata* metadata_` otherwise.
 *
 * The usual C++ struct rules apply: every member sits at a multiple of its own
 * alignment and the total is rounded up to the widest member's alignment.
 */
function sizeOfMemoryChunk(text, { systemPointerSize = 8 } = {}) {
  const i = text.indexOf('class V8_EXPORT_PRIVATE MemoryChunk final');
  if (i < 0) return { size: null, members: [], note: 'class MemoryChunk not found' };
  const end = text.indexOf('\n};', i);
  const body = text.slice(i, end < 0 ? text.length : end);
  const KNOWN = {
    MainThreadFlags: 8, uintptr_t: 8, size_t: 8,
    uint32_t: 4, int32_t: 4, uint16_t: 2, uint8_t: 1, uint64_t: 8, Address: 8,
  };
  // Any `T*` member is one system pointer whatever T is. Naming the pointee
  // types instead is how the kTaggedSize=8 profile lost its read-only page
  // header: without V8_ENABLE_SANDBOX the member is `BasePage* metadata_`
  // rather than `uint32_t metadata_index_`, and a table of literal type names
  // had no entry for it.
  const sizeOf = (type) => (type.endsWith('*') ? systemPointerSize : (KNOWN[type] ?? null));
  const members = [];
  for (const m of body.matchAll(/^\s{2}(?!static\b|using\b|friend\b|template\b|V8_|\/\/|return\b|const\b)([A-Za-z_][\w:]*\s*\*?)\s+(\w+_)\s*(?:=\s*[^;]*)?;[ \t]*$/gm)) {
    const type = m[1].replace(/\s+/g, '');
    members.push({ type, name: m[2], size: sizeOf(type) });
  }
  const unknown = members.filter((x) => x.size === null);
  if (!members.length || unknown.length) {
    return {
      size: null, members,
      note: unknown.length
        ? `sizeof(MemoryChunk) not derivable: unsized members ${unknown.map((u) => u.type + ' ' + u.name).join(', ')}`
        : 'sizeof(MemoryChunk) not derivable: no data members matched',
    };
  }
  let off = 0;
  let maxAlign = 1;
  for (const m of members) {
    const align = Math.min(m.size, 8);
    maxAlign = Math.max(maxAlign, align);
    off = Math.ceil(off / align) * align;
    m.offset = off;
    off += m.size;
  }
  return { size: Math.ceil(off / maxAlign) * maxAlign, members, note: null };
}

/**
 * sizeof() for the V8 handle typedefs that globals.h uses to *define* the slot
 * sizes. These are ABI facts about the typedef's underlying integer type, not
 * version-specific constants; they are listed in meta.json -> seededConstants.
 */
function sizeofTypes({ taggedSize, sandbox }) {
  return {
    'ExternalPointer_t': sandbox ? 4 : 8,   // ExternalPointerHandle (uint32_t) vs Address
    'CppHeapPointer_t': 4,                  // CppHeapPointerHandle (uint32_t)
    'IndirectPointerHandle': 4,
    'ExternalPointerHandle': 4,
    'CppHeapPointerHandle': 4,
    'JSDispatchHandle': 4,
    'Tagged_t': taggedSize,
    'Address': 8, 'uintptr_t': 8, 'intptr_t': 8, 'size_t': 8, 'void*': 8,
    'uint64_t': 8, 'int64_t': 8, 'uint32_t': 4, 'int32_t': 4,
    'uint16_t': 2, 'int16_t': 2, 'uint8_t': 1, 'int8_t': 1,
    'double': 8, 'float': 4, 'int': 4, 'unsigned': 4, 'char': 1,
  };
}

export async function deriveConstants(src, { defines, taggedSize, gnFlags }) {
  const cpp = new Cpp(defines);
  const raw = new Map();
  const sizeofMap = sizeofTypes({ taggedSize, sandbox: !!gnFlags.v8_enable_sandbox });
  const substituteSizeof = (e) => e.replace(/\bsizeof\s*\(\s*([A-Za-z_][\w:]*\s*\*?)\s*\)/g,
    (whole, ty) => (sizeofMap[ty.replace(/\s+/g, '')] !== undefined ? String(sizeofMap[ty.replace(/\s+/g, '')]) : whole));

  // include/v8-internal.h holds the tagging constants (kHeapObjectTag, kSmiTag,
  // ...) and the SmiTagging<N> specialisations; globals.h only re-exports them.
  const files = ['include/v8-internal.h', 'src/base/macros.h', 'src/base/build_config.h', 'src/common/globals.h'];
  const asserts = [];
  for (const p of files) {
    const f = await src.get(p, { optional: true });
    if (!f.text) continue;
    const active = cpp.run(f.text, { label: p });
    for (const m of active.matchAll(CONSTEXPR_RE)) {
      if (!raw.has(m[1])) raw.set(m[1], substituteSizeof(m[2].replace(/\s+/g, ' ').trim()));
    }
    // `static_assert(kX == <expr>)` in an active region pins kX when its own
    // definition is a sizeof() we cannot evaluate.
    for (const m of active.matchAll(/static_assert\(\s*(k[A-Za-z0-9_]+)\s*==\s*([^;)]+)\)/g)) {
      asserts.push([m[1], substituteSizeof(m[2].trim())]);
    }
  }
  // `const int kSmiShiftSize = PlatformSmiTagging::kSmiShiftSize;` resolves
  // through a template specialisation, which our expression evaluator cannot
  // follow. Read the specialisation for this tagged size directly:
  //   template <> struct SmiTagging<4> { enum { kSmiShiftSize = 0, kSmiValueSize = 31 }; };
  const vi = (await src.get('include/v8-internal.h', { optional: true })).text ?? '';
  const smi = new RegExp(`struct\\s+SmiTagging<\\s*${taggedSize}\\s*>\\s*\\{\\s*enum\\s*\\{([^}]*)\\}`).exec(vi);
  if (smi) {
    for (const m of smi[1].matchAll(/(k[A-Za-z0-9_]+)\s*=\s*(-?\d+)/g)) raw.set(m[1], m[2]);
  }

  const seeds = seedConstants({ taggedSize });
  let { resolved, unresolved } = resolveConstants(raw, seeds, cpp);
  // second chance for anything a static_assert pins
  if (unresolved.length && asserts.length) {
    const extra = new Map();
    for (const [name, expr] of asserts) if (unresolved.includes(name) && !extra.has(name)) extra.set(name, expr);
    if (extra.size) {
      const again = resolveConstants(extra, resolved, cpp);
      resolved = again.resolved;
      unresolved = unresolved.filter((u) => !(u in resolved));
    }
  }

  // --- pointer-ish slot sizes, from the macro predicates globals.h sets up ----
  const sandbox = !!gnFlags.v8_enable_sandbox;
  const compress = taggedSize === 4;
  const slotSizes = {
    kTaggedSize: taggedSize,
    kProtectedPointerSize: taggedSize,
    kTrustedPointerSize: resolved.kTrustedPointerSize ?? (sandbox ? 4 : taggedSize),
    kIndirectPointerSize: resolved.kIndirectPointerSize ?? 4,
    kExternalPointerSlotSize: resolved.kExternalPointerSlotSize ?? (sandbox ? 4 : 8),
    kCppHeapPointerSlotSize: resolved.kCppHeapPointerSlotSize ?? (compress ? 4 : 8),
    kCodePointerSize: resolved.kCodePointerSize ?? (sandbox ? 4 : 8),
    kJSDispatchHandleSize: resolved.kJSDispatchHandleSize ?? 4,
    kSystemPointerSize: 8,
    kDoubleSize: 8,
    kInt32Size: 4, kUInt32Size: 4, kInt16Size: 2, kUInt16Size: 2,
    kInt8Size: 1, kUInt8Size: 1, kFloat16Size: 2, kFloatSize: 4,
    kObjectAlignment: resolved.kObjectAlignment ?? 8,
    kObjectAlignmentMask: resolved.kObjectAlignmentMask ?? 7,
  };

  // --- read-only page geometry ----------------------------------------------
  const mcRaw = (await src.get('src/heap/memory-chunk.h', { optional: true })).text ?? '';
  const mcCpp = new Cpp(defines);
  const mcText = mcRaw ? mcCpp.run(mcRaw, { label: 'memory-chunk.h' }) : '';
  const chunk = sizeOfMemoryChunk(mcText, { systemPointerSize: slotSizes.kSystemPointerSize });
  const pageSizeBits = resolved.kPageSizeBits ?? null;
  const regularPageSize = resolved.kRegularPageSize ?? (pageSizeBits !== null ? 1 << pageSizeBits : null);
  // MemoryChunkLayout::ObjectStartOffsetInDataPage()
  //   = RoundUp(sizeof(MemoryChunk), ALIGN_TO_ALLOCATION_ALIGNMENT(kDoubleSize))
  // and read-only pages use the data-page layout.
  const allocAlign = slotSizes.kObjectAlignment;
  const pageHeaderSize = chunk.size === null ? null : Math.ceil(chunk.size / allocAlign) * allocAlign;

  // --- handler table ---------------------------------------------------------
  const htText = (await src.require('src/codegen/handler-table.h')).text;
  const htCpp = new Cpp(defines);
  const htActive = htCpp.run(htText, { label: 'handler-table.h' });
  const handlerTable = {
    rangeStartIndex: Number(/kRangeStartIndex\s*=\s*(\d+)/.exec(htActive)?.[1] ?? NaN),
    rangeEndIndex: Number(/kRangeEndIndex\s*=\s*(\d+)/.exec(htActive)?.[1] ?? NaN),
    rangeHandlerIndex: Number(/kRangeHandlerIndex\s*=\s*(\d+)/.exec(htActive)?.[1] ?? NaN),
    rangeDataIndex: Number(/kRangeDataIndex\s*=\s*(\d+)/.exec(htActive)?.[1] ?? NaN),
    rangeEntrySize: Number(/kRangeEntrySize\s*=\s*(\d+)/.exec(htActive)?.[1] ?? NaN),
    entryFieldSize: 4,            // the entries are int32 in a TrustedByteArray
    bitFields: parseBitFieldChain(htActive),
    catchPrediction: (() => {
      const e = /enum\s+CatchPrediction\s*(?::\s*\w+\s*)?\{([\s\S]*?)\}/.exec(htActive);
      if (!e) return null;
      const out = {};
      let next = 0;
      for (const piece of e[1].split(',')) {
        const m = /^\s*([A-Z][A-Z0-9_]*)\s*(?:=\s*(-?\d+))?\s*$/.exec(piece);
        if (!m) continue;
        if (m[2] !== undefined) next = Number(m[2]);
        out[m[1]] = next;
        next++;
      }
      return out;
    })(),
  };
  handlerTable.rangeEntryBytes = handlerTable.rangeEntrySize * handlerTable.entryFieldSize;

  // --- source position table -------------------------------------------------
  const sptText = (await src.require('src/codegen/source-position-table.cc')).text;
  const sptBits = parseBitFieldChain(sptText);
  const codeShift = /entry->code_offset\s*=\s*tmp\s*>>\s*(\d+)/.exec(sptText);
  const breakable = /is_breakable\s*=\s*\(tmp\s*&\s*(0b[01]+|0x[0-9a-fA-F]+|\d+)\)\s*>>\s*(\d+)/.exec(sptText);
  const statement = /is_statement\s*=\s*tmp\s*&\s*(\d+)/.exec(sptText);
  const sourcePositionTable = {
    varint: { payloadBitsPerByte: sptBits.ValueBits?.width ?? null, moreBit: sptBits.MoreBit?.offset ?? null },
    deltaEncoded: /AddAndSetEntry/.test(sptText),
    zigZagSigned: /\(z\s*>>\s*1\)\s*\^\s*\(?-\(?z\s*&\s*1\)?\)?/.test(sptText.replace(/\s+/g, ' ')) || /DecodeInt/.test(sptText),
    firstEntry: {
      codeOffsetShift: codeShift ? Number(codeShift[1]) : null,
      isBreakableMask: breakable ? Number(breakable[1].startsWith('0b') ? parseInt(breakable[1].slice(2), 2) : breakable[1]) : null,
      isBreakableShift: breakable ? Number(breakable[2]) : null,
      isStatementMask: statement ? Number(statement[1]) : null,
    },
    bitFields: sptBits,
  };

  // --- .jsc header -----------------------------------------------------------
  const csText = (await src.require('src/snapshot/code-serializer.h')).text;
  const sdText = (await src.get('src/snapshot/snapshot-data.h', { optional: true })).text ?? '';
  const hdrRaw = new Map();
  for (const m of (csText + '\n' + sdText).matchAll(/static\s+const(?:expr)?\s+uint32_t\s+(k[A-Za-z0-9_]+Offset|kUnalignedHeaderSize|kHeaderSize)\s*=\s*([^;]+);/g)) {
    if (!hdrRaw.has(m[1])) hdrRaw.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  const hdrSeed = {
    ...slotSizes,
    kMagicNumberOffset: 0,
    POINTER_SIZE_ALIGN: 0, // not a constant; handled below
  };
  delete hdrSeed.POINTER_SIZE_ALIGN;
  // POINTER_SIZE_ALIGN(x) rounds up to kSystemPointerSize
  for (const [k, v] of hdrRaw) {
    hdrRaw.set(k, v.replace(/POINTER_SIZE_ALIGN\s*\(\s*([A-Za-z0-9_]+)\s*\)/g, '(($1 + 7) & ~7)'));
  }
  const hdr = resolveConstants(hdrRaw, hdrSeed, null);
  const codeCacheHeader = {};
  for (const [k, v] of Object.entries(hdr.resolved)) {
    if (/Offset$/.test(k) || k === 'kHeaderSize' || k === 'kUnalignedHeaderSize') codeCacheHeader[k] = v;
  }

  // --- the four header words' own content ------------------------------------
  // The offsets above say *where* each header word is; these say what is in it.
  // Without them a reader cannot check the magic at all, and cannot tell the
  // source length in sourceHash from the two flag bits above it.
  const codeCacheUnresolved = [];
  //   static constexpr uint32_t kMagicNumber = 0xC0DE0000 ^ ExternalReferenceTable::kSize;
  const magicM = /kMagicNumber\s*=\s*(0[xX][0-9A-Fa-f]+)\s*\^\s*ExternalReferenceTable::kSize/.exec(sdText);
  if (magicM) {
    codeCacheHeader.magicBase = Number(magicM[1]);
    codeCacheHeader.magicRule = 'magic = magicBase ^ ExternalReferenceTable::kSize, so '
      + 'externalReferenceTableSize = magic ^ magicBase (the table size is a property of the '
      + 'target build and cannot be derived from these sources)';
  } else {
    codeCacheUnresolved.push({
      what: 'codeCacheHeader.magicBase',
      source: 'src/snapshot/snapshot-data.h',
      line: null,
      reason: 'no `kMagicNumber = 0x.... ^ ExternalReferenceTable::kSize` found',
    });
  }
  //   uint32_t SerializedCodeData::SourceHash(...) {
  //     using LengthField = base::BitField<uint32_t, 0, 29>;
  //     using HasWrappedArgumentsField = LengthField::Next<bool, 1>;
  //     using IsModuleField = HasWrappedArgumentsField::Next<bool, 1>;
  const ccText = (await src.get('src/snapshot/code-serializer.cc', { optional: true })).text ?? '';
  const shFn = /uint32_t SerializedCodeData::SourceHash\(([\s\S]*?)\n\}/.exec(ccText);
  if (shFn) {
    const chain = parseBitFieldChain(shFn[1]);
    const name = { LengthField: 'length', HasWrappedArgumentsField: 'hasWrappedArguments', IsModuleField: 'isModule' };
    const sourceHash = {};
    for (const [alias, f] of Object.entries(chain)) {
      const key = name[alias];
      if (!key) {
        codeCacheUnresolved.push({
          what: `codeCacheHeader.sourceHash.${alias}`,
          source: 'src/snapshot/code-serializer.cc',
          line: null,
          reason: `SourceHash declares a bitfield this generator does not know (${alias}); the sourceHash word has a field we would otherwise read as part of the source length`,
        });
        continue;
      }
      sourceHash[key] = { offset: f.offset, width: f.width };
    }
    for (const k of ['length', 'hasWrappedArguments', 'isModule']) {
      if (!sourceHash[k]) {
        codeCacheUnresolved.push({
          what: `codeCacheHeader.sourceHash.${k}`,
          source: 'src/snapshot/code-serializer.cc',
          line: null,
          reason: 'SerializedCodeData::SourceHash does not declare the expected base::BitField chain',
        });
      }
    }
    if (Object.keys(sourceHash).length) {
      codeCacheHeader.sourceHash = sourceHash;
      codeCacheHeader.sourceHashNote = 'the sourceHash header word is String::length() in `length`, '
        + 'not a hash; extracted_jsc/manifest.json mislabels this word as payload_size and labels '
        + 'flagHash as source_hash';
    }
  } else {
    codeCacheUnresolved.push({
      what: 'codeCacheHeader.sourceHash',
      source: 'src/snapshot/code-serializer.cc',
      line: null,
      reason: 'SerializedCodeData::SourceHash not found',
    });
  }
  //   src/snapshot/snapshot-utils.cc Checksum(): adler32 seeded with 0 under
  //   V8_USE_ZLIB, a simple Fletcher-32 otherwise.
  const suText = (await src.get('src/snapshot/snapshot-utils.cc', { optional: true })).text ?? '';
  if (suText) {
    const zlib = /#ifdef V8_USE_ZLIB[\s\S]*?adler32\(0,\s*payload\.begin\(\)/.test(suText);
    const fletcher = /sum1\s*=\s*\(sum1\s*\+\s*data\)\s*%\s*(\d+)/.exec(suText);
    codeCacheHeader.checksum = {
      algorithm: zlib ? 'adler32' : 'fletcher32',
      seed: 0,
      modulus: zlib ? 65521 : (fletcher ? Number(fletcher[1]) : null),
      note: zlib
        ? 'adler32 seeded with 0, not the conventional 1 (src/snapshot/snapshot-utils.cc)'
        : 'Fletcher-32 with sum1/sum2 mod 65535 (src/snapshot/snapshot-utils.cc)',
      onlyWrittenWhen: 'v8_flags.verify_snapshot_checksum; otherwise the field is 0',
      source: 'src/snapshot/snapshot-utils.cc',
    };
  } else {
    codeCacheUnresolved.push({
      what: 'codeCacheHeader.checksum',
      source: 'src/snapshot/snapshot-utils.cc',
      line: null,
      reason: 'file not available',
    });
  }

  return {
    taggedSize,
    sizes: slotSizes,
    readOnlyPage: {
      pageSizeBits,
      regularPageSize,
      pageHeaderSize,
      objectStartOffsetInDataPage: pageHeaderSize,
      memoryChunkMembers: chunk.members,
      note: chunk.note,
      // Tagged_t = (chunkIndex << pageSizeBits) + chunkOffset + kHeapObjectTag
      addressFormula: '(chunkIndex << pageSizeBits) + chunkOffset + kHeapObjectTag',
    },
    tagging: {
      kHeapObjectTag: resolved.kHeapObjectTag ?? null,
      kHeapObjectTagSize: resolved.kHeapObjectTagSize ?? null,
      kHeapObjectTagMask: resolved.kHeapObjectTagMask ?? null,
      kSmiTag: resolved.kSmiTag ?? null,
      kSmiTagSize: resolved.kSmiTagSize ?? null,
      kSmiTagMask: resolved.kSmiTagMask ?? null,
      kSmiShiftSize: resolved.kSmiShiftSize ?? null,
      kSmiValueSize: resolved.kSmiValueSize ?? null,
    },
    scopeInfo: {
      kScopeInfoMaxInlinedLocalNamesSize: resolved.kScopeInfoMaxInlinedLocalNamesSize ?? null,
    },
    handlerTable,
    sourcePositionTable,
    codeCacheHeader,
    globals: resolved,
    unresolvedGlobals: unresolved,
    unresolvedCodeCacheHeader: hdr.unresolved,
    unresolvedCodeCacheContent: codeCacheUnresolved,
    seeded: [...Object.keys(seeds), ...Object.keys(sizeofMap).map((t) => `sizeof(${t})`)].sort(),
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
  };
}
