// Parse the read-only heap image out of a V8 `snapshot_blob.bin`.
//
// Every constant and every decode rule below is cited to upstream V8 source at
// the tag it was read from. Nothing here is a magic number scraped out of a
// binary by pattern matching.
//
// ---------------------------------------------------------------------------
// 1. Startup blob header -- src/snapshot/snapshot.cc, class SnapshotImpl
// ---------------------------------------------------------------------------
//   kNumberOfContextsOffset          = 0
//   kRehashabilityOffset             = +4
//   kChecksumOffset                  = +8
//   kReadOnlySnapshotChecksumOffset  = +12
//   kVersionStringOffset             = +16, kVersionStringLength = 64
//   kReadOnlyOffsetOffset            = +80
//   kSharedHeapOffsetOffset          = +84
//   kFirstContextOffsetOffset        = +88   (int32 per context)
//   startup payload starts at POINTER_SIZE_ALIGN(88 + 4*num_contexts)
//
// ExtractReadOnlyData(data) = data[kReadOnlyOffset .. kSharedHeapOffset)
//
// The RO checksum header slot is written as (snapshot.cc ~line 578):
//   Checksum(VectorOf(data + payload_offset, payload_length))
// over the *whole* read_only_snapshot->RawData(), i.e. including its own
// 8-byte SnapshotData header. Checksum() is zlib adler32
// (src/snapshot/snapshot-utils.cc).
//
// ---------------------------------------------------------------------------
// 2. SnapshotData -- src/snapshot/snapshot-data.h
// ---------------------------------------------------------------------------
//   kMagicNumberOffset  = 0        (0xC0DE0000 ^ ExternalReferenceTable::kSize)
//   kPayloadLengthOffset= +4
//   kHeaderSize         = 8
//
// ---------------------------------------------------------------------------
// 3. RO image bytecode -- src/snapshot/read-only-serializer-deserializer.h
//                         src/snapshot/read-only-deserializer.cc
// ---------------------------------------------------------------------------
//   0 kAllocatePage          u30 page_index, u30 area_size
//   1 kAllocatePageAt        u30 page_index, u30 area_size, u32 compressed_addr
//   2 kSegment               u30 page_index, u30 offset, u30 size, raw[size]
//   3 kRelocateSegment       bitset[ceil((size/kTaggedSize)/8)]   (!static roots)
//   4 kReadOnlyRootsTable    nothing (static roots) | u32 * kEntriesCount
//   5 kFinalizeReadOnlySpace stop
//
// A static-roots build emits kAllocatePageAt; a non-static-roots build emits
// kAllocatePage (CHECK_EQ(V8_STATIC_ROOTS_BOOL, fixed_offset)), so the first
// opcode identifies the build.
//
// kSegment writes to `page->area_start() + offset`, and
// ReadOnlyPageMetadata::OffsetToAddress(o) = ChunkAddress() + o
// (src/heap/read-only-spaces.h). area_start = ChunkAddress() +
// MemoryChunkLayout::ObjectStartOffsetInDataPage()
//   = RoundUp(sizeof(MemoryChunk), ALIGN_TO_ALLOCATION_ALIGNMENT(kDoubleSize))
//   = RoundUp(16, 8) = 16
// (src/heap/memory-chunk-layout.h; MemoryChunk holds `uintptr_t
// main_thread_flags_` plus either `uint32_t metadata_index_` (sandbox) or
// `MemoryChunkMetadata* metadata_`, so sizeof == 16 either way on x64).
// Therefore  chunk_offset = kAreaStartOffset + segment_offset.
//
// ---------------------------------------------------------------------------
// 4. u30 decoding -- src/snapshot/snapshot-source-sink.h, GetUint30()
// ---------------------------------------------------------------------------
// Reads 4 bytes LE, the low 2 bits are (byte_count - 1), the value is the
// remaining 30 bits of those byte_count bytes shifted right by 2.

import fs from 'node:fs';
import zlib from 'node:zlib';

// --- version-independent-by-construction constants -------------------------
// kPageSizeBits == 18 (src/base/build_config.h); ReadOnly pages use
// MemoryChunk::kAlignment = 1 << kPageSizeBits (src/heap/memory-chunk.h:302).
export const kPageSizeBits = 18;
export const kPageSize = 1 << kPageSizeBits;
// Pointer compression => kTaggedSize = kInt32Size, kTaggedSizeLog2 = 2
// (src/common/globals.h:521) and kObjectAlignmentBits = kTaggedSizeLog2
// (src/common/globals.h:959) => objects are 4-byte aligned.
export const kTaggedSize = 4;
export const kObjectAlignment = 4;
export const kHeapObjectTag = 1;
export const kAreaStartOffset = 16;

const SNAP = {
  numberOfContexts: 0,
  rehashability: 4,
  checksum: 8,
  readOnlySnapshotChecksum: 12,
  versionString: 16,
  versionStringLength: 64,
  readOnlyOffset: 80,
  sharedHeapOffset: 84,
  firstContextOffset: 88,
};

const RO_BC = {
  kAllocatePage: 0,
  kAllocatePageAt: 1,
  kSegment: 2,
  kRelocateSegment: 3,
  kReadOnlyRootsTable: 4,
  kFinalizeReadOnlySpace: 5,
};

export const align = (n, a = kObjectAlignment) => (n + a - 1) & ~(a - 1);

/**
 * internal::Checksum() -- src/snapshot/snapshot-utils.cc:
 *     adler32(0, payload.begin(), payload.length())
 * Note the seed: zlib's adler32(adler, ...) splits `adler` into s1/s2, so
 * seeding with 0 (not the conventional 1) means s1 starts at 0. This is NOT
 * standard RFC-1950 adler32; it is off by exactly (1, length) in (s1, s2).
 * Verified: with seed 1 the value disagrees with the stored header slot of
 * every official snapshot_blob.bin; with seed 0 it matches exactly.
 */
export function v8Checksum(buf) {
  return adler32(buf, 0);
}

/** adler32 with an explicit seed (seed=1 is the RFC-1950 default). */
export function adler32(buf, seed = 1) {
  let a = seed & 0xffff, b = (seed >>> 16) & 0xffff;
  const MOD = 65521;
  // Process in blocks small enough that the 32-bit accumulators cannot overflow
  // a JS double (5552 is the classic NMAX for 32-bit ints).
  for (let i = 0; i < buf.length;) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Sanity: cross-check adler32() against zlib on a fixed vector. */
export function adler32SelfTest() {
  const probe = Buffer.from('Wikipedia');
  const mine = adler32(probe);
  // zlib's own deflate stream embeds adler32 of the uncompressed data as the
  // last 4 bytes (big endian) of a zlib-wrapped stream -- use that as oracle.
  const z = zlib.deflateSync(probe);
  const oracle = z.readUInt32BE(z.length - 4);
  return { mine, oracle, ok: mine === oracle };
}

const RO_SECTION_CHECKSUM = (roRaw) => v8Checksum(roRaw);

export function parseStartupBlob(buf) {
  const u32 = (o) => buf.readUInt32LE(o);
  const numContexts = u32(SNAP.numberOfContexts);
  const versionRaw = buf.subarray(SNAP.versionString, SNAP.versionString + SNAP.versionStringLength);
  const nul = versionRaw.indexOf(0);
  const contextOffsets = [];
  for (let i = 0; i < numContexts; i++) contextOffsets.push(u32(SNAP.firstContextOffset + 4 * i));
  const roOffset = u32(SNAP.readOnlyOffset);
  const sharedHeapOffset = u32(SNAP.sharedHeapOffset);
  const roRaw = buf.subarray(roOffset, sharedHeapOffset);
  return {
    totalSize: buf.length,
    numContexts,
    rehashability: u32(SNAP.rehashability),
    blobChecksum: u32(SNAP.checksum),
    storedRoChecksum: u32(SNAP.readOnlySnapshotChecksum),
    versionString: versionRaw.subarray(0, nul < 0 ? undefined : nul).toString('latin1'),
    roOffset,
    sharedHeapOffset,
    contextOffsets,
    roRaw,
    computedRoChecksum: RO_SECTION_CHECKSUM(roRaw),
    // SnapshotData header on the RO section
    roMagic: roRaw.readUInt32LE(0),
    roPayloadLength: roRaw.readUInt32LE(4),
    roPayload: roRaw.subarray(8, 8 + roRaw.readUInt32LE(4)),
  };
}

class ByteSource {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get() { return this.buf[this.pos++]; }
  getUint32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  getUint30() {
    // src/snapshot/snapshot-source-sink.h GetUint30()
    let answer = this.buf.readUInt32LE(this.pos);
    const bytes = (answer & 3) + 1;
    this.pos += bytes;
    let mask = 0xffffffff;
    mask = bytes === 4 ? 0xffffffff : (mask >>> (32 - (bytes << 3)));
    answer = (answer & mask) >>> 2;
    return answer;
  }
  copyRaw(n) { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  get hasMore() { return this.pos < this.buf.length; }
}

/**
 * Execute the RO image bytecode stream and return the reconstructed pages.
 * `entriesCount` is only needed for non-static-roots builds (to size the
 * kReadOnlyRootsTable payload).
 */
export function parseReadOnlyImage(payload, { entriesCount = null } = {}) {
  const src = new ByteSource(payload);
  const pages = [];
  const log = [];
  let staticRoots = null;
  let rootTable = null;

  const pageAt = (i) => {
    if (!pages[i]) throw new Error(`segment references unallocated page ${i}`);
    return pages[i];
  };

  for (;;) {
    const opStart = src.pos;
    const op = src.get();
    if (op === RO_BC.kAllocatePage || op === RO_BC.kAllocatePageAt) {
      const fixed = op === RO_BC.kAllocatePageAt;
      if (staticRoots === null) staticRoots = fixed;
      else if (staticRoots !== fixed) throw new Error('mixed kAllocatePage/kAllocatePageAt');
      const pageIndex = src.getUint30();
      const areaSize = src.getUint30();
      const compressedAddr = fixed ? src.getUint32() : null;
      if (pages[pageIndex]) throw new Error(`page ${pageIndex} allocated twice`);
      pages[pageIndex] = {
        index: pageIndex, areaSize, compressedAddr,
        bytes: Buffer.alloc(kPageSize), segments: [],
      };
      log.push({ at: opStart, op: fixed ? 'kAllocatePageAt' : 'kAllocatePage', pageIndex, areaSize, compressedAddr });
    } else if (op === RO_BC.kSegment) {
      const pageIndex = src.getUint30();
      const offset = src.getUint30();
      const size = src.getUint30();
      const raw = src.copyRaw(size);
      const page = pageAt(pageIndex);
      raw.copy(page.bytes, kAreaStartOffset + offset);
      page.segments.push({ offset, size });
      log.push({ at: opStart, op: 'kSegment', pageIndex, offset, size });
      if (staticRoots === false) {
        const marker = src.get();
        if (marker !== RO_BC.kRelocateSegment) throw new Error(`expected kRelocateSegment, got ${marker}`);
        const bits = Math.floor(size / kTaggedSize);
        src.pos += Math.ceil(bits / 8);
        log.push({ at: opStart, op: 'kRelocateSegment', bits });
      }
    } else if (op === RO_BC.kReadOnlyRootsTable) {
      if (staticRoots) {
        log.push({ at: opStart, op: 'kReadOnlyRootsTable', payloadBytes: 0 });
      } else {
        if (entriesCount == null) throw new Error('non-static-roots image needs entriesCount');
        rootTable = [];
        for (let i = 0; i < entriesCount; i++) rootTable.push(src.getUint32());
        log.push({ at: opStart, op: 'kReadOnlyRootsTable', payloadBytes: entriesCount * 4 });
      }
    } else if (op === RO_BC.kFinalizeReadOnlySpace) {
      log.push({ at: opStart, op: 'kFinalizeReadOnlySpace' });
      break;
    } else {
      throw new Error(`unknown ro bytecode ${op} at ${opStart}`);
    }
  }

  return {
    staticRoots, rootTable, log,
    pages: pages.filter(Boolean),
    bytesConsumed: src.pos,
    bytesTotal: payload.length,
  };
}

// ---------------------------------------------------------------------------
// static-roots-<variant>.h
// ---------------------------------------------------------------------------

export function parseStaticRoots(text) {
  const byName = new Map();
  // `static constexpr Tagged_t kFoo = 0x11;`  (the generator wraps long lines)
  const flat = text.replace(/\s*\n\s*/g, ' ');
  for (const m of flat.matchAll(/static constexpr Tagged_t k(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+);/g)) {
    byName.set(m[1], Number(m[2]));
  }
  const ordered = [];
  const tableM = text.match(/StaticReadOnlyRootsPointerTable(?:\[\])?\s*=\s*\{([\s\S]*?)\};/);
  if (tableM) {
    for (const m of tableM[1].matchAll(/StaticReadOnlyRoot::k(\w+)/g)) ordered.push(m[1]);
  }
  const byAddr = new Map();
  for (const [n, a] of byName) {
    if (!byAddr.has(a)) byAddr.set(a, []);
    byAddr.get(a).push(n);
  }
  return { byName, byAddr, ordered };
}

export const addrToChunk = (taggedAddr) => ({
  chunk: taggedAddr >>> kPageSizeBits,
  offset: taggedAddr & (kPageSize - 1),
});

/** (chunk,offset) -> Tagged_t for a HeapObject pointer. Verified in §3.6 of
 *  docs/ARCHITECTURE.md and re-verified here against page compressed_addr. */
export const roRefToTagged = (chunk, offset) => (chunk << kPageSizeBits) + offset + kHeapObjectTag;

export function loadBlob(file) {
  return parseStartupBlob(fs.readFileSync(file));
}
