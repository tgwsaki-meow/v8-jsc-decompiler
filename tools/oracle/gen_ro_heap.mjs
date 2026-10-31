#!/usr/bin/env node
// Generate profiles/<tag>/ro-heap.json from a real V8 snapshot_blob.bin plus
// the matching src/roots/static-roots-<variant>.h.
//
// Usage:
//   node tools/oracle/gen_ro_heap.mjs \
//        --blob .v8bin-cache/v8-linux64-rel-14.4.258.16/snapshot_blob.bin \
//        --static-roots scratch/recon/v8src/14.4.258.16/src/roots/static-roots-intl-wasm.h \
//        --tag 14.4.258.16 --variant intl-wasm \
//        --out profiles/14.4.258.16/ro-heap.json

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadBlob, parseReadOnlyImage, parseStaticRoots, kPageSizeBits, kHeapObjectTag } from './ro_snapshot.mjs';
import { RoHeapImage } from './ro_heap.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const blobPath = arg('blob');
const srPath = arg('static-roots');
const tag = arg('tag');
const variant = arg('variant', 'intl-wasm');
const outPath = arg('out', `profiles/${tag}/ro-heap.json`);
const reportPath = arg('report', `profiles/${tag}/ro-heap-report.txt`);

if (!blobPath || !srPath || !tag) {
  console.error('usage: --blob <snapshot_blob.bin> --static-roots <static-roots-*.h> --tag <a.b.c.d> [--variant v] [--out p] [--report p]');
  process.exit(2);
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const blob = loadBlob(blobPath);
const img = parseReadOnlyImage(blob.roPayload);
const srText = fs.readFileSync(srPath, 'utf8');
const sr = parseStaticRoots(srText);
const heap = new RoHeapImage(img.pages, sr);
const { objects, report } = heap.walkAll();

const lines = [];
const say = (s = '') => { lines.push(s); };

say(`# ro-heap generation report`);
say(`tag                 : ${tag}`);
say(`static-roots variant: ${variant}`);
say(`blob                : ${blobPath}`);
say(`blob sha256         : ${sha(blobPath)}`);
say(`blob versionString  : ${blob.versionString}`);
say(`static-roots sha256 : ${sha(srPath)}`);
say(`generated           : ${new Date().toISOString()}`);
say();
say(`## snapshot header (src/snapshot/snapshot.cc SnapshotImpl)`);
say(`numberOfContexts          = ${blob.numContexts}`);
say(`rehashability             = ${blob.rehashability}`);
say(`blob checksum             = 0x${blob.blobChecksum.toString(16)}`);
say(`readOnlySnapshotChecksum  = 0x${blob.storedRoChecksum.toString(16)} (stored)`);
say(`  recomputed from section = 0x${blob.computedRoChecksum.toString(16)}  match=${blob.storedRoChecksum === blob.computedRoChecksum}`);
say(`readOnly section          = [${blob.roOffset}, ${blob.sharedHeapOffset}) = ${blob.roRaw.length} bytes`);
say(`RO SnapshotData magic     = 0x${blob.roMagic.toString(16)}  => ExternalReferenceTable::kSize = ${(blob.roMagic ^ 0xC0DE0000) >>> 0}`);
say(`RO payload length         = ${blob.roPayloadLength}`);
say();
say(`## read-only image (src/snapshot/read-only-serializer-deserializer.h)`);
say(`static roots build        = ${img.staticRoots} (first opcode was ${img.staticRoots ? 'kAllocatePageAt' : 'kAllocatePage'})`);
say(`payload bytes consumed    = ${img.bytesConsumed} / ${img.bytesTotal}`);
const opCounts = {};
for (const e of img.log) opCounts[e.op] = (opCounts[e.op] || 0) + 1;
say(`opcode histogram          = ${JSON.stringify(opCounts)}`);
say();
say(`## pages: compressed_page_address vs (page_index << kPageSizeBits)`);
let formulaOk = true;
for (const p of img.pages) {
  const expect = p.index << kPageSizeBits;
  if (p.compressedAddr !== expect) formulaOk = false;
  say(`  page ${String(p.index).padStart(2)} areaSize=${String(p.areaSize).padStart(7)} compressedAddr=0x${p.compressedAddr.toString(16).padStart(6, '0')} expected=0x${expect.toString(16).padStart(6, '0')} ${p.compressedAddr === expect ? 'OK' : 'MISMATCH'} segments=${p.segments.length}`);
}
say(`=> Tagged_t = (chunk_index << ${kPageSizeBits}) + chunk_offset + ${kHeapObjectTag} holds for all pages: ${formulaOk}`);
say();
say(`## object walk`);
let fallbackCount = 0;
for (const [, o] of objects) if (o.sizeFrom === 'nextStaticRoot') fallbackCount++;
for (const r of report) {
  say(`  page ${r.chunk}: objects=${String(r.count).padStart(5)} segmentBytes=${String(r.segBytes).padStart(7)} bytesCovered=${String(r.covered).padStart(7)} area=[16,${r.areaEnd}) issues=${r.issues.length}`);
  for (const i of r.issues) say(`      !! ${i.at}: ${i.error}`);
}
say(`total objects              = ${objects.size}`);
say(`sized by map/shape formula = ${objects.size - fallbackCount}`);
say(`sized from next static root= ${fallbackCount}   (fallback; see ro_heap.mjs rootOffsets())`);
say();

// ---------------------------------------------------------------------------
// cross-validation: every static root must land on an object start
// ---------------------------------------------------------------------------
say(`## cross-validation against ${path.basename(srPath)}`);
let hit = 0; const missing = [];
for (const [name, addrTagged] of sr.byName) {
  const untagged = addrTagged - kHeapObjectTag;
  const chunk = untagged >>> kPageSizeBits;
  const offset = untagged & ((1 << kPageSizeBits) - 1);
  if (objects.has(`${chunk}:${offset}`)) hit++;
  else missing.push({ name, addrTagged, chunk, offset });
}
say(`static roots in header     = ${sr.byName.size} (ordered table lists ${sr.ordered.length})`);
say(`landing on an object start = ${hit}`);
say(`not landing on an object   = ${missing.length}`);
for (const m of missing.slice(0, 40)) say(`      ${m.name} = 0x${m.addrTagged.toString(16)} -> chunk ${m.chunk} offset ${m.offset}`);
say(`agreement                  = ${hit}/${sr.byName.size} = ${(100 * hit / sr.byName.size).toFixed(2)}%`);
say();

// name agreement: for roots whose name says "...Map", the object must be a Map
let kindOk = 0, kindBad = [];
for (const [name, addrTagged] of sr.byName) {
  const untagged = addrTagged - kHeapObjectTag;
  const chunk = untagged >>> kPageSizeBits;
  const offset = untagged & ((1 << kPageSizeBits) - 1);
  const o = objects.get(`${chunk}:${offset}`);
  if (!o) continue;
  const d = heap.describe(chunk, o);
  const expectMap = /Map$/.test(name) && name !== 'MetaMap';
  const isMap = d.kind === 'map';
  const expectString = /_string$/.test(name);
  const expectSymbol = /_symbol$/.test(name);
  const ok = (expectMap ? isMap : true)
    && (expectString ? d.kind === 'string' : true)
    && (expectSymbol ? d.kind === 'symbol' : true);
  if (ok) kindOk++; else kindBad.push({ name, kind: d.kind, mapName: d.mapName });
}
say(`## root-name vs decoded-kind consistency`);
say(`consistent = ${kindOk}, inconsistent = ${kindBad.length}`);
for (const b of kindBad.slice(0, 30)) say(`      ${b.name}: decoded kind=${b.kind} map=${b.mapName}`);
say();

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
const table = {};
const kindCounts = {};
for (const [key, o] of objects) {
  const d = heap.describe(o.chunk, o);
  if (o.sizeFrom) d.sizeFrom = o.sizeFrom;
  table[key] = d;
  kindCounts[d.kind] = (kindCounts[d.kind] || 0) + 1;
}
say(`## kind histogram`);
for (const [k, v] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(6)}  ${k}`);

const out = {
  $schema: 'profiles/ro-heap.v1',
  provenance: {
    v8Tag: tag,
    staticRootsVariant: variant,
    blob: { path: blobPath, sha256: sha(blobPath), versionString: blob.versionString, bytes: fs.statSync(blobPath).size },
    staticRootsHeader: { path: srPath, sha256: sha(srPath) },
    generator: 'tools/oracle/gen_ro_heap.mjs',
    generatedAt: new Date().toISOString(),
    snapshotHeader: {
      numberOfContexts: blob.numContexts,
      blobChecksum: blob.blobChecksum,
      readOnlySnapshotChecksum: blob.storedRoChecksum,
      readOnlySnapshotChecksumRecomputed: blob.computedRoChecksum,
      readOnlySectionRange: [blob.roOffset, blob.sharedHeapOffset],
      readOnlySnapshotDataMagic: blob.roMagic,
      externalReferenceTableSize: (blob.roMagic ^ 0xC0DE0000) >>> 0,
    },
  },
  addressing: {
    formula: 'Tagged_t = (chunk_index << 18) + chunk_offset + 1',
    kPageSizeBits,
    kTaggedSize: 4,
    kObjectAlignment: 4,
    areaStartOffsetInChunk: 16,
    verifiedAgainstPageCompressedAddresses: formulaOk,
  },
  pages: img.pages.map((p) => ({
    index: p.index, areaSize: p.areaSize, compressedAddr: p.compressedAddr,
    segments: p.segments,
  })),
  validation: {
    staticRootsTotal: sr.byName.size,
    staticRootsOnObjectStart: hit,
    staticRootsMissing: missing.map((m) => m.name),
    rootNameKindConsistent: kindOk,
    rootNameKindInconsistent: kindBad,
    objectsTotal: objects.size,
    objectsSizedByFormula: objects.size - fallbackCount,
    objectsSizedFromNextStaticRoot: fallbackCount,
    perPage: report.map((r) => ({ chunk: r.chunk, objects: r.count, segmentBytes: r.segBytes, bytesCovered: r.covered, areaEnd: r.areaEnd, issues: r.issues })),
  },
  kindCounts,
  objects: table,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\nwrote ${outPath} (${fs.statSync(outPath).size} bytes) and ${reportPath}`);
