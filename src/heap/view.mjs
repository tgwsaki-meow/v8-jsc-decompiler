// src/heap/view.mjs
//
// HeapView: one deserialized object plus the means to read its fields by byte
// offset.
//
// The deserializer produced two kinds of content per object:
//   * tagged slots holding a *reference* (another object, a root, a read-only
//     reference, a forward reference, ...)
//   * raw byte runs, emitted by kFixedRawData / kVariableRawData, holding
//     everything that is not a pointer: Smis, int32s, uint16s, bitfields,
//     doubles, string characters and bytecode.
//
// A field read therefore resolves to one or the other, and asking for the wrong
// one is an error rather than a silent zero. `optional: true` turns "this byte
// range was never serialized" into `null` so a caller can report a hole; the
// default throws.
//
// Smi decoding uses the profile's own tagging constants:
//   value = (int32)raw >> (kSmiTagSize + kSmiShiftSize)
// With pointer compression a Tagged_t is kTaggedSize bytes wide, which is why
// the shift is applied to a signed read of exactly that width.

export class HeapReadError extends Error {}

export class HeapView {
  /**
   * @param {object} record  a HeapObjectRecord from src/cache/deserialize.mjs
   * @param {import('./index.mjs').HeapContext} ctx
   */
  constructor(record, ctx) {
    this.record = record;
    this.ctx = ctx;
    this.taggedSize = ctx.profile.taggedSize;
    // Both come from the context, computed once per file: BigInt(shift) is an
    // allocation and there is one HeapView per deserialized object.
    this.smiShift = ctx.smiShift;
    this.smiShiftBig = ctx.smiShiftBig;
  }

  get id() { return this.record.id; }
  get sizeInBytes() { return this.record.sizeInBytes; }
  get sizeInTagged() { return this.record.sizeInTagged; }
  get space() { return this.record.space; }

  // ------------------------------------------------------------- raw access

  /** The raw run covering [offset, offset+length), or null. */
  findRun(offset, length) {
    const runs = this.record.rawRuns;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (offset >= run.offset && offset + length <= run.offset + run.length) return run;
    }
    return null;
  }

  missing(offset, length) {
    return new HeapReadError(
      `object ${this.record.id}: bytes [${offset}, ${offset + length}) are not in any raw run `
      + `(runs: ${this.record.rawRuns.map((r) => `[${r.offset},${r.offset + r.length})`).join(' ') || 'none'})`);
  }

  /** A Buffer view of `length` bytes at `offset`, or null when not serialized. */
  bytes(offset, length, opts = {}) {
    if (length === 0) return Buffer.alloc(0);
    const run = this.findRun(offset, length);
    if (!run) {
      if (opts.optional) return null;
      throw this.missing(offset, length);
    }
    const start = offset - run.offset;
    return run.data.subarray(start, start + length);
  }

  // Scalar reads go straight at the run's buffer with an absolute index.
  // Routing them through bytes() would allocate a Buffer view per field read,
  // and the front end reads several fields from every one of the corpus's
  // 2.5 million objects.

  readUnsignedInt(offset, size, opts = {}) {
    const run = this.findRun(offset, size);
    if (!run) { if (opts.optional) return null; throw this.missing(offset, size); }
    const i = offset - run.offset;
    switch (size) {
      case 1: return run.data.readUInt8(i);
      case 2: return run.data.readUInt16LE(i);
      case 4: return run.data.readUInt32LE(i);
      case 8: return Number(run.data.readBigUInt64LE(i));
      default: throw new HeapReadError(`object ${this.record.id}: no unsigned read of width ${size}`);
    }
  }

  readSignedInt(offset, size, opts = {}) {
    const run = this.findRun(offset, size);
    if (!run) { if (opts.optional) return null; throw this.missing(offset, size); }
    const i = offset - run.offset;
    switch (size) {
      case 1: return run.data.readInt8(i);
      case 2: return run.data.readInt16LE(i);
      case 4: return run.data.readInt32LE(i);
      case 8: return Number(run.data.readBigInt64LE(i));
      default: throw new HeapReadError(`object ${this.record.id}: no signed read of width ${size}`);
    }
  }

  readDouble(offset, opts = {}) {
    const size = this.ctx.profile.constants.sizes.kDoubleSize;
    const run = this.findRun(offset, size);
    if (!run) { if (opts.optional) return null; throw this.missing(offset, size); }
    return run.data.readDoubleLE(offset - run.offset);
  }

  /** Smi at a byte offset. */
  readSmi(offset, opts = {}) {
    const size = this.taggedSize;
    const run = this.findRun(offset, size);
    if (!run) { if (opts.optional) return null; throw this.missing(offset, size); }
    const i = offset - run.offset;
    if (size <= 4) return run.data.readInt32LE(i) >> this.smiShift;
    return Number(run.data.readBigInt64LE(i) >> this.smiShiftBig);
  }

  // ------------------------------------------------------------ slot access

  /**
   * The reference in the tagged slot at `offset`, or undefined.
   *
   * Raw-data slots are stored as the shared run that covers them (one object
   * per serializer tag, not per slot); the per-slot `RawSlot` view is built
   * here, only when a caller actually asks for that slot.
   */
  slot(offset) {
    if (offset % this.taggedSize !== 0) {
      throw new HeapReadError(`object ${this.record.id}: slot offset ${offset} is not ${this.taggedSize}-aligned`);
    }
    if (offset === 0) return this.record.map;
    const entry = this.record.slots[offset / this.taggedSize - 1];
    if (entry !== undefined) return entry;
    const run = this.findRun(offset, this.taggedSize);
    if (run === null) return undefined;
    const start = offset - run.offset;
    return { k: 'RawSlot', offset, raw: run.data.subarray(start, start + this.taggedSize) };
  }

  get map() { return this.record.map; }

  // ------------------------------------------------- layout-directed reading

  /**
   * Read the value of a walked field record.
   * Signed/unsigned follows the Torque type name, which is the only thing that
   * distinguishes `int32` from `uint32` at the byte level.
   */
  readScalar(rec, opts = {}) {
    if (rec.kind === 'float') return this.readDouble(rec.offset, opts);
    if (rec.kind === 'int') {
      const signed = /^(int|char)/.test(rec.type) && !/^uint/.test(rec.type);
      return signed ? this.readSignedInt(rec.offset, rec.size, opts) : this.readUnsignedInt(rec.offset, rec.size, opts);
    }
    if (rec.kind === 'bitfield') return this.readUnsignedInt(rec.offset, rec.size, opts);
    if (rec.kind === 'tagged' && /^(Smi|SmiTagged<)/.test(rec.type)) return this.readSmi(rec.offset, opts);
    throw new HeapReadError(`object ${this.record.id}: field ${rec.name} of kind ${rec.kind} (${rec.type}) is not a scalar`);
  }
}

/**
 * Decode a Smi from its tagged word.
 *
 *   value = (signed)raw >> (kSmiTagSize + kSmiShiftSize)
 *
 * With pointer compression the shift is 1 and the word is 4 bytes, so a plain
 * 32-bit arithmetic shift works. Without pointer compression kSmiShiftSize is
 * 31, the shift is 32, and the raw value reaches 2^63 -- which JavaScript's
 * `>>` cannot express (it truncates its operand to 32 bits and takes the shift
 * count mod 32) and which exceeds the exactly-representable integer range. The
 * 8-byte case therefore goes through BigInt. Getting this wrong yields 0 for
 * every Smi on a build without pointer compression, with no outward sign.
 */
export function smiFromBytes(buf, shift) {
  if (buf.length <= 4) {
    const raw = buf.length === 4 ? buf.readInt32LE(0) : buf.readIntLE(0, buf.length);
    return raw >> shift;
  }
  return Number(buf.readBigInt64LE(0) >> BigInt(shift));
}

export default { HeapView, HeapReadError, smiFromBytes };
