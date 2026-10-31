// src/cache/source.mjs
//
// SnapshotByteSource: the byte reader the V8 snapshot deserializer runs on.
// Mirrors src/snapshot/snapshot-source-sink.h.
//
// No version-specific value appears here. The two encodings are properties of
// the format, not of a V8 release:
//
//   GetUint30()  a self-describing little-endian integer: the low 2 bits hold
//                (byteCount - 1), the value is the remaining 30 bits. Up to 4
//                bytes, hence "Uint30".
//   GetUint32()  4 bytes little-endian.
//
// `bytesPerLengthField` is 2 bits wide because 4 bytes is the maximum; that is
// the definition of the encoding and is asserted in the self-test against the
// profile's kUInt32Size.

export class SnapshotByteSource {
  /**
   * @param {Buffer} buffer  the payload, header already removed
   * @param {{uint32Size?: number}} opts  sizes taken from the profile
   */
  constructor(buffer, opts = {}) {
    this.buffer = buffer;
    this.pos = 0;
    this.uint32Size = opts.uint32Size ?? 4;
    // The length prefix of GetUint30 is log2(uint32Size) bits wide: it must be
    // able to encode 1..uint32Size bytes.
    this.lengthBits = Math.log2(this.uint32Size);
    if (!Number.isInteger(this.lengthBits)) {
      throw new Error(`SnapshotByteSource: kUInt32Size=${this.uint32Size} is not a power of two`);
    }
    this.lengthMask = (1 << this.lengthBits) - 1;
  }

  get length() { return this.buffer.length; }
  hasMore() { return this.pos < this.buffer.length; }
  get remaining() { return this.buffer.length - this.pos; }

  eof(what) {
    return new CacheFormatError(`unexpected end of payload ${what} at offset ${this.pos} of ${this.buffer.length}`);
  }

  get() {
    if (this.pos >= this.buffer.length) throw this.eof('reading a tag byte');
    return this.buffer[this.pos++];
  }

  peek() {
    if (this.pos >= this.buffer.length) throw this.eof('peeking');
    return this.buffer[this.pos];
  }

  advance(n) {
    if (n < 0 || this.pos + n > this.buffer.length) throw this.eof(`advancing ${n} bytes`);
    this.pos += n;
  }

  /** Little-endian self-describing integer; see snapshot-source-sink.h. */
  getUint30() {
    if (this.pos >= this.buffer.length) throw this.eof('reading a Uint30');
    let answer = 0;
    for (let i = 0; i < this.uint32Size; i++) {
      const b = this.pos + i < this.buffer.length ? this.buffer[this.pos + i] : 0;
      answer |= b << (8 * i);
    }
    answer >>>= 0;
    const bytes = (answer & this.lengthMask) + 1;
    this.advance(bytes);
    const valueBits = bytes * 8 - this.lengthBits;
    // VERSION-FREE: 0xffffffff is an all-ones 32-bit mask.
    const mask = valueBits >= 32 ? 0xffffffff : ((1 << valueBits) - 1) >>> 0;
    return ((answer >>> this.lengthBits) & mask) >>> 0;
  }

  getUint32() {
    if (this.pos + this.uint32Size > this.buffer.length) throw this.eof('reading a Uint32');
    const v = this.buffer.readUInt32LE(this.pos);
    this.advance(this.uint32Size);
    return v;
  }

  /** A zero-copy view of `n` bytes, consuming them. */
  takeRaw(n) {
    if (n < 0 || this.pos + n > this.buffer.length) throw this.eof(`reading ${n} raw bytes`);
    const out = this.buffer.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** The payload does not match the format the profile describes. */
export class CacheFormatError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CacheFormatError';
    if (detail) this.detail = detail;
  }
}

/** The cache was produced by a build this profile does not describe. */
export class CacheVersionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CacheVersionError';
    if (detail) this.detail = detail;
  }
}

/** A serializer tag the profile names but this reader cannot execute. */
export class UnimplementedTagError extends CacheFormatError {
  constructor(tagName, tagByte, why) {
    super(`serializer tag ${tagName} (0x${tagByte.toString(16).padStart(2, '0')}) is not implemented: ${why}`);
    this.name = 'UnimplementedTagError';
    this.tagName = tagName;
    this.tagByte = tagByte;
  }
}

export default { SnapshotByteSource, CacheFormatError, CacheVersionError, UnimplementedTagError };
