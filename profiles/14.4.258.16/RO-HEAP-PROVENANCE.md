# `ro-heap.json` provenance — V8 14.4.258.16

Two tables are generated, both by `tools/oracle/gen_ro_heap.mjs`, both from a
real snapshot blob parsed with the upstream read-only image format
(`src/snapshot/read-only-serializer-deserializer.h`,
`src/snapshot/read-only-deserializer.cc`). Neither is a magic-word scan.

| file | source blob | RO pages | objects | resolves the corpus' refs |
|---|---|---:|---:|---:|
| `ro-heap.json` | `electron-v40.0.0-win32-x64/v8_context_snapshot.bin` | 0–8 | 10 299 | **883/883 distinct, 161 059/161 059 occurrences (100 %)** |
| `ro-heap-d8-startup.json` | official `v8-linux64-rel-14.4.258.16/snapshot_blob.bin` | 0–7 | 7 529 | 88/883 distinct, 1 836/161 059 occurrences |

Use `ro-heap.json`. `ro-heap-d8-startup.json` is kept because it is pure V8 with
no embedder contribution, which is what makes the comparison between the two
informative (see below).

## Why the embedder blob is needed

`kReadOnlyHeapRef` encodes `(chunk_index, chunk_offset)` where `chunk_index` is
a position in `isolate()->heap()->read_only_space()->pages()`
(`src/snapshot/serializer.cc:1464-1486`). The read-only space of a Chromium
context snapshot is **larger** than V8's own: generating
`v8_context_snapshot.bin` puts Blink's interned DOM identifiers and its
`AccessorInfo`/`InterceptorInfo` objects into read-only space, which adds a
ninth page.

Measured, same V8 version, same Electron build:

| blob | pages | strings | AccessorInfo | InterceptorInfo |
|---|---:|---:|---:|---:|
| `electron-v40.0.0/snapshot_blob.bin` | 8 | — | — | — |
| `electron-v40.0.0/v8_context_snapshot.bin` | **9** | 3 182 | 1 235 | 11 |
| official `v8-linux64-rel-14.4.258.16/snapshot_blob.bin` | 8 | 1 648 | 11 | 1 |

Page 8 of the context snapshot starts with `EventTarget`,
`addEventListener`, `dispatchEvent`, `removeEventListener`, `window`,
`document` … i.e. it is Blink's string table, not V8's.

## What is verified

From `ro-heap-report.txt`, regenerate with
`node tools/oracle/gen_ro_heap.mjs --blob … --static-roots … --tag 14.4.258.16`:

* `compressed_page_address == page_index << 18` for **all 9 pages**, which is a
  direct proof of the addressing formula
  `Tagged_t = (chunk_index << 18) + chunk_offset + 1` rather than a spot check.
* `readOnlySnapshotChecksum` recomputed from the read-only section of the blob
  equals the value stored in the blob header (adler32 **seeded with 0**, per
  `src/snapshot/snapshot-utils.cc`). This validates the section boundaries and
  the checksum model.
* The object walk covers every page exactly: `bytesCovered == areaSize` on all
  9 pages, 0 issues. 10 298 of 10 299 objects are sized by a cited layout rule;
  1 falls back to the next static-root boundary.
* **Every one of the 1 047 constants in `static-roots-intl-wasm.h` lands on an
  object start in the table (1047/1047 = 100.00 %)**, and 1 046 of them agree
  with the decoded object kind. The one flagged entry, `EmptyOrderedHashMap`, is
  an artifact of the check itself (the name ends in `Map` but the object is an
  `OrderedHashMap` instance, not a `Map`), not a disagreement.

## What is NOT verified

The corpus's `.jsc` headers carry `readOnlySnapshotChecksum = 0x4be885e`.
No blob obtained here reproduces it:

| blob | stored RO checksum |
|---|---|
| corpus `.jsc` headers | `0x4be885e` |
| `electron-v40.0.0-win32-x64/v8_context_snapshot.bin` | `0xe0a58cd1` |
| `electron-v40.0.0-win32-x64/snapshot_blob.bin` | `0xe213ec56` |
| official `v8-linux64-rel-14.4.258.16/snapshot_blob.bin` | `0x89e63ad9` |
| official `v8-win64-rel-14.4.258.17/snapshot_blob.bin` | `0xad86c86a` |

So this is **not** bit-identical proof that `ro-heap.json` is the corpus's own
read-only heap. The supporting evidence that it is nevertheless the right
*layout* is:

* `ExternalReferenceTable::kSize` matches exactly: the Electron blob's
  `SnapshotData` magic is `0xc0de0674`, the same as the corpus `.jsc` magic
  (`0xC0DE0000 ^ 1652`). The official d8 blob is `0xc0de0675` (1653), i.e. a
  different build config.
* all 883 distinct `(chunk, offset)` pairs the corpus actually references land
  on an object start, and every decoded value is a plausible JavaScript
  identifier (`push`, `call`, `exports`, `forEach`, `document`, `window`,
  `setTimeout`, `JSON`, `Math`, …). A wrong layout would produce mid-object
  addresses and garbage.

The residual difference is most likely a patch-level or build-id difference in
QQ's own Electron build. To close it, obtain the `v8_context_snapshot.bin` that
ships with the QQ install and rerun `gen_ro_heap.mjs` on it; a stored RO
checksum of `0x4be885e` would then be conclusive.
