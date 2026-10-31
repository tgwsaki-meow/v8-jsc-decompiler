import fs from 'fs';
import { V8Profile } from './profile.js';

export class SnapshotByteSource {
  constructor(buffer) {
    this.buffer = buffer;
    this.pos = 0;
  }

  hasMore() {
    return this.pos < this.buffer.length;
  }

  get() {
    if (this.pos >= this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF at pos ${this.pos} (length=${this.buffer.length})`);
    }
    return this.buffer[this.pos++];
  }

  peek() {
    if (this.pos >= this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF at peek pos ${this.pos}`);
    }
    return this.buffer[this.pos];
  }

  advance(n) {
    if (this.pos + n > this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF advancing ${n} bytes from pos ${this.pos}`);
    }
    this.pos += n;
  }

  getUint30() {
    if (this.pos >= this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF reading Uint30 at pos ${this.pos}`);
    }
    const b0 = this.buffer[this.pos];
    const b1 = this.pos + 1 < this.buffer.length ? this.buffer[this.pos + 1] : 0;
    const b2 = this.pos + 2 < this.buffer.length ? this.buffer[this.pos + 2] : 0;
    const b3 = this.pos + 3 < this.buffer.length ? this.buffer[this.pos + 3] : 0;
    const answer = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    const bytes = (answer & 3) + 1;
    this.advance(bytes);
    const mask = (0xffffffff >>> (32 - (bytes * 8))) >>> 0;
    return ((answer & mask) >>> 2);
  }

  getUint32() {
    if (this.pos + 4 > this.buffer.length) {
      throw new Error(`[SnapshotByteSource] Unexpected EOF reading Uint32 at pos ${this.pos}`);
    }
    const val = this.buffer.readUInt32LE(this.pos);
    this.advance(4);
    return val;
  }
}

export class StrictV8Deserializer {
  constructor(payload, profile = new V8Profile()) {
    this.source = new SnapshotByteSource(payload);
    this.profile = profile;
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
      // V8 deserializer.cc lines 771-875: Map is read BEFORE allocating and registering backref
      const map = this.readObject();
      const obj = {
        id: this.backrefs.length,
        space,
        sizeInTagged,
        slots: [],
        map,
        rawPayload: null
      };
      this.backrefs.push(obj);
      this.objects.push(obj);

      // Read remainder of fields
      this.readData(obj, 1, sizeInTagged);
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
      const obj = this.readObject(space);
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
      this.addHot(obj); // Per V8 deserializer.cc line 741 GetBackReferencedObject
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
      return [null, 0];
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
      const byteLength = this.source.getUint32();
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      return [{ type: 'OffHeapBackingStore', raw }, 0];
    }

    // 0x0e: kOffHeapResizableBackingStore
    if (tag === 0x0e) {
      const byteLength = this.source.getUint32();
      const maxByteLength = this.source.getUint32();
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      return [{ type: 'OffHeapResizableBackingStore', raw, maxByteLength }, 0];
    }

    // 0x11: kVariableRawData
    if (tag === 0x11) {
      const sizeInTagged = this.source.getUint30();
      const byteLength = sizeInTagged * 4; // kTaggedSize = 4
      const raw = this.source.buffer.subarray(this.source.pos, this.source.pos + byteLength);
      this.source.advance(byteLength);
      const data = { type: 'VariableRawData', raw, sizeInTagged };
      if (hostObj) {
        for (let s = 0; s < sizeInTagged; s++) {
          const slotSlice = raw.subarray(s * 4, (s + 1) * 4);
          hostObj.slots.push({ type: 'RawSlot', raw: slotSlice });
        }
        if (slotIndex >= 6) {
          hostObj.bytecodePayload = raw;
        }
        if (!hostObj.rawPayload) hostObj.rawPayload = raw;
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
      const arrayIndex = hostObj ? hostObj.slots.length : 0;
      const ref = { type: 'PendingForwardRef', hostObj, slotIndex, arrayIndex };
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
        if (forwardRef.hostObj && forwardRef.hostObj.slots) {
          forwardRef.hostObj.slots[forwardRef.arrayIndex] = hostObj;
        }
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
        for (let s = 0; s < sizeInTagged; s++) {
          const slotSlice = raw.subarray(s * 4, (s + 1) * 4);
          hostObj.slots.push({ type: 'RawSlot', raw: slotSlice });
        }
        if (slotIndex >= 6) {
          hostObj.bytecodePayload = raw;
        }
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

  decodeConstant(item) {
    if (item === null || item === undefined) return item;

    if (item.type === 'RootArrayConstant' || item.type === 'RootArray') {
      const rootIdx = item.type === 'RootArrayConstant' ? item.rootIndex : item.id;
      const rootEntry = this.profile?.getRoot(rootIdx);
      if (rootEntry) {
        return rootEntry.value;
      }
      return item;
    }

    if (item.type === 'ReadOnlyHeapRef') {
      return item;
    }

    if (item.type === 'RawSlot' && item.raw && item.raw.length === 4) {
      return item.raw.readInt32LE(0) >> 1;
    }

    // Check if item is a SharedFunctionInfo (slots[0] points to BytecodeArray)
    if (item.slots && item.slots[0] && item.slots[0].space === 3 && item.slots[0].slots && item.slots[0].slots.some(s => s?.type === 'SelfIndirectPointer')) {
      return {
        type: 'FunctionRef',
        sfiId: item.id,
        bytecodeId: item.slots[0].id
      };
    }

    // Check if item is itself a BytecodeArray
    if (item.space === 3 && item.slots && item.slots.some(s => s?.type === 'SelfIndirectPointer')) {
      return {
        type: 'BytecodeArrayRef',
        id: item.id
      };
    }

    // Check if item has rawPayload (String or HeapNumber)
    if (item.rawPayload) {
      const raw = item.rawPayload;
      if (item.sizeInTagged === 3 && raw.length === 8) {
        return raw.readDoubleLE(0);
      }
      // A sequential string object in V8 has NO pointer slots; all slots after the map are raw bytes.
      const isPureRaw = raw.length === (item.sizeInTagged - 1) * 4;
      if (isPureRaw && raw.length >= 8) {
        let mapName = null;
        if (item.map?.type === 'RootArrayConstant' || item.map?.type === 'RootArray') {
          const rootIdx = item.map.type === 'RootArrayConstant' ? item.map.rootIndex : item.map.id;
          mapName = this.profile?.getRoot(rootIdx)?.cpp_name;
        }
        const isTwoByte = Boolean(mapName && mapName.includes('two_byte_string_map'));
        const isOneByte = Boolean(mapName && mapName.includes('one_byte_string_map'));


        if (isTwoByte || isOneByte) {
          const len = raw.readInt32LE(4);
          if (len < 0) {
            throw new Error(`[StrictDeserializer] Corrupted string length ${len} in object ${item.id}`);
          }
          if (isTwoByte) {
            if (8 + len * 2 > raw.length) {
              throw new Error(`[StrictDeserializer] Buffer underrun reading TwoByteString: need ${8 + len * 2}, got ${raw.length}`);
            }
            return raw.subarray(8, 8 + len * 2).toString('utf16le');
          } else {
            if (8 + len > raw.length) {
              throw new Error(`[StrictDeserializer] Buffer underrun reading OneByteString: need ${8 + len}, got ${raw.length}`);
            }
            return raw.subarray(8, 8 + len).toString('utf8');
          }
        }
      }
      if (raw.length === 4 && (!item.slots || item.slots.length === 0)) {
        return raw.readInt32LE(0) >> 1;
      }
    }

    // Check if item is ArrayBoilerplateDescription (has constant_elements in slot 1)
    if (item.slots && item.slots.length >= 2 && item.slots[1]) {
      let elementsObj = item.slots[1];
      if (elementsObj.type === 'PendingForwardRef' && elementsObj.target) {
        elementsObj = elementsObj.target;
      }
      if (elementsObj && elementsObj.rawPayload && elementsObj.rawPayload.length >= 4) {
        const raw = elementsObj.rawPayload;
        const len = raw.readInt32LE(0) >> 1;
        if (len >= 0 && 4 + len * 4 <= raw.length) {
          const elements = [];
          for (let e = 0; e < len; e++) {
            const smiVal = raw.readInt32LE(4 + e * 4) >> 1;
            elements.push(smiVal);
          }
          return { type: 'ArrayBoilerplate', elements };
        }
      }
    }

    if (item.slots) {
      return { type: 'HeapObjectRef', id: item.id };
    }
    return item;
  }

  extractFunctions() {
    // Find all BytecodeArray objects in trusted space (space 3)
    const bytecodes = this.objects.filter(o => o.space === 3 && o.slots.some(s => s && s.type === 'SelfIndirectPointer'));
    const functions = [];

    for (let i = 0; i < bytecodes.length; i++) {
      const b = bytecodes[i];
      const raw = b.bytecodePayload || b.rawPayload;
      if (!raw || raw.length < 12) {
        throw new Error(`[StrictDeserializer] Malformed BytecodeArray #${i} (id=${b.id}): missing bytecode payload`);
      }
      // slot[1] is length (Smi: value << 1 in pointer compression)
      let bytecodeLength = raw.length - 12;
      const lengthSlot = b.slots[1];
      if (lengthSlot && lengthSlot.raw) {
        const smiVal = lengthSlot.raw.readInt32LE(0) >> 1;
        if (smiVal > 0 && smiVal <= raw.length - 12) {
          bytecodeLength = smiVal;
        }
      }

      const frameSize = raw.readInt32LE(0);
      const parameterSize = raw.readUInt16LE(4);
      const maxArguments = raw.readUInt16LE(6);
      const incomingNewTarget = raw.readInt32LE(8);
      const bytecode = raw.subarray(12, 12 + bytecodeLength);

      // Extract dedicated constant pool (slot 5)
      // Note: cpObj.slots[0] is the length of FixedArray. Elements start at slot[1].
      let cpObj = b.slots[5];
      if (cpObj && cpObj.type === 'PendingForwardRef' && cpObj.target) {
        cpObj = cpObj.target;
      }
      const constants = [];
      if (cpObj && cpObj.slots) {
        for (let k = 1; k < cpObj.slots.length; k++) {
          constants.push(this.decodeConstant(cpObj.slots[k]));
        }
      }

      // Extract exception handler table (slot 4)
      let htObj = b.slots[4];
      if (htObj && htObj.type === 'PendingForwardRef' && htObj.target) {
        htObj = htObj.target;
      }
      const handlers = [];
      if (htObj && htObj.rawPayload && htObj.rawPayload.length >= 20) {
        const hRaw = htObj.rawPayload;
        const count = Math.floor((hRaw.length - 4) / 16);
        for (let h = 0; h < count; h++) {
          const start = hRaw.readInt32LE(4 + h * 16);
          const end = hRaw.readInt32LE(4 + h * 16 + 4);
          const val = hRaw.readInt32LE(4 + h * 16 + 8);
          const handlerOffset = val >> 4;
          const catchPrediction = val & 0xf;
          const data = hRaw.readInt32LE(4 + h * 16 + 12);
          handlers.push({ start, end, handlerOffset, catchPrediction, data });
        }
      }

      functions.push({
        id: b.id,
        index: i,
        frameSize,
        registerCount: Math.floor(frameSize / 8),
        parameterSize,
        parameterCount: Math.max(0, parameterSize - 1),
        maxArguments,
        incomingNewTarget,
        bytecode,
        constants,
        handlers,
        constantPoolObjId: cpObj ? cpObj.id : null
      });
    }

    return functions;
  }
}

export class JSCDeserializer {
  constructor(profile = new V8Profile()) {
    this.profile = profile;
  }

  parseHeader(buffer) {
    if (buffer.length < 32) {
      throw new Error(`[JSCDeserializer] File too short for V8 cache header (${buffer.length} < 32 bytes)`);
    }

    const magic = buffer.readUInt32LE(0);
    const versionHash = buffer.readUInt32LE(4);
    const sourceHash = buffer.readUInt32LE(8);
    const flagHash = buffer.readUInt32LE(12);
    const readOnlySnapshotChecksum = buffer.readUInt32LE(16);
    const payloadLength = buffer.readUInt32LE(20);
    const checksum = buffer.readUInt32LE(24);

    return {
      magic: '0x' + magic.toString(16),
      versionHash: '0x' + versionHash.toString(16),
      sourceHash: '0x' + sourceHash.toString(16),
      flagHash: '0x' + flagHash.toString(16),
      readOnlySnapshotChecksum: '0x' + readOnlySnapshotChecksum.toString(16),
      payloadLength,
      checksum: '0x' + checksum.toString(16),
      headerSize: 32
    };
  }

  deserializeFile(filePath) {
    const buffer = fs.readFileSync(filePath);
    const header = this.parseHeader(buffer);
    const payload = buffer.subarray(header.headerSize);

    const deserializer = new StrictV8Deserializer(payload, this.profile);
    const result = deserializer.deserialize();
    const functions = deserializer.extractFunctions();

    return {
      header,
      root: result.root,
      functions,
      totalFunctions: functions.length,
      totalObjects: result.totalObjects
    };
  }
}
