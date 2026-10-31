import fs from 'fs';
import path from 'path';

class SnapshotByteSource {
  constructor(buffer) {
    this.buffer = buffer;
    this.pos = 0;
  }
  hasMore() { return this.pos < this.buffer.length; }
  get() {
    if (this.pos >= this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF at pos ${this.pos}`);
    }
    return this.buffer[this.pos++];
  }
  peek() { return this.buffer[this.pos]; }
  advance(n) { this.pos += n; }
  getUint30() {
    const b0 = this.buffer[this.pos];
    const b1 = this.buffer[this.pos + 1];
    const b2 = this.buffer[this.pos + 2];
    const b3 = this.buffer[this.pos + 3];
    const answer = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    const bytes = (answer & 3) + 1;
    this.advance(bytes);
    const mask = (0xffffffff >>> (32 - (bytes * 8))) >>> 0;
    return ((answer & mask) >>> 2);
  }
}

class StrictV8Deserializer {
  constructor(payload) {
    this.source = new SnapshotByteSource(payload);
    this.backrefs = [];
    this.hotObjects = [];
    this.hotIndex = 0;
    this.objects = [];
    this.pendingForwardRefs = [];
    this.attachedObjects = [null]; // 0th is empty_string
    this.jsDispatchEntries = [];
  }

  addHot(obj) {
    this.hotObjects[this.hotIndex] = obj;
    this.hotIndex = (this.hotIndex + 1) & 7;
  }

  readObject(space) {
    if (space !== undefined) {
      const sizeInTagged = this.source.getUint30();
      const obj = {
        id: this.backrefs.length,
        space,
        sizeInTagged,
        slots: [],
        map: null,
        rawPayload: null
      };
      this.backrefs.push(obj);
      this.objects.push(obj);

      // Read map
      obj.map = this.readObject();

      // Read remainder of fields
      this.readData(obj, 1, sizeInTagged);
      this.addHot(obj);
      return obj;
    }

    let result = null;
    while (result === null) {
      const tag = this.source.get();
      const [val, slots] = this.readSingleBytecodeData(tag, null);
      if (slots === 1) {
        result = val;
      }
    }
    return result;
  }

  deserializeDeferredObjects() {
    while (this.source.hasMore()) {
      const code = this.source.get();
      if (code === 0x0b) { // kSynchronize
        break;
      }
      const space = code & 3;
      this.readObject(space);
    }
  }

  readData(obj, startSlot, endSlot) {
    let current = startSlot;
    while (current < endSlot) {
      const tag = this.source.get();
      const [val, slots] = this.readSingleBytecodeData(tag, obj, current);
      current += slots;
    }
    if (current !== endSlot) {
      throw new Error(`[StrictDeserializer] Slot count mismatch: current=${current}, expected=${endSlot} in object ${obj.id}`);
    }
  }

  readSingleBytecodeData(tag, hostObj, slotIndex) {
    // 0x00 .. 0x03: kNewObject
    if (tag <= 0x03) {
      const space = tag & 3;
      const sizeInTagged = this.source.getUint30();
      const obj = {
        id: this.backrefs.length,
        space,
        sizeInTagged,
        slots: [],
        map: null,
        rawPayload: null
      };
      this.backrefs.push(obj);
      this.objects.push(obj);

      // Read map
      obj.map = this.readObject();

      // Read remainder of fields
      this.readData(obj, 1, sizeInTagged);
      this.addHot(obj);

      if (hostObj) hostObj.slots.push(obj);
      return [obj, 1];
    }

    // 0x04: kBackref
    if (tag === 0x04) {
      const index = this.source.getUint30();
      if (index >= this.backrefs.length) {
        throw new Error(`[StrictDeserializer] Invalid backref index ${index} >= ${this.backrefs.length}`);
      }
      const obj = this.backrefs[index];
      if (hostObj) hostObj.slots.push(obj);
      return [obj, 1];
    }

    // 0x05: kReadOnlyHeapRef
    if (tag === 0x05) {
      const chunkIndex = this.source.getUint30();
      const chunkOffset = this.source.getUint30();
      const ref = { type: 'ReadOnlyHeapRef', chunkIndex, chunkOffset };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x06: kStartupObjectCache
    if (tag === 0x06) {
      const idx = this.source.getUint30();
      const ref = { type: 'StartupObjectCache', idx };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x07: kRootArray
    if (tag === 0x07) {
      const id = this.source.getUint30();
      const ref = { type: 'RootArray', id };
      this.addHot(ref);
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x08: kAttachedReference
    if (tag === 0x08) {
      const index = this.source.getUint30();
      const ref = { type: 'AttachedReference', index };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x09: kSharedHeapObjectCache
    if (tag === 0x09) {
      const idx = this.source.getUint30();
      const ref = { type: 'SharedHeapObjectCache', idx };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x0a: kNop
    if (tag === 0x0a) {
      return [null, 0];
    }

    // 0x0b: kSynchronize
    if (tag === 0x0b) {
      throw new Error(`[StrictDeserializer] kSynchronize encountered at pos ${this.source.pos - 1}`);
    }

    // 0x0c: kVariableRepeatRoot
    if (tag === 0x0c) {
      const val = this.source.getUint30();
      const repeats = val + 18; // kFirstEncodableVariableRepeatRootCount = 18
      const rootId = this.source.get();
      const rootRef = { type: 'RepeatedRoot', rootId, count: repeats };
      if (hostObj) {
        for (let i = 0; i < repeats; i++) {
          hostObj.slots.push(rootRef);
        }
      }
      return [rootRef, repeats];
    }

    // 0x0d: kOffHeapBackingStore
    if (tag === 0x0d) {
      const byteLength = this.source.buffer.readUInt32LE(this.source.pos);
      this.source.advance(4);
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      return [{ type: 'OffHeapBackingStore', raw }, 0];
    }

    // 0x0e: kOffHeapResizableBackingStore
    if (tag === 0x0e) {
      const byteLength = this.source.buffer.readUInt32LE(this.source.pos);
      this.source.advance(4);
      const maxByteLength = this.source.buffer.readUInt32LE(this.source.pos);
      this.source.advance(4);
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      return [{ type: 'OffHeapResizableBackingStore', raw }, 0];
    }

    // 0x11: kVariableRawData
    if (tag === 0x11) {
      const sizeInTagged = this.source.getUint30();
      const byteLength = sizeInTagged * 4; // kTaggedSize = 4
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      const data = { type: 'VariableRawData', raw, sizeInTagged };
      if (hostObj) {
        hostObj.slots.push(data);
        hostObj.rawPayload = raw;
      }
      return [data, sizeInTagged];
    }

    // 0x17: kClearedWeakReference
    if (tag === 0x17) {
      const ref = { type: 'ClearedWeakReference' };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x18: kWeakPrefix
    if (tag === 0x18) {
      return [null, 0];
    }

    // 0x19: kRegisterPendingForwardRef
    if (tag === 0x19) {
      const ref = { type: 'PendingForwardRef', hostObj, slotIndex };
      this.pendingForwardRefs.push(ref);
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x1a: kResolvePendingForwardRef
    if (tag === 0x1a) {
      const index = this.source.getUint30();
      const forwardRef = this.pendingForwardRefs[index];
      if (forwardRef) {
        forwardRef.target = hostObj;
      }
      return [null, 0];
    }

    // 0x1d: kIndirectPointerPrefix
    if (tag === 0x1d) {
      return [null, 0];
    }

    // 0x1e: kInitializeSelfIndirectPointer
    if (tag === 0x1e) {
      const ref = { type: 'SelfIndirectPointer' };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x1f: kAllocateJSDispatchEntry
    if (tag === 0x1f) {
      const parameterCount = this.source.getUint30();
      const code = this.readObject();
      const entry = { type: 'JSDispatchEntry', parameterCount, code };
      this.jsDispatchEntries.push(entry);
      if (hostObj) hostObj.slots.push(entry);
      return [entry, 1];
    }

    // 0x20: kJSDispatchEntry
    if (tag === 0x20) {
      const entryId = this.source.getUint30();
      const entry = this.jsDispatchEntries[entryId] || { type: 'JSDispatchEntryRef', entryId };
      if (hostObj) hostObj.slots.push(entry);
      return [entry, 1];
    }

    // 0x21: kProtectedPointerPrefix
    if (tag === 0x21) {
      return [null, 0];
    }

    // 0x40 .. 0x5f: kRootArrayConstants
    if (tag >= 0x40 && tag <= 0x5f) {
      const rootIndex = tag - 0x40;
      const ref = { type: 'RootArrayConstant', rootIndex };
      if (hostObj) hostObj.slots.push(ref);
      return [ref, 1];
    }

    // 0x60 .. 0x7f: kFixedRawData
    if (tag >= 0x60 && tag <= 0x7f) {
      const sizeInTagged = (tag - 0x60) + 1;
      const byteLength = sizeInTagged * 4; // kTaggedSize = 4
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      const data = { type: 'FixedRawData', raw, sizeInTagged };
      if (hostObj) {
        hostObj.slots.push(data);
        if (!hostObj.rawPayload) hostObj.rawPayload = raw;
      }
      return [data, sizeInTagged];
    }

    // 0x80 .. 0x8f: kFixedRepeatRoot
    if (tag >= 0x80 && tag <= 0x8f) {
      const repeats = (tag - 0x80) + 2;
      const rootId = this.source.get();
      const rootRef = { type: 'RepeatedRoot', rootId, count: repeats };
      if (hostObj) {
        for (let i = 0; i < repeats; i++) {
          hostObj.slots.push(rootRef);
        }
      }
      return [rootRef, repeats];
    }

    // 0x90 .. 0x97: kHotObject
    if (tag >= 0x90 && tag <= 0x97) {
      const idx = tag - 0x90;
      const obj = this.hotObjects[idx];
      if (!obj) {
        throw new Error(`[StrictDeserializer] Uninitialized hot object index ${idx}`);
      }
      if (hostObj) hostObj.slots.push(obj);
      return [obj, 1];
    }

    throw new Error(`[StrictDeserializer] Unexpected bytecode tag 0x${tag.toString(16)} at pos ${this.source.pos - 1}`);
  }

  deserialize() {
    const root = this.readObject();
    this.deserializeDeferredObjects();
    return {
      root,
      totalObjects: this.objects.length,
      objects: this.objects,
      backrefs: this.backrefs.length,
      remainingBytes: this.source.buffer.length - this.source.pos
    };
  }
}

const targetFile = process.argv[2] || 'extracted_jsc/internal_launcher.jsc';
console.log('Testing strict deserialization on:', targetFile);
const buf = fs.readFileSync(targetFile);
const payload = buf.subarray(32);
const deserializer = new StrictV8Deserializer(payload);

try {
  const res = deserializer.deserialize();
  console.log('Strict deserialization successful!');
  console.log('Total heap objects reconstructed:', res.totalObjects);
  console.log('Root object sizeInTagged:', res.root.sizeInTagged);
  console.log('Remaining bytes:', res.remainingBytes, payload.subarray(deserializer.source.pos));

  // Find BytecodeArray objects
  const bytecodes = res.objects.filter(o => o.space === 3 && o.slots.some(s => s && s.type === 'SelfIndirectPointer'));
  console.log('Total BytecodeArrays found:', bytecodes.length);

function decodeConstant(item) {
  if (!item) return null;
  if (item.type === 'RootArrayConstant') {
    if (item.rootIndex === 0) return undefined;
    if (item.rootIndex === 1) return null;
    if (item.rootIndex === 2) return '__the_hole__';
    if (item.rootIndex === 3) return true;
    if (item.rootIndex === 4) return false;
    if (item.rootIndex === 5) return '';
    return `<Root#${item.rootIndex}>`;
  }
  if (item.type === 'RootArray') {
    return `<RootArray#${item.id}>`;
  }
  if (item.type === 'FixedRawData' || item.type === 'VariableRawData') {
    const raw = item.raw;
    if (raw && raw.length >= 8) {
      const len = raw.readInt32LE(4);
      if (len >= 0 && len <= raw.length - 8) {
        return raw.subarray(8, 8 + len).toString('utf8');
      }
    }
    return raw;
  }
  if (item.rawPayload) {
    const raw = item.rawPayload;
    if (raw.length >= 8) {
      const len = raw.readInt32LE(4);
      if (len >= 0 && len <= raw.length - 8) {
        return raw.subarray(8, 8 + len).toString('utf8');
      }
    }
    if (item.sizeInTagged === 3 && raw.length >= 8) {
      return raw.readDoubleLE(0);
    }
  }
  if (item.slots) {
    return `<Object#${item.id} space=${item.space} slots=${item.slots.length}>`;
  }
  return item;
}

  // Inspect decoded constants of BytecodeArray #1
  console.log('\n--- Decoded Constants of BytecodeArray #1 ---');
  const b1 = bytecodes[1];
  const cp1 = b1.slots[5];
  if (cp1 && cp1.slots) {
    for (let k = 0; k < cp1.slots.length; k++) {
      const dec = decodeConstant(cp1.slots[k]);
      console.log(`  [${k}]:`, typeof dec === 'string' ? JSON.stringify(dec) : dec);
    }
  }
} catch (err) {
  console.error('Deserialization halted on strict error:', err.message);
  console.log('Pos at error:', deserializer.source.pos, '/', payload.length);
}
