// src/heap/roref.mjs
//
// Resolver for `kReadOnlyHeapRef`, which encodes a read-only object as
// `(chunk_index, chunk_offset)` -- a page index in
// `heap()->read_only_space()->pages()` plus a byte offset inside that page.
//
// Two things this file deliberately does NOT do:
//
//  1. It does not consult static-roots.json. `CodeSerializer` dispatches
//     SerializeRoot before SerializeReadOnlyObjectReference, and the ordered
//     StaticReadOnlyRootsPointerTable *is* READ_ONLY_ROOT_LIST, so a read-only
//     object that is a root never reaches the kReadOnlyHeapRef path. Against
//     the corpus that table scores 0/883 -- which is the correct answer for it,
//     not a defect. See ARCHITECTURE.md 3.6.
//  2. It does not throw on a miss. A miss is counted, attributed to its
//     (chunk, offset) with an occurrence count, and surfaced in a report, so
//     the caller can decide. Guessing is never an option.
//
// The address formula `Tagged_t = (chunk << kPageSizeBits) + offset + kHeapObjectTag`
// is computed for reporting only; resolution is by (chunk, offset) key, which
// is what the table is indexed on.

export class RoRefResolver {
  /**
   * @param {object} roHeap   parsed profiles/<tag>/ro-heap.json, or null
   * @param {import('../profile/index.mjs').Profile} profile
   */
  constructor(roHeap, profile) {
    this.table = roHeap?.objects ?? null;
    this.roHeap = roHeap;
    this.profile = profile;
    this.pageSizeBits = roHeap?.addressing?.kPageSizeBits
      ?? profile.constants.readOnlyPage.pageSizeBits;
    this.heapObjectTag = profile.constants.tagging.kHeapObjectTag;
    this.resolvedOccurrences = 0;
    this.unresolvedOccurrences = 0;
    /** key -> {chunkIndex, chunkOffset, address, occurrences} */
    this.unresolved = new Map();
    this.distinctResolved = new Set();
  }

  get available() { return this.table !== null; }

  address(chunkIndex, chunkOffset) {
    return (chunkIndex << this.pageSizeBits) + chunkOffset + this.heapObjectTag;
  }

  /**
   * @param {number} chunkIndex
   * @param {number} chunkOffset
   * @returns {{resolved: boolean, key: string, address: number, entry?: object}}
   */
  resolve(chunkIndex, chunkOffset) {
    const key = `${chunkIndex}:${chunkOffset}`;
    const address = this.address(chunkIndex, chunkOffset);
    const entry = this.table ? this.table[key] : undefined;
    if (entry === undefined) {
      this.unresolvedOccurrences++;
      const u = this.unresolved.get(key);
      if (u) u.occurrences++;
      else this.unresolved.set(key, { chunkIndex, chunkOffset, address, occurrences: 1 });
      return { resolved: false, key, address };
    }
    this.resolvedOccurrences++;
    this.distinctResolved.add(key);
    return { resolved: true, key, address, entry };
  }

  /** Report, sorted by occurrence count. */
  report(limit = 30) {
    const rows = [...this.unresolved.values()].sort((a, b) => b.occurrences - a.occurrences);
    return {
      tableAvailable: this.available,
      tableObjects: this.table ? Object.keys(this.table).length : 0,
      resolvedOccurrences: this.resolvedOccurrences,
      unresolvedOccurrences: this.unresolvedOccurrences,
      distinctResolved: this.distinctResolved.size,
      distinctUnresolved: this.unresolved.size,
      top: rows.slice(0, limit),
      blob: this.roHeap?.provenance?.blob?.path ?? null,
    };
  }

  formatReport(limit = 30) {
    const r = this.report(limit);
    const total = r.resolvedOccurrences + r.unresolvedOccurrences;
      // VERSION-FREE: 100 converts a ratio to a percentage.
    const pct = total ? ((100 * r.resolvedOccurrences) / total).toFixed(2) : '100.00';
    const lines = [
      `read-only references: ${r.resolvedOccurrences}/${total} occurrences resolved (${pct}%), `
      + `${r.distinctResolved} distinct resolved, ${r.distinctUnresolved} distinct unresolved`,
      `  table: ${r.tableAvailable ? `${r.tableObjects} objects from ${r.blob}` : 'NOT LOADED -- every reference is unresolved'}`,
    ];
    for (const u of r.top) {
      lines.push(`  unresolved ${u.chunkIndex}:${u.chunkOffset}  (Tagged_t 0x${u.address.toString(16)})  x${u.occurrences}`);
    }
    return lines.join('\n');
  }
}

export default { RoRefResolver };
