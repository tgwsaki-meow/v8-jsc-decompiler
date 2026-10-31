// Walk the reconstructed read-only heap image object by object and emit an
// authoritative (chunk,offset) -> object table.
//
// The walk is the same one V8 itself does in ReadOnlyHeapObjectIterator:
// start at page->area_start(), read the map word, ask the map for the object's
// size, advance. Nothing is pattern-matched.
//
// Layout facts, all from upstream V8 @14.4.258.16 with pointer compression
// (kTaggedSize = 4, kObjectAlignment = 4 -- src/common/globals.h:521,959):
//
//   HeapObject            +0  map        (Tagged_t, low bit = kHeapObjectTag)
//   HeapObject::kHeaderSize = 4
//
//   Map (src/objects/map.tq:37-75)
//     +4  instance_size_in_words                        uint8
//     +5  inobject_properties_start_or_ctor_fn_index     uint8
//     +6  used_or_unused_instance_size_in_words          uint8
//     +7  visitor_id                                     uint8
//     +8  instance_type                                  uint16
//     +10 bit_field / +11 bit_field2 / +12 bit_field3
//     +16 prototype .. +36 transitions_or_prototype_info, kSize = 40
//   (cross-check: include/v8-internal.h kMapInstanceTypeOffset == 8)
//   instance_size_in_words == 0 is kVariableSizeSentinel
//   (src/objects/map.h:242-248, src/objects/objects-definitions.h).
//
//   Name   (src/objects/name.tq:7)    +4 raw_hash_field uint32
//   String (src/objects/string.tq)    +8 length         int32   => header 12
//   SeqOneByteString chars[length]: char8     => SizeFor = align4(12 + len)
//   SeqTwoByteString chars[length]: char16    => SizeFor = align4(12 + 2*len)
//   Symbol (src/objects/name.tq:31)   +8 flags uint32, +12 description => 16
//
//   FixedArrayBase-shaped (src/objects/fixed-array.h:387-388 + .tq):
//     +4 length: Smi, elements at +8  => 8 + 4*length
//   ByteArray / TrustedByteArray: +4 length: Smi, bytes at +8 => align4(8+len)
//   FixedDoubleArray: +4 length: Smi, doubles at +8 => 8 + 8*length
//   ArrayList / WeakArrayList: +4 capacity: Smi, +8 length: Smi, data at +12
//   DescriptorArray (src/objects/descriptor-array.tq):
//     +4 number_of_all_descriptors uint16, +6 number_of_descriptors uint16,
//     +8 raw_gc_state uint32, +12 enum_cache  => header 16,
//     DescriptorEntry = {key, details, value} = 3 tagged = 12 bytes
//   FreeSpace: +4 size: Smi (byte size of the whole free block)
//   filler maps: one/two pointer filler => 1/2 * kTaggedSize

import { kPageSize, kAreaStartOffset, kTaggedSize, kHeapObjectTag, align } from './ro_snapshot.mjs';

const METAMAP_NAME = 'MetaMap';

const smi = (buf, o) => buf.readInt32LE(o) >> 1;

// --- variable-size shape rules, keyed by the *root name* of the map ---------
// Each entry returns the unaligned byte size of an instance.
const SHAPE = {
  oneByteString: (b, o) => 12 + b.readInt32LE(o + 8),
  twoByteString: (b, o) => 12 + 2 * b.readInt32LE(o + 8),
  fixedArray: (b, o) => 8 + kTaggedSize * smi(b, o + 4),
  fixedDoubleArray: (b, o) => 8 + 8 * smi(b, o + 4),
  byteArray: (b, o) => 8 + smi(b, o + 4),
  arrayList: (b, o) => 12 + kTaggedSize * smi(b, o + 4),
  // src/objects/descriptor-array.tq: map(4) nofAll(2) nofDesc(2)
  // raw_gc_state(4) flags(4) enum_cache(4) = 20, entry = 3 tagged = 12.
  descriptorArray: (b, o) => 20 + 12 * b.readUInt16LE(o + 4),
  // src/objects/free-space.h / free-space-inl.h:
  //   TaggedMember<Smi> size_in_tagged_;   at +kTaggedSize
  //   int size() { return size_in_tagged_.value() * kTaggedSize; }
  freeSpace: (b, o) => kTaggedSize * smi(b, o + 4),
  onePointerFiller: () => kTaggedSize,
  twoPointerFiller: () => 2 * kTaggedSize,
  propertyArray: (b, o) => 8 + kTaggedSize * (smi(b, o + 4) & 0x3ff),
  // src/objects/literal-objects.tq: length: Smi, backing_store_size: Smi,
  // flags: Smi, raw_entries[length]: Object  => header 16
  objectBoilerplateDescription: (b, o) => 16 + kTaggedSize * smi(b, o + 4),
  // src/objects/bigint.h: BigIntBase = {map, bitfield uint32}, digits are
  // kSystemPointerSize each; length lives in bits 0..29 of bitfield.
  bigInt: (b, o) => 8 + 8 * (b.readUInt32LE(o + 4) & 0x3fffffff),
  // src/objects/swiss-name-dictionary.h:28-35 documents the layout exactly:
  //   map(4) prefix(4) capacity(4) meta-table pointer(kTaggedSize)
  //   data table   2*capacity*kTaggedSize
  //   ctrl table   capacity + kGroupWidth bytes
  //   details      capacity bytes
  // kGroupWidth == Group::kWidth == 16 on x64 (SSE2 path, kUseSIMD).
  swissNameDictionary: (b, o) => {
    const capacity = b.readInt32LE(o + 8);
    const kGroupWidth = 16;
    return 4 + 4 + 4 + kTaggedSize
      + 2 * capacity * kTaggedSize
      + (capacity + kGroupWidth)
      + capacity;
  },
  // src/objects/hole.h: with V8_CAN_UNMAP_HOLES_BOOL (== V8_STATIC_ROOTS_BOOL)
  // Hole carries char payload_[64 * KB] after the map word, so that any field
  // load off a hole lands in an unmapped guard region.
  hole: () => kTaggedSize + 64 * 1024,
  // src/wasm/wasm-objects.h:1644-1666, same trick:
  // kSize = HeapObject::kHeaderSize + kPayloadSize(64 KB)
  wasmNull: () => kTaggedSize + 64 * 1024,
  // src/objects/scope-info.tq:120-190. Fixed prefix is 5 tagged slots
  // (flags, parameter_count, context_local_count, position_info.{start,end});
  // everything after that is conditional on ScopeFlags bits.
  scopeInfo: (b, o) => {
    const flags = b.readUInt32LE(o + 4);
    const bits = (lo, n) => (flags >>> lo) & ((1 << n) - 1);
    const SCOPE_TYPE = bits(0, 4);           // src/common/globals.h enum ScopeType
    const MODULE_SCOPE = 5, FUNCTION_SCOPE = 4;
    const sloppyEvalCanExtendVars = bits(4, 1);
    const hasSavedClassVariable = bits(10, 1);
    const functionVariable = bits(12, 2);    // VariableAllocationInfo, NONE == 0
    const hasInferredFunctionName = bits(14, 1);
    const hasOuterScopeInfo = bits(22, 1);
    const n = smi(b, o + 12);                // context_local_count
    const kMaxInlined = 75;                  // kScopeInfoMaxInlinedLocalNamesSize
    let slots = 5;
    let moduleVariableCount = 0;
    if (SCOPE_TYPE === MODULE_SCOPE) {
      moduleVariableCount = smi(b, o + 4 + slots * kTaggedSize);
      slots += 1;
    }
    slots += n < kMaxInlined ? n : 1;        // names inline, else a hashtable slot
    slots += n;                              // context_local_infos
    if (hasSavedClassVariable) slots += 1;
    if (functionVariable !== 0) slots += 2;  // FunctionVariableInfo = {name, index}
    if (hasInferredFunctionName) slots += 1;
    if (hasOuterScopeInfo) slots += 1;
    if (SCOPE_TYPE === MODULE_SCOPE) slots += 1 + 3 * moduleVariableCount;
    if (sloppyEvalCanExtendVars) slots += 1;
    if (SCOPE_TYPE === FUNCTION_SCOPE) slots += 1; // unused_parameter_bits
    return kTaggedSize + slots * kTaggedSize;
  },
};

const MAP_NAME_TO_SHAPE = new Map(Object.entries({
  SeqOneByteStringMap: 'oneByteString',
  InternalizedOneByteStringMap: 'oneByteString',
  SharedSeqOneByteStringMap: 'oneByteString',
  SeqTwoByteStringMap: 'twoByteString',
  InternalizedTwoByteStringMap: 'twoByteString',
  SharedSeqTwoByteStringMap: 'twoByteString',

  FixedArrayMap: 'fixedArray',
  FixedCOWArrayMap: 'fixedArray',
  TrustedFixedArrayMap: 'fixedArray',
  ProtectedFixedArrayMap: 'fixedArray',
  WeakFixedArrayMap: 'fixedArray',
  TrustedWeakFixedArrayMap: 'fixedArray',
  ProtectedWeakFixedArrayMap: 'fixedArray',
  TransitionArrayMap: 'fixedArray',
  HashTableMap: 'fixedArray',
  // OrderedHashTable<...> and the dictionaries all derive from FixedArray, so
  // they share its `length: Smi` header (src/objects/ordered-hash-table.h,
  // src/objects/dictionary.h).
  OrderedHashMapMap: 'fixedArray',
  OrderedHashSetMap: 'fixedArray',
  OrderedNameDictionaryMap: 'fixedArray',
  SimpleNameDictionaryMap: 'fixedArray',
  NameDictionaryMap: 'fixedArray',
  GlobalDictionaryMap: 'fixedArray',
  NumberDictionaryMap: 'fixedArray',
  SimpleNumberDictionaryMap: 'fixedArray',
  NameToIndexHashTableMap: 'fixedArray',
  RegisteredSymbolTableMap: 'fixedArray',
  EphemeronHashTableMap: 'fixedArray',
  ScriptContextTableMap: 'fixedArray',
  ClosureFeedbackCellArrayMap: 'fixedArray',
  ModuleInfoMap: 'fixedArray',
  ScriptListMap: 'fixedArray',
  EmbedderDataArrayMap: 'fixedArray',

  FixedDoubleArrayMap: 'fixedDoubleArray',
  ByteArrayMap: 'byteArray',
  TrustedByteArrayMap: 'byteArray',

  ArrayListMap: 'arrayList',
  WeakArrayListMap: 'arrayList',

  DescriptorArrayMap: 'descriptorArray',
  StrongDescriptorArrayMap: 'descriptorArray',

  FreeSpaceMap: 'freeSpace',
  OnePointerFillerMap: 'onePointerFiller',
  TwoPointerFillerMap: 'twoPointerFiller',
  PropertyArrayMap: 'propertyArray',

  HoleMap: 'hole',
  WasmNullMap: 'wasmNull',
  ScopeInfoMap: 'scopeInfo',
  ObjectBoilerplateDescriptionMap: 'objectBoilerplateDescription',
  BigIntMap: 'bigInt',
  SwissNameDictionaryMap: 'swissNameDictionary',
}));

/** Classify an object for the output table, from its map's root name. */
function classify(mapName) {
  if (mapName == null) return 'unknown';
  if (/^(SeqOneByte|InternalizedOneByte|SharedSeqOneByte)StringMap$/.test(mapName)) return 'string';
  if (/^(SeqTwoByte|InternalizedTwoByte|SharedSeqTwoByte)StringMap$/.test(mapName)) return 'string';
  if (/^(Cons|Sliced|Thin|External|UncachedExternal|SharedExternal|SharedUncachedExternal|ExternalInternalized|UncachedExternalInternalized)(One|Two)ByteStringMap$/.test(mapName)) return 'string';
  if (mapName === 'SymbolMap') return 'symbol';
  if (mapName === 'MetaMap') return 'map';
  if (mapName === 'HeapNumberMap') return 'heapNumber';
  if (mapName === 'UndefinedMap' || mapName === 'NullMap' || mapName === 'BooleanMap') return 'oddball';
  if (mapName === 'HoleMap') return 'hole';
  if (mapName === 'FreeSpaceMap') return 'freeSpace';
  if (mapName === 'OnePointerFillerMap' || mapName === 'TwoPointerFillerMap') return 'filler';
  if (mapName === 'CodeMap') return 'code';
  if (/Map$/.test(mapName)) return mapName.replace(/Map$/, '').replace(/^(.)/, (c) => c.toLowerCase());
  return 'other';
}

export class RoHeapImage {
  /**
   * @param pages  from parseReadOnlyImage()
   * @param staticRoots  from parseStaticRoots() -- used only to NAME objects and
   *                     to identify the maps; never to find object boundaries.
   */
  constructor(pages, staticRoots) {
    this.pages = new Map(pages.map((p) => [p.index, p]));
    this.sr = staticRoots;
    /** Tagged_t -> [rootName,...] */
    this.rootByAddr = staticRoots.byAddr;
    this.metaMapAddr = staticRoots.byName.get(METAMAP_NAME);
    if (this.metaMapAddr == null) throw new Error('static roots lack kMetaMap');
    this.maps = new Map(); // tagged addr (untagged, i.e. -1) -> {name, instanceSizeInWords, instanceType}
    this.#collectMaps();
  }

  pageBytes(chunk) {
    const p = this.pages.get(chunk);
    if (!p) return null;
    return p.bytes;
  }

  /** read a Tagged_t at (chunk, offset) */
  tagged(chunk, offset) {
    const b = this.pageBytes(chunk);
    if (!b) return null;
    return b.readUInt32LE(offset);
  }

  /** decompose an untagged compressed address */
  split(untagged) { return { chunk: untagged >>> 18, offset: untagged & (kPageSize - 1) }; }

  #collectMaps() {
    // A Map is exactly an object whose own map word is the MetaMap. Every map in
    // the RO heap is a read-only root, so iterating the static roots finds all
    // of them -- and the linear walk below re-checks that assumption (any object
    // whose map word is not in this table is reported, not guessed).
    for (const [addrTagged, names] of this.rootByAddr) {
      const untagged = addrTagged - kHeapObjectTag;
      const { chunk, offset } = this.split(untagged);
      const b = this.pageBytes(chunk);
      if (!b) continue;
      const mapWord = b.readUInt32LE(offset);
      if (mapWord !== this.metaMapAddr) continue;
      this.maps.set(untagged, {
        name: names.find((n) => /Map$/.test(n)) ?? names[0],
        allNames: names,
        instanceSizeInWords: b[offset + 4],
        instanceType: b.readUInt16LE(offset + 8),
      });
    }
    // The MetaMap itself is a Map whose map is itself -- already covered, but
    // assert it to catch a bad static-roots/blob pairing early.
    const mm = this.maps.get(this.metaMapAddr - kHeapObjectTag);
    if (!mm) throw new Error('MetaMap is not self-describing: blob/static-roots mismatch');
  }

  mapInfo(mapWord) { return this.maps.get(mapWord - kHeapObjectTag) ?? null; }

  /**
   * Sorted list of static-root offsets per page. Used only as a *fallback*
   * boundary source for variable-size shapes we have no formula for: the RO
   * heap's object starts for root objects are given exactly by the static
   * roots table, so `nextRootOffset - thisOffset` is a sound size for an object
   * that is itself a root and is immediately followed by another root. Every
   * object sized this way is tagged `sizeFrom: 'nextStaticRoot'` in the output
   * so it can be audited.
   */
  rootOffsets(chunk) {
    if (!this._rootOffsets) {
      this._rootOffsets = new Map();
      for (const [addr] of this.rootByAddr) {
        const { chunk: c, offset } = this.split(addr - kHeapObjectTag);
        if (!this._rootOffsets.has(c)) this._rootOffsets.set(c, []);
        this._rootOffsets.get(c).push(offset);
      }
      for (const list of this._rootOffsets.values()) list.sort((a, b) => a - b);
    }
    return this._rootOffsets.get(chunk) ?? [];
  }

  nextRootOffsetAfter(chunk, offset) {
    const list = this.rootOffsets(chunk);
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] <= offset) lo = mid + 1; else hi = mid; }
    return lo < list.length ? list[lo] : null;
  }

  /** Unaligned instance size for the object at (chunk, offset). */
  objectSize(chunk, offset) {
    const b = this.pageBytes(chunk);
    const mapWord = b.readUInt32LE(offset);
    const mi = this.mapInfo(mapWord);
    if (!mi) return { err: `unknown map word 0x${mapWord.toString(16)}` };
    if (mi.instanceSizeInWords !== 0) {
      return { size: mi.instanceSizeInWords * kTaggedSize, map: mi };
    }
    const shapeKey = MAP_NAME_TO_SHAPE.get(mi.name);
    if (!shapeKey) {
      const next = this.nextRootOffsetAfter(chunk, offset);
      if (next != null && next > offset && next - offset <= 4096) {
        return { size: next - offset, map: mi, shape: null, sizeFrom: 'nextStaticRoot' };
      }
      return { err: `no variable-size rule for map ${mi.name} (instance_type=${mi.instanceType})`, map: mi };
    }
    return { size: SHAPE[shapeKey](b, offset), map: mi, shape: shapeKey };
  }

  /** Decode a string object's characters, or null. */
  stringValue(chunk, offset, mapName) {
    const b = this.pageBytes(chunk);
    const len = b.readInt32LE(offset + 8);
    if (/OneByteStringMap$/.test(mapName) && /^(Seq|Internalized|SharedSeq)/.test(mapName)) {
      return b.subarray(offset + 12, offset + 12 + len).toString('latin1');
    }
    if (/TwoByteStringMap$/.test(mapName) && /^(Seq|Internalized|SharedSeq)/.test(mapName)) {
      return b.subarray(offset + 12, offset + 12 + 2 * len).toString('utf16le');
    }
    return null;
  }

  /**
   * Walk one page.
   *
   * The walk is driven by the kSegment records, not by a blind sweep of the
   * whole area: a segment is a contiguous run of serialized objects, and the
   * gaps between segments are never serialized (V8 turns them into free-space
   * objects in RepairFreeSpacesAfterDeserialization, which is why they contain
   * no bytes in the image).
   *
   * One object legitimately runs past the end of its segment: a Hole (and
   * WasmNull) is 4 + 64 KiB bytes but only its map word is serialized, because
   * the 64 KiB payload is a deliberately-unmapped guard region. Such an
   * overrun is accepted only if it lands exactly on the next segment start or
   * on the page end -- which is itself a check on the size model.
   */
  walkPage(chunk) {
    const p = this.pages.get(chunk);
    const areaEnd = kAreaStartOffset + p.areaSize;
    const segs = [...p.segments].sort((a, b) => a.offset - b.offset)
      .map((s) => ({ start: kAreaStartOffset + s.offset, end: kAreaStartOffset + s.offset + s.size }));
    const objects = [];
    const issues = [];
    let segIdx = 0;
    let off = segs.length ? segs[0].start : areaEnd;
    while (segIdx < segs.length) {
      const seg = segs[segIdx];
      if (off < seg.start) { off = seg.start; }
      const r = this.objectSize(chunk, off);
      if (r.err) {
        issues.push({ at: off, error: r.err, segment: segIdx });
        // skip to the next segment rather than abandoning the page
        segIdx++;
        off = segIdx < segs.length ? segs[segIdx].start : areaEnd;
        continue;
      }
      if (r.size <= 0) {
        issues.push({ at: off, error: `non-positive size ${r.size} for map ${r.map.name}`, segment: segIdx });
        segIdx++;
        off = segIdx < segs.length ? segs[segIdx].start : areaEnd;
        continue;
      }
      const size = align(r.size);
      objects.push({ offset: off, size, rawSize: r.size, map: r.map, shape: r.shape, sizeFrom: r.sizeFrom });
      off += size;
      while (segIdx < segs.length && off >= segs[segIdx].end) {
        const endOfSeg = segs[segIdx].end;
        if (off !== endOfSeg) {
          // overrun -- must land exactly on the next segment start or page end
          const landing = segIdx + 1 < segs.length ? segs[segIdx + 1].start : areaEnd;
          if (off !== landing) {
            issues.push({ at: off, error: `object overran segment ${segIdx} (ends ${endOfSeg}) and did not land on ${landing}` });
          }
        }
        segIdx++;
      }
      if (segIdx < segs.length && off < segs[segIdx].start) off = segs[segIdx].start;
    }
    const covered = objects.reduce((a, o) => a + o.size, 0);
    const segBytes = segs.reduce((a, s) => a + (s.end - s.start), 0);
    return { objects, issues, segBytes, covered, areaEnd, segments: segs };
  }

  walkAll() {
    const out = new Map();
    const report = [];
    for (const chunk of [...this.pages.keys()].sort((a, b2) => a - b2)) {
      const w = this.walkPage(chunk);
      report.push({
        chunk, count: w.objects.length, issues: w.issues,
        segBytes: w.segBytes, covered: w.covered, areaEnd: w.areaEnd,
      });
      for (const o of w.objects) out.set(`${chunk}:${o.offset}`, { chunk, ...o });
    }
    return { objects: out, report };
  }

  /** Build the serialisable ro-heap entry for one walked object. */
  describe(chunk, o) {
    const mapName = o.map.name;
    const kind = classify(mapName);
    const taggedAddr = (chunk << 18) + o.offset + kHeapObjectTag;
    const rootNames = this.rootByAddr.get(taggedAddr) ?? null;
    const e = { kind, mapName, size: o.size };
    if (rootNames) e.rootName = rootNames.length === 1 ? rootNames[0] : rootNames;
    if (kind === 'string') {
      const v = this.stringValue(chunk, o.offset, mapName);
      if (v !== null) e.value = v;
      e.length = this.pageBytes(chunk).readInt32LE(o.offset + 8);
    } else if (kind === 'symbol') {
      const b = this.pageBytes(chunk);
      e.symbolFlags = b.readUInt32LE(o.offset + 8);
      const desc = b.readUInt32LE(o.offset + 12);
      const d = this.split(desc - kHeapObjectTag);
      const dm = this.pageBytes(d.chunk) ? this.mapInfo(this.tagged(d.chunk, d.offset)) : null;
      if (dm && /StringMap$/.test(dm.name)) {
        const v = this.stringValue(d.chunk, d.offset, dm.name);
        if (v !== null) e.value = v;
      }
    } else if (kind === 'map') {
      const b = this.pageBytes(chunk);
      e.instanceType = b.readUInt16LE(o.offset + 8);
      e.instanceSizeInWords = b[o.offset + 4];
      e.describesMap = true;
    } else if (kind === 'heapNumber') {
      e.value = this.pageBytes(chunk).readDoubleLE(o.offset + 4);
    } else if (o.shape === 'fixedArray' || o.shape === 'fixedDoubleArray' || o.shape === 'byteArray') {
      e.length = smi(this.pageBytes(chunk), o.offset + 4);
    } else if (o.shape === 'arrayList') {
      e.capacity = smi(this.pageBytes(chunk), o.offset + 4);
      e.length = smi(this.pageBytes(chunk), o.offset + 8);
    }
    return e;
  }
}

export { classify, MAP_NAME_TO_SHAPE, SHAPE };
