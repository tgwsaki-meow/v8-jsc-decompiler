// src/cache/deserialize.mjs
//
// The snapshot deserializer bytecode loop, driven entirely by
// profiles/<tag>/serializer-tags.json + constants.json.
//
// Structure follows src/snapshot/deserializer.cc:
//   ReadObject(space)            size prefix, map, then ReadData(1, size)
//   ReadData(obj, start, end)    loop tags until the slot cursor reaches `end`
//   ReadSingleBytecodeData(tag)  one tag -> how many slots it filled
//
// What this produces is a *slot-level* object graph, not typed objects: each
// object records its map, its size in tagged slots, and one entry per tagged
// slot. src/heap/ turns that into typed views using layouts.json. Keeping the
// two apart is what lets the layout layer address fields by byte offset
// instead of by slot index.
//
// Hardcodes removed relative to src/deserializer.js, with their replacements:
//   kTaggedSize = 4                -> profile.taggedSize
//   sizeInTagged * 4               -> sizeInTagged * profile.taggedSize
//   literal tag values 0x00..0x21  -> profile.serializerTag(name)
//   ranged tag arithmetic          -> profile.decodeRangedTag(byte)
//   the 0x0c repeat base 18        -> kFixedRepeatRootCount + kFirstEncodableRepeatRootCount
//   `slotIndex >= 6 -> bytecodePayload` -> gone; src/heap addresses raw bytes
//                                      by the byte offset layouts.json states
//   32-byte header                 -> constants.codeCacheHeader.kHeaderSize
//
// Every tag the profile names is implemented or throws an UnimplementedTagError
// that names it. Nothing is skipped silently.

import { SnapshotByteSource, CacheFormatError, UnimplementedTagError } from './source.mjs';

/** A reference that does not resolve to a deserialized object. */
export const RefKind = {
  readOnlyHeap: 'ReadOnlyHeapRef',
  rootArray: 'RootArray',
  rootArrayConstant: 'RootArrayConstant',
  startupObjectCache: 'StartupObjectCache',
  sharedHeapObjectCache: 'SharedHeapObjectCache',
  attached: 'AttachedReference',
  externalReference: 'ExternalReference',
  apiReference: 'ApiReference',
  rawExternalReference: 'RawExternalReference',
  clearedWeak: 'ClearedWeakReference',
  pendingForwardRef: 'PendingForwardRef',
  selfIndirectPointer: 'SelfIndirectPointer',
  jsDispatchEntry: 'JSDispatchEntry',
  rawSlot: 'RawSlot',
  rawRun: 'RawRun',
};

/**
 * One deserialized heap object.
 *
 * `slots[i]` is the content of the tagged slot at byte offset
 * `(i + 1) * taggedSize`; slot 0 is the map word and is held separately. That
 * is the same indexing V8's ReadData uses (it starts at slot 1).
 */
class HeapObjectRecord {
  constructor(id, space, sizeInTagged, taggedSize) {
    this.id = id;
    this.space = space;
    this.sizeInTagged = sizeInTagged;
    this.sizeInBytes = sizeInTagged * taggedSize;
    this.map = null;
    /** @type {Array<any>} one entry per tagged slot from byte offset taggedSize */
    this.slots = [];
    /** byte offset -> Buffer, for every raw-data run the serializer emitted */
    this.rawRuns = [];
    this.weakSlots = null;
    this.protectedSlots = null;
    this.indirectSlots = null;
  }

  /** Byte offset of slot index `i` (0 = map word). */
  offsetOfSlot(i, taggedSize) { return i * taggedSize; }
}

export class Deserializer {
  /**
   * @param {Buffer} payload
   * @param {import('../profile/index.mjs').Profile} profile
   * @param {{maxObjects?: number}} opts
   */
  constructor(payload, profile, opts = {}) {
    this.profile = profile;
    this.taggedSize = profile.taggedSize;
    this.source = new SnapshotByteSource(payload, { uint32Size: profile.constants.sizes.kUInt32Size });

    const t = profile.tables.serializerTags;
    this.tags = t.tags;
    this.ranged = t.rangedTags;
    const c = t.constants;
    // kFirstEncodableVariableRepeatRootCount = kLastEncodableFixedRepeatRootCount + 1
    //                                        = kFirstEncodableRepeatRootCount + kFixedRepeatRootCount
    this.firstVariableRepeatCount = c.kFirstEncodableRepeatRootCount + c.kFixedRepeatRootCount;
    this.hotObjectCount = c.kHotObjectCount;
    this.systemPointerSize = profile.constants.sizes.kSystemPointerSize;

    // Reverse index: byte -> {name, kind}
    this.tagByByte = new Map();
    for (const [name, value] of Object.entries(this.tags)) {
      if (this.ranged[name]) continue;
      this.tagByByte.set(value, name);
    }
    // Dispatch table, built once. The profile's decodeRangedTag() walks
    // Object.entries(rangedTags) on every call, which is 5 array allocations
    // per serializer tag byte -- and a 10 MB cache holds millions of them.
    this.rangeByByte = new Array(1 << 8).fill(null);
    for (const [name, r] of Object.entries(this.ranged)) {
      for (let b = r.base; b <= r.end; b++) this.rangeByByte[b] = { tag: name, value: b - r.base + r.minValue };
    }

    this.backrefs = [];
    this.objects = [];
    this.hotObjects = new Array(this.hotObjectCount).fill(null);
    this.hotIndex = 0;
    this.pendingForwardRefs = [];
    this.jsDispatchEntries = [];
    this.backingStores = [];
    this.externalReferences = [];
    this.maxObjects = opts.maxObjects ?? Infinity;

    // prefix state, exactly as deserializer.cc keeps it
    this.nextIsWeak = false;
    this.nextIsIndirectPointer = false;
    this.nextIsProtectedPointer = false;

    this.stats = {
      tagCounts: Object.create(null),
      roRefs: 0,
      rootRefs: 0,
      unresolvedRefs: 0,
    };
  }

  // ----------------------------------------------------------------- helpers

  countTag(name) {
    this.stats.tagCounts[name] = (this.stats.tagCounts[name] ?? 0) + 1;
  }

  addHot(obj) {
    this.hotObjects[this.hotIndex] = obj;
    this.hotIndex = (this.hotIndex + 1) % this.hotObjectCount;
  }

  /** Consume and clear the prefix flags, V8's GetAndResetNextReferenceDescriptor. */
  takeDescriptor() {
    const d = {
      weak: this.nextIsWeak,
      indirect: this.nextIsIndirectPointer,
      protected: this.nextIsProtectedPointer,
    };
    this.nextIsWeak = false;
    this.nextIsIndirectPointer = false;
    this.nextIsProtectedPointer = false;
    return d;
  }

  write(host, slotIndex, value, descriptor) {
    if (!host) return;
    const arrayIndex = slotIndex - 1;
    host.slots[arrayIndex] = value;
    if (descriptor) {
      if (descriptor.weak) (host.weakSlots ??= new Set()).add(slotIndex);
      if (descriptor.protected) (host.protectedSlots ??= new Set()).add(slotIndex);
      if (descriptor.indirect) (host.indirectSlots ??= new Set()).add(slotIndex);
    }
  }

  // ------------------------------------------------------------- the entry

  /** Read one object by executing a single tag that must fill exactly one slot. */
  readObject() {
    const tag = this.source.get();
    const result = { value: undefined };
    const filled = this.readSingleBytecodeData(tag, null, 0, result);
    if (filled !== 1) {
      throw new CacheFormatError(
        `expected a single-slot tag where an object reference was required, but ${this.nameOf(tag)} filled ${filled} slots`);
    }
    return result.value;
  }

  nameOf(tagByte) {
    const direct = this.tagByByte.get(tagByte);
    if (direct) return direct;
    const r = this.rangeByByte[tagByte];
    if (r) return `${r.tag}[${r.value}]`;
    return `0x${tagByte.toString(16).padStart(2, '0')}`;
  }

  readObjectInSpace(space) {
    const sizeInTagged = this.source.getUint30();
    if (sizeInTagged < 1) {
      throw new CacheFormatError(`object size ${sizeInTagged} tagged slots is below the one-slot map word`);
    }
    // deserializer.cc reads the map *before* registering the back reference.
    const map = this.readObject();
    const obj = new HeapObjectRecord(this.backrefs.length, space, sizeInTagged, this.taggedSize);
    obj.map = map;
    this.backrefs.push(obj);
    if (this.objects.length >= this.maxObjects) {
      throw new CacheFormatError(`object budget of ${this.maxObjects} exceeded; the payload is probably not a code cache`);
    }
    this.objects.push(obj);
    this.readData(obj, 1, sizeInTagged);
    return obj;
  }

  readMetaMap(space) {
    // ReadMetaMap has no size prefix: the size is Map::kSize.
    const mapSize = this.profile.tables.layouts.classes.Map?.size
      ?? this.profile.tables.layouts.sizes?.Map;
    if (mapSize == null) {
      throw new CacheFormatError('kNewContextlessMetaMap/kNewContextfulMetaMap need Map::kSize, which layouts.json does not state');
    }
    if (mapSize % this.taggedSize !== 0) {
      throw new CacheFormatError(
        `Map::kSize is ${mapSize}, not a multiple of kTaggedSize ${this.taggedSize}; cannot derive its slot count`);
    }
    const sizeInTagged = mapSize / this.taggedSize;
    const obj = new HeapObjectRecord(this.backrefs.length, space, sizeInTagged, this.taggedSize);
    obj.map = obj; // a meta map is its own map
    obj.isMetaMap = true;
    this.backrefs.push(obj);
    this.objects.push(obj);
    this.readData(obj, 1, sizeInTagged);
    return obj;
  }

  readData(obj, startSlot, endSlot) {
    let current = startSlot;
    while (current < endSlot) {
      const tag = this.source.get();
      const before = current;
      current += this.readSingleBytecodeData(tag, obj, current, null);
      if (current < before) {
        throw new CacheFormatError(`tag ${this.nameOf(tag)} moved the slot cursor backwards in object ${obj.id}`);
      }
    }
    if (current !== endSlot) {
      throw new CacheFormatError(
        `object ${obj.id} (${obj.sizeInTagged} tagged slots) overran its body: cursor stopped at ${current}, expected ${endSlot}`);
    }
  }

  readRepeatedRoot(host, slotIndex, repeatCount) {
    const rootId = this.source.get();
    const root = this.profile.getRoot(rootId);
    const ref = { k: RefKind.rootArray, rootIndex: rootId, root, repeated: repeatCount };
    this.stats.rootRefs += repeatCount;
    for (let i = 0; i < repeatCount; i++) this.write(host, slotIndex + i, ref, null);
    return repeatCount;
  }

  /**
   * Read raw bytes covering `sizeInTagged` slots and attach them to the host.
   *
   * The run object is shared by every slot it covers rather than materialising a
   * `{k, offset, raw}` record and a Buffer subarray per slot. A BytecodeArray
   * with 600 bytes of bytecode covers 150 slots, and the corpus deserialises
   * 2.5 million objects; the per-slot form spent most of its time in the
   * garbage collector. `HeapView.slot()` synthesises the per-slot view on the
   * rare occasions a caller wants one.
   */
  attachRaw(host, slotIndex, sizeInTagged, tagName) {
    const byteLength = sizeInTagged * this.taggedSize;
    const raw = this.source.takeRaw(byteLength);
    if (host) {
      const startOffset = slotIndex * this.taggedSize;
      host.rawRuns.push({ k: RefKind.rawRun, offset: startOffset, length: byteLength, data: raw, via: tagName });
      // The slots this run covers are left unset: HeapView.slot() falls back to
      // the run list, which is a handful of entries, while filling them here
      // would be one write per tagged slot of every string and every bytecode
      // array in the cache.
    }
    return sizeInTagged;
  }

  // ------------------------------------------------------------ the dispatch

  /**
   * Execute one serializer tag.
   * @returns {number} how many tagged slots it filled
   */
  readSingleBytecodeData(tagByte, host, slotIndex, out) {
    const T = this.tags;
    const put = (value, descriptor) => {
      if (out) out.value = value;
      this.write(host, slotIndex, value, descriptor);
    };

    // ---- ranged tags first: kNewObject shares 0x00..0x03 with nothing else.
    const r = this.rangeByByte[tagByte];
    if (r) {
      this.countTag(r.tag);
      switch (r.tag) {
        case 'kNewObject': {
          const descr = this.takeDescriptor();
          const obj = this.readObjectInSpace(r.value);
          put(obj, descr);
          return 1;
        }
        case 'kRootArrayConstants': {
          const root = this.profile.getRoot(r.value);
          this.stats.rootRefs++;
          put({ k: RefKind.rootArrayConstant, rootIndex: r.value, root }, null);
          return 1;
        }
        case 'kFixedRawData':
          return this.attachRaw(host, slotIndex, r.value, 'kFixedRawData');
        case 'kFixedRepeatRoot':
          return this.readRepeatedRoot(host, slotIndex, r.value);
        case 'kHotObject': {
          const obj = this.hotObjects[r.value];
          if (!obj) {
            throw new CacheFormatError(`kHotObject[${r.value}] read before any object occupied that hot slot`);
          }
          put(obj, this.takeDescriptor());
          return 1;
        }
        default:
          throw new UnimplementedTagError(r.tag, tagByte, 'ranged tag present in the profile but not handled by this reader');
      }
    }

    const name = this.tagByByte.get(tagByte);
    if (name === undefined) {
      throw new CacheFormatError(
        `byte 0x${tagByte.toString(16).padStart(2, '0')} at payload offset ${this.source.pos - 1} is not a serializer tag `
        + `in profile ${this.profile.version} (it falls in V8's UNUSED_SERIALIZER_BYTE_CODES range)`);
    }
    this.countTag(name);

    switch (tagByte) {
      case T.kBackref: {
        const index = this.source.getUint30();
        if (index >= this.backrefs.length) {
          throw new CacheFormatError(`kBackref ${index} but only ${this.backrefs.length} objects have been allocated`);
        }
        const obj = this.backrefs[index];
        this.addHot(obj);
        put(obj, this.takeDescriptor());
        return 1;
      }

      case T.kReadOnlyHeapRef: {
        const chunkIndex = this.source.getUint30();
        const chunkOffset = this.source.getUint30();
        this.stats.roRefs++;
        put({ k: RefKind.readOnlyHeap, chunkIndex, chunkOffset }, this.takeDescriptor());
        return 1;
      }

      case T.kRootArray: {
        const id = this.source.getUint30();
        const root = this.profile.getRoot(id);
        const ref = { k: RefKind.rootArray, rootIndex: id, root };
        this.stats.rootRefs++;
        this.addHot(ref);
        put(ref, this.takeDescriptor());
        return 1;
      }

      case T.kStartupObjectCache: {
        const index = this.source.getUint30();
        put({ k: RefKind.startupObjectCache, index }, this.takeDescriptor());
        return 1;
      }

      case T.kSharedHeapObjectCache: {
        const index = this.source.getUint30();
        put({ k: RefKind.sharedHeapObjectCache, index }, this.takeDescriptor());
        return 1;
      }

      case T.kAttachedReference: {
        const index = this.source.getUint30();
        put({ k: RefKind.attached, index }, this.takeDescriptor());
        return 1;
      }

      case T.kNop:
        return 0;

      case T.kSynchronize:
        // deserializer.cc marks this UNREACHABLE inside ReadSingleBytecodeData:
        // kSynchronize only terminates the deferred-object loop.
        throw new CacheFormatError(
          `kSynchronize appeared inside an object body at payload offset ${this.source.pos - 1}; `
          + 'in V8 this is UNREACHABLE and means the payload and the profile disagree');

      case T.kVariableRepeatRoot: {
        const repeats = this.source.getUint30() + this.firstVariableRepeatCount;
        return this.readRepeatedRoot(host, slotIndex, repeats);
      }

      case T.kVariableRawData: {
        const sizeInTagged = this.source.getUint30();
        return this.attachRaw(host, slotIndex, sizeInTagged, 'kVariableRawData');
      }

      case T.kOffHeapBackingStore:
      case T.kOffHeapResizableBackingStore: {
        const byteLength = this.source.getUint32();
        let maxByteLength = null;
        if (tagByte === T.kOffHeapResizableBackingStore) maxByteLength = this.source.getUint32();
        const data = this.source.takeRaw(byteLength);
        this.backingStores.push({ byteLength, maxByteLength, data });
        return 0; // fills no slot; V8 records it in backing_stores_
      }

      case T.kExternalReference:
      case T.kSandboxedExternalReference: {
        const referenceId = this.source.getUint30();
        const tag = tagByte === T.kSandboxedExternalReference ? this.source.getUint30() : null;
        const ref = { k: RefKind.externalReference, referenceId, pointerTag: tag, sandboxed: tag !== null };
        this.externalReferences.push(ref);
        put(ref, null);
        return this.externalPointerSlots();
      }

      case T.kSandboxedRawExternalReference: {
        const address = this.source.takeRaw(this.systemPointerSize);
        const tag = this.source.getUint30();
        const ref = {
          k: RefKind.rawExternalReference,
          address: Buffer.from(address).toString('hex'),
          pointerTag: tag,
        };
        this.externalReferences.push(ref);
        put(ref, null);
        return this.externalPointerSlots();
      }

      case T.kApiReference:
      case T.kSandboxedApiReference: {
        const referenceId = this.source.getUint30();
        const tag = tagByte === T.kSandboxedApiReference ? this.source.getUint30() : null;
        const ref = { k: RefKind.apiReference, referenceId, pointerTag: tag, sandboxed: tag !== null };
        this.externalReferences.push(ref);
        put(ref, null);
        return this.externalPointerSlots();
      }

      case T.kClearedWeakReference:
        put({ k: RefKind.clearedWeak }, null);
        return 1;

      case T.kWeakPrefix:
        if (this.nextIsWeak) throw new CacheFormatError('two kWeakPrefix tags in a row');
        this.nextIsWeak = true;
        return 0;

      case T.kIndirectPointerPrefix:
        if (this.nextIsIndirectPointer) throw new CacheFormatError('two kIndirectPointerPrefix tags in a row');
        this.nextIsIndirectPointer = true;
        return 0;

      case T.kProtectedPointerPrefix:
        if (this.nextIsProtectedPointer) throw new CacheFormatError('two kProtectedPointerPrefix tags in a row');
        this.nextIsProtectedPointer = true;
        return 0;

      case T.kRegisterPendingForwardRef: {
        const ref = {
          k: RefKind.pendingForwardRef,
          index: this.pendingForwardRefs.length,
          host,
          slotIndex,
          descriptor: this.takeDescriptor(),
          target: null,
        };
        this.pendingForwardRefs.push(ref);
        put(ref, ref.descriptor);
        return 1;
      }

      case T.kResolvePendingForwardRef: {
        const index = this.source.getUint30();
        const ref = this.pendingForwardRefs[index];
        if (!ref) throw new CacheFormatError(`kResolvePendingForwardRef ${index} has no matching registration`);
        ref.target = host;
        if (ref.host) this.write(ref.host, ref.slotIndex, host, ref.descriptor);
        return 0;
      }

      case T.kNewContextlessMetaMap:
      case T.kNewContextfulMetaMap: {
        const spaces = this.profile.tables.serializerTags.rangedTags.kNewObject;
        if (!spaces) throw new CacheFormatError('profile has no kNewObject space range');
        // deserializer.cc: contextless -> read-only space, contextful -> old space.
        const space = tagByte === T.kNewContextlessMetaMap ? 'kReadOnlyHeap' : 'kOld';
        const obj = this.readMetaMap(space);
        put(obj, null);
        return 1;
      }

      case T.kInitializeSelfIndirectPointer:
        put({ k: RefKind.selfIndirectPointer }, null);
        return 1;

      case T.kAllocateJSDispatchEntry: {
        const parameterCount = this.source.getUint30();
        const code = this.readObject();
        const entry = { k: RefKind.jsDispatchEntry, id: this.jsDispatchEntries.length, parameterCount, code };
        this.jsDispatchEntries.push(entry);
        put(entry, null);
        return 1;
      }

      case T.kJSDispatchEntry: {
        const id = this.source.getUint30();
        const entry = this.jsDispatchEntries[id];
        if (!entry) throw new CacheFormatError(`kJSDispatchEntry ${id} has no matching kAllocateJSDispatchEntry`);
        put(entry, null);
        return 1;
      }

      case T.kEmbedderFieldsData:
      case T.kApiWrapperFieldsData:
        // Present in the Bytecode enum but absent from
        // Deserializer::ReadSingleBytecodeData's switch: only the context
        // deserializer consumes them, never a code cache. Their payload shape
        // is an embedder callback's output, so there is nothing to decode.
        throw new UnimplementedTagError(name, tagByte,
          'only the context deserializer consumes it (it is not in ReadSingleBytecodeData); '
          + 'its payload is embedder-defined, so a code cache containing it cannot be decoded here');

      default:
        throw new UnimplementedTagError(name, tagByte, 'named by the profile but not handled by this reader');
    }
  }

  /**
   * An external-pointer write advances the slot cursor by the number of tagged
   * slots an external pointer slot occupies.
   */
  externalPointerSlots() {
    const sz = this.profile.constants.sizes.kExternalPointerSlotSize;
    const n = sz / this.taggedSize;
    if (!Number.isInteger(n) || n < 1) {
      throw new CacheFormatError(
        `kExternalPointerSlotSize ${sz} is not a whole number of ${this.taggedSize}-byte slots`);
    }
    return n;
  }

  deserializeDeferredObjects() {
    const sync = this.tags.kSynchronize;
    for (;;) {
      if (!this.source.hasMore()) {
        throw new CacheFormatError('payload ended without the kSynchronize that closes the deferred-object section');
      }
      const code = this.source.get();
      if (code === sync) { this.countTag('kSynchronize'); return; }
      const r = this.rangeByByte[code];
      if (!r || r.tag !== 'kNewObject') {
        throw new CacheFormatError(
          `the deferred-object section expects kNewObject or kSynchronize, got ${this.nameOf(code)} `
          + `at payload offset ${this.source.pos - 1}`);
      }
      this.countTag('kNewObject');
      this.readObjectInSpace(r.value);
    }
  }

  /** Run the whole payload. */
  run() {
    const root = this.readObject();
    this.deserializeDeferredObjects();
    const unresolvedForwardRefs = this.pendingForwardRefs.filter((p) => p.target === null);
    // Serializer::Pad writes kUInt32Size-1 kNop bytes plus however many more it
    // takes to reach pointer alignment, so everything after kSynchronize must
    // be kNop. Anything else means the cursor finished in the wrong place.
    const tail = this.source.buffer.subarray(this.source.pos);
    const trailingAllNop = tail.every((b) => b === this.tags.kNop);
    const maxPad = this.profile.constants.sizes.kUInt32Size - 1
      + this.profile.constants.globals.kPointerAlignment - 1;
    return {
      root,
      objects: this.objects,
      backrefCount: this.backrefs.length,
      trailingBytes: this.source.remaining,
      trailingAllNop,
      trailingWithinPadBudget: this.source.remaining <= maxPad,
      unresolvedForwardRefs: unresolvedForwardRefs.length,
      backingStores: this.backingStores.length,
      jsDispatchEntries: this.jsDispatchEntries.length,
      externalReferences: this.externalReferences.length,
      stats: this.stats,
    };
  }
}

export function deserializePayload(payload, profile, opts = {}) {
  const d = new Deserializer(payload, profile, opts);
  const result = d.run();
  result.deserializer = d;
  return result;
}

export default { Deserializer, deserializePayload, RefKind };
