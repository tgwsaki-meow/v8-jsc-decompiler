// src/heap/sourceposition.mjs
//
// Source position table decoder. src/codegen/source-position-table.cc.
//
// The encoding, all of it from the profile's constants.sourcePositionTable:
//
//   * variable-length integers, `payloadBitsPerByte` bits of payload per byte
//     with a `moreBit` continuation flag,
//   * every value is a *delta* from the previous entry (`deltaEncoded`),
//   * the position delta is signed, zig-zag encoded (`zigZagSigned`):
//     value = (z >>> 1) ^ -(z & 1),
//   * the first value of each entry packs three things:
//        code_offset  = tmp >> codeOffsetShift
//        is_breakable = (tmp & isBreakableMask) >> isBreakableShift
//        is_statement =  tmp & isStatementMask
//
// The second value is NOT a character offset. It is `SourcePosition::raw()`, a
// 64-bit bitfield (src/codegen/source-position.h):
//
//        bit 0      is_external
//        bits 1-30  script_offset + 1      (when is_external is 0)
//        bits 1-20  external_line + ...    (when is_external is 1)
//        bits 31-46 inlining_id + 1
//
// so the character offset is `scriptOffset` field minus its +1 bias. The bias
// exists so that kNoSourcePosition (-1) stores as 0. Those positions and biases
// come from the overlay, which extracts them from that header; V8's own
// `BytecodeArray::Disassemble` prints `ScriptOffset()`, i.e. the decoded value,
// which is what makes `NN S>` in a listing directly comparable to the
// `sourcePosition` this decoder emits.
//
// This decoder emits absolute values, as the FunctionUnit contract requires.
// `isStatement` and `isBreakable` map one-to-one onto the listing's four
// markers: `S>` statement+breakable, `s>` statement, `E>` expression+breakable,
// `e>` expression.

export class SourcePositionTableDecoder {
  /**
   * @param {import('../profile/index.mjs').Profile} profile
   * @param {import('../cache/overlay.mjs').Overlay} overlay
   */
  constructor(profile, overlay) {
    this.spec = profile.constants.sourcePositionTable;
    if (!this.spec) throw new Error('profile constants.json has no sourcePositionTable');
    this.payloadBits = this.spec.varint.payloadBitsPerByte;
    this.moreBit = 1 << this.spec.varint.moreBit;
    this.payloadMask = (1 << this.payloadBits) - 1;
    if (this.spec.deltaEncoded !== true) {
      throw new Error('this decoder assumes the delta encoding the profile reports; profile says deltaEncoded=false');
    }
    this.sp = overlay?.data?.cppLayouts?.SourcePosition ?? null;
    if (!this.sp) {
      throw new Error('the overlay carries no SourcePosition bitfield layout; '
        + 'regenerate it with node tools/layoutpatch/index.mjs --tag <version>');
    }
    // Both the writer's `previous_` and the reader's `current_` start from a
    // default-constructed PositionTableEntry, whose code_offset is
    // kFunctionEntryBytecodeOffset (-1), not 0 -- the deltas are relative to
    // that. Starting the accumulator at 0 instead shifts every code offset by
    // one and invents a spurious entry; nothing about the decoded bytes looks
    // wrong when that happens.
    this.functionEntryOffset = profile.constants.globals.kFunctionEntryBytecodeOffset;
    if (typeof this.functionEntryOffset !== 'number') {
      throw new Error('profile constants.json has no globals.kFunctionEntryBytecodeOffset');
    }
    this.spFields = {};
    for (const [name, spec] of Object.entries(this.sp.fields)) {
      this.spFields[name] = { div: 2 ** spec.offset, mod: 2 ** spec.width };
    }
  }

  /** `SourcePosition::raw()` -> what V8 prints. */
  decodePosition(raw) {
    // raw exceeds 2^31 because the inlining id lives at bit 31, so this is
    // arithmetic on Numbers, not |0 bit operations. The divisors and moduli are
    // precomputed in the constructor: this runs once per table entry and the
    // corpus has millions.
    const f = this.spFields;
    const field = (spec) => Math.floor(raw / spec.div) % spec.mod;
    const isExternal = field(f.isExternal) === 1;
    const inliningId = field(f.inliningId) - this.sp.inliningIdBias;
    if (isExternal) {
      return {
        isExternal: true,
        sourcePosition: null,
        externalLine: field(f.externalLine),
        externalFileId: field(f.externalFileId),
        inliningId,
      };
    }
    return {
      isExternal: false,
      sourcePosition: field(f.scriptOffset) - this.sp.scriptOffsetBias,
      inliningId,
    };
  }

  /**
   * @param {Buffer} bytes  the TrustedByteArray payload
   * @returns {{entries: Array, warnings: string[], trailingBytes: number}}
   */
  decode(bytes) {
    const warnings = [];
    const entries = [];
    if (!bytes || bytes.length === 0) return { entries, warnings, trailingBytes: 0 };

    let pos = 0;
    const scale = 2 ** this.payloadBits;
    const readVarintUnsigned = () => {
      let value = 0;
      let mul = 1;
      for (;;) {
        if (pos >= bytes.length) throw new RangeError('table ended inside a varint');
        const b = bytes[pos++];
        value += (b & this.payloadMask) * mul;
        mul *= scale;
        if ((b & this.moreBit) === 0) break;
      }
      return value;
    };
    const readVarintSigned = () => {
      const z = readVarintUnsigned();
      // zig-zag: (z >>> 1) ^ -(z & 1), on Numbers so that values past 2^31 work
      const mag = Math.floor(z / 2);
      return (z % 2) === 0 ? mag : -(mag + 1);
    };

    let codeOffset = this.functionEntryOffset;
    let rawPosition = 0;
    const f = this.spec.firstEntry;

    try {
      while (pos < bytes.length) {
        // The byte array is padded; a zero byte would decode as a zero-delta
        // non-statement entry, which the writer never emits.
        if (bytes[pos] === 0) {
          let z = pos;
          while (z < bytes.length && bytes[z] === 0) z++;
          if (z === bytes.length) { pos = z; break; }
        }
        const tmp = readVarintUnsigned();
        const codeDelta = Math.floor(tmp / 2 ** f.codeOffsetShift);
        const isBreakable = ((tmp & f.isBreakableMask) >>> f.isBreakableShift) === 1;
        const isStatement = (tmp & f.isStatementMask) === 1;
        const rawDelta = readVarintSigned();
        codeOffset += codeDelta;
        rawPosition += rawDelta;
        const decoded = this.decodePosition(rawPosition);
        entries.push({
          codeOffset,
          sourcePosition: decoded.sourcePosition,
          isStatement,
          isBreakable,
          rawPosition,
          inliningId: decoded.inliningId,
          // SourcePositionTableIterator defaults to kSkipFunctionEntry, so V8's
          // own listing never prints this one. It is real data (the position of
          // the function's parameter list), so it is emitted and flagged.
          ...(codeOffset === this.functionEntryOffset ? { isFunctionEntry: true } : {}),
          ...(decoded.isExternal
            ? { isExternal: true, externalLine: decoded.externalLine, externalFileId: decoded.externalFileId }
            : {}),
        });
      }
    } catch (e) {
      warnings.push(`source position table truncated after ${entries.length} entries: ${e.message}`);
    }

    // Monotonicity is a property of the writer: code offsets never decrease.
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].codeOffset < entries[i - 1].codeOffset) {
        warnings.push(`source position entry ${i} moves the code offset backwards `
          + `(${entries[i - 1].codeOffset} -> ${entries[i].codeOffset})`);
        break;
      }
    }
    for (const e of entries) {
      if (e.sourcePosition !== null && e.sourcePosition < 0 && e.sourcePosition !== this.sp.kNoSourcePosition) {
        warnings.push(`source position ${e.sourcePosition} at code offset ${e.codeOffset} is negative and is not kNoSourcePosition`);
        break;
      }
    }

    return { entries, warnings, trailingBytes: bytes.length - pos };
  }
}

export default { SourcePositionTableDecoder };
