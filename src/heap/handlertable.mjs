// src/heap/handlertable.mjs
//
// Exception handler table decoder. src/codegen/handler-table.h: a
// TrustedByteArray of int32 groups,
//
//   [range_start, range_end, handler_bits, handler_data]
//
// with handler_bits a bitfield. Every index, field size and bitfield position
// comes from the profile's constants.handlerTable, which profilegen derived
// from that header:
//
//   rangeStartIndex / rangeEndIndex / rangeHandlerIndex / rangeDataIndex
//   rangeEntrySize   entries per row            entryFieldSize  bytes per entry
//   bitFields.HandlerPredictionField  offset 0, width 3
//   bitFields.HandlerWasUsedField     offset 3, width 1
//   bitFields.HandlerOffsetField      offset 4, width 28
//
// Two things the previous implementation lost and this one keeps:
//
//   wasUsed     src/deserializer.js computed `val >> 4` for the offset and
//               `val & 0xf` for the prediction, so bit 3 was folded into the
//               prediction and the real prediction was unrecoverable.
//   prediction  distinguishes a source-level `catch` (CAUGHT) from the handler
//               an `await` desugaring installs (ASYNC_AWAIT /
//               UNCAUGHT_ASYNC_AWAIT) and from a promise rejection handler
//               (PROMISE). Without it every handler range looks like a `try`.

export class HandlerTableDecoder {
  constructor(profile) {
    this.spec = profile.constants.handlerTable;
    if (!this.spec) throw new Error('profile constants.json has no handlerTable');
    this.predictionNames = new Map(
      Object.entries(this.spec.catchPrediction).map(([name, value]) => [value, name]));
  }

  /** Mask for a bitfield member of handler_bits. */
  #field(raw, name) {
    const f = this.spec.bitFields[name];
    if (!f) throw new Error(`handler table bitfield ${name} missing from the profile`);
    // VERSION-FREE: all-ones 32-bit mask for a full-width field.
    const mask = f.width >= 32 ? 0xffffffff : ((1 << f.width) - 1) >>> 0;
    return (raw >>> f.offset) & mask;
  }

  get entryBytes() {
    return this.spec.rangeEntryBytes ?? this.spec.rangeEntrySize * this.spec.entryFieldSize;
  }

  /**
   * @param {Buffer} values  the TrustedByteArray payload (no object header)
   * @returns {{entries: Array, warnings: string[]}}
   */
  decode(values) {
    const warnings = [];
    if (!values || values.length === 0) return { entries: [], warnings };
    const stride = this.entryBytes;
    const fieldSize = this.spec.entryFieldSize;
    const count = Math.floor(values.length / stride);
    if (count * stride !== values.length) {
      warnings.push(`handler table is ${values.length} bytes, not a whole number of ${stride}-byte rows; `
        + `decoding the first ${count} rows and ignoring ${values.length - count * stride} trailing bytes`);
    }
    const entries = [];
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const at = (idx) => values.readInt32LE(base + idx * fieldSize);
      const bits = at(this.spec.rangeHandlerIndex) >>> 0;
      const prediction = this.#field(bits, 'HandlerPredictionField');
      entries.push({
        rangeStart: at(this.spec.rangeStartIndex),
        rangeEnd: at(this.spec.rangeEndIndex),
        handlerOffset: this.#field(bits, 'HandlerOffsetField'),
        prediction,
        predictionName: this.predictionNames.get(prediction) ?? null,
        wasUsed: this.#field(bits, 'HandlerWasUsedField') === 1,
        data: at(this.spec.rangeDataIndex),
        rawHandlerBits: bits,
      });
    }
    return { entries, warnings };
  }
}

export default { HandlerTableDecoder };
