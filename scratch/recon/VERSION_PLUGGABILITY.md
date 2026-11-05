# Version pluggability recon — V8 14.4.258.16 / 14.6.202.34

Scope: can every version-specific table in `rules/` be regenerated from pinned V8
sources with no hardcoding, and is the provenance of the existing tables sound?

All probe scripts live in `scratch/recon/`; their raw output is in `scratch/recon/out/`.
Nothing outside `scratch/recon/` was modified.

| script | what it does |
|---|---|
| `fetch_v8.mjs` | fetch + cache any upstream V8 file at any tag over plain HTTPS |
| `diff_raw.mjs` | diff every `rules/raw/*` against the same path at N tags |
| `bisect_raw_version.mjs` | find which V8 version a local header copy actually came from |
| `gen_bytecode_table.mjs` | derive the Ignition opcode table from `bytecodes.h`; diff two tags |
| `derive_tables.mjs` | derive root lists, serializer tag enum, object field offsets |
| `root_gap_probe.mjs` | account for the root-count gap between source and `static-roots.h` |
| `verify_ro_formula.mjs` | prove the `(chunk,offset)` → `static-roots.h` address formula |
| `ro_pages_probe.mjs` | RO page layout + reproducibility of the binary-derived tables |
| `mint_ro_table.mjs` | mint a local snapshot and derive a RO-heap table end to end |
| `oracle_probe.mjs` | what ground-truth oracles this machine offers |

---

## 0. Headline findings

1. **`rules/v8-ro-heap.json` was empirically scraped from a real binary snapshot**
   (`v8_context_snapshot.bin` from a Windows QQNT install), by scanning for a
   hardcoded map word `0x155`. It was **not** derived from `static-roots.h`.
   The input file **no longer exists on this machine**, so that table is not
   reproducible as written.
2. **Two of the twenty files in `rules/raw/` are from the wrong V8 version.**
   `roots.h` and `static-roots.h` are byte-identical to **V8 12.8.374.38**, six
   minor versions behind the corpus. The other 18 are byte-identical to
   14.4.258.16.
3. `src/roots/static-roots.h` has not contained the table since ~14.2 — it is a
   26-line dispatcher that includes one of four build-variant headers. The
   monolithic file in `rules/raw/` is the pre-split 12.8 form.
4. The opcode table in `rules/v8-14.4.258.16.json` **is** correct and
   reproducible: an independent macro expander produces byte-identical opcode
   numbering, implicit register use and operand lists (0 mismatches, 212 opcodes).
5. **`manifest.json`'s `source_hash` field is mislabelled.** The value
   `0x265b14d1` is `FlagList::Hash()`, and the value it calls `payload_size` is
   the real `sourceHash` (= the source length in characters). The real payload
   length is a different field.
6. **`node --print-bytecode` works on this machine** and so does the full x64
   disassembler (`--print-code`, `--print-builtin-code`). Earlier "it printed
   nothing" was an artifact of the agent terminal dropping stdout, not a missing
   `ENABLE_DISASSEMBLER`.
7. Local Node's V8 is built **without pointer compression and without static
   roots**, so it cannot stand in for the QQ/Chromium build's address layout —
   but it can still mint a real snapshot whose read-only image parses with the
   same code path.

---

## 1. Provenance audit of `rules/`

### 1.1 `rules/v8-14.4.258.16.json` — produced by `tools/extract_rules.js`

Evidence: mtimes are adjacent and in order.

```
tools\extract_rules.js            4503   10/3/2026 10:33:27 AM
rules\v8-14.4.258.16.json        92235   10/3/2026 10:33:33 AM
```

Input: `rules/raw/bytecodes.h` only (`fs.readFileSync('rules/raw/bytecodes.h')`).
It extracts three macro blocks, splices `CALL_PROPERTY_BYTECODES(V)` in place,
appends `SHORT_STAR_BYTECODE_LIST` then `V(Illegal, …)`, and numbers them 0..N-1.

**Reproducible today: yes**, and verified correct. `gen_bytecode_table.mjs`
re-derives the table from the upstream tag with a generic macro expander:

```
=== rules/v8-14.4.258.16.json vs freshly-derived 14.4.258.16 ===
  checked-in total_opcodes: 212, derived: 212
  mismatches: 0
```

Two caveats, both hardcoding:

* `operand_properties` and `header_offsets` in `extract_rules.js` are **hand-typed
  literal objects**, not parsed from source. They happen to be right for 14.4
  (cross-checked against `src/interpreter/bytecode-operands.h` and
  `src/snapshot/code-serializer.h`), but they are not derived, and for 14.6 the
  table would silently lack `kEmbeddedFeedback` → wrong instruction lengths.
* `operand_properties` is missing `kRegPair` → no, it has it; it is missing
  nothing for 14.4, but the list is closed. `derive`d version enumerates
  `OPERAND_TYPE_LIST` so new types appear automatically.

`tools/extract_rules.py` is an earlier variant that fetched from
`raw.githubusercontent.com` into `rules/raw/`. It did **not** produce the
checked-in JSON, and it has a real ordering bug:

```python
full_list = unique_handlers + call_props + short_stars + [{...Illegal...}]
```

`CALL_PROPERTY_BYTECODES` is appended at the end instead of being expanded at its
call site inside `BYTECODE_LIST_WITH_UNIQUE_HANDLERS_IMPL`, so every opcode from
`CallProperty` onward would be misnumbered. (The `.js` version fixed this with
`uniqueHandlersRaw.replace('CALL_PROPERTY_BYTECODES(V)', callPropsRaw)`.)

### 1.2 `rules/v8-roots-14.4.258.16.json` — produced by `tools/build_canonical_roots.py`

Evidence: mtimes, and the output shape (`{version, total_roots, roots}`, 1150
entries) matches that script, not `gen_roots_table.py` (which writes
`roots_by_index` and 1108 entries).

```
tools\build_canonical_roots.py     4430   10/3/2026 2:04:41 PM
rules\v8-roots-14.4.258.16.json  139791   10/3/2026 2:05:13 PM
```

Inputs:

1. `rules/raw/heap-symbols.h` — parsed for `V(_, name, "value")` string literals.
2. **A Windows binary**, at a hardcoded file offset:

```python
dll_path = r'C:\Users\yumemita\Pictures\Q\pc\260924\win\Files\versions\9.9.36-53644\QQNT.dll'
...
po = 0xc602b60
# In V8 snapshot serialization, root index 0 corresponds to table entry 4 (undefined_value)
# Therefore, serialized_root_id = table_index - 4
for table_idx in range(4, 4 + total_roots):
```

That is a walk over `RootsTable`'s debug-name pointer array inside the shipped
DLL, with a magic `-4` index shift and a magic `total_roots = 1150`.

**Reproducible today: no.** `ro_pages_probe.mjs` checked every binary the
generators reference:

```
  MISSING  .../win/Files/versions/9.9.36-53644/v8_context_snapshot.bin
  MISSING  .../win/Files/versions/9.9.36-53644/snapshot_blob.bin
  MISSING  .../win/Files/versions/9.9.36-53644/QQNT.dll
  MISSING  .../linux/data/opt/QQ/resources/app/major.node
  (process home dir is C:\Users\arale)
```

The *content* is nevertheless substantially correct. Positional comparison against
upstream `StaticReadOnlyRootsPointerTable` at 14.4.258.16:

```
  StaticReadOnlyRootsPointerTable order has 1045 entries
  positional name agreement with checked-in roots[i].cpp_name: 1041/1045
    [0] static-roots=UndefinedValue   checked-in=undefined_value
    [9] static-roots=ByteArrayMap     checked-in=byte_array_map
```

So indices 0..1044 are the read-only roots in the real 14.4 order, and
1045..1149 are the mutable/strong roots (`next_template_serial_number`,
`construct_stub_*_deopt_pc_offset`, `interpreter_entry_return_pc_offset`, …),
which is also the real `MUTABLE_ROOT_LIST` tail. The table is right; its
*derivation* is a binary scrape mislabelled as source-derived.

Two other scripts are dead ends:

* `tools/expand_roots.py` reads the four headers and prints
  `'All 4 header files loaded successfully.'` — it produces nothing.
* `tools/compare_roots.py` does the real job (expand `ROOT_LIST` with `pcpp`,
  compare to `StaticReadOnlyRootsPointerTable`) but needs Python + `pcpp`, and
  **there is no Python on this machine**, so it cannot run.

### 1.3 `rules/v8-ro-heap.json` — empirically scraped from a binary snapshot

**Answer to the critical question: it was guessed by scanning a real snapshot
blob, not derived from `static-roots.h`.**

Producer: `scratch/generate_complete_ro_heap.js`.

```
scratch\generate_complete_ro_heap.js   3119   10/3/2026 1:30:49 AM
rules\v8-ro-heap.json                 96197   10/3/2026 1:30:54 AM
```

The decisive code (`scratch/generate_complete_ro_heap.js`):

```js
const buf = fs.readFileSync('C:/Users/yumemita/Pictures/Q/pc/260924/win/Files/versions/9.9.36-53644/v8_context_snapshot.bin');
...
const src = new ByteSource(buf, 120376);
while (src.pos < 454233) {
  const opcode = src.get();
  if (opcode === 1) { // kAllocatePageAt
    const pageIndex = src.getUint30();
    const areaSize = src.getUint30();
    const compressedAddr = src.getUint32();
    pages.set(pageIndex, Buffer.alloc(262144, 0));
  } else if (opcode === 2) { // kSegment
...
// Walk all pages and record all SeqOneByteStrings
// In V8, chunk_offset = segment_offset + 16 (since area_start = chunk_start + 16)
for (const [pageIndex, page] of pages.entries()) {
  for (let p = 0; p < page.length - 12; p += 4) {
    const map = page.readUInt32LE(p);
    if (map === 0x155) { // SeqOneByteString
      const len = page.readUInt32LE(p + 8);
      ...
      const chunkOffset = p + 16;
      fullROHeap[`${pageIndex}:${chunkOffset}`] = s;
```

Every version-specific quantity there is a literal: the byte window
`120376..454233`, `opcode === 1 / 2`, the page size `262144`, the map word
`0x155`, and `+ 16`. Note also that `compressedAddr` — the one piece of data that
makes the table address-resolvable — is read and **thrown away**.

The earlier attempt, `scratch/create_ro_heap_json.js`, is even more hand-fitted:
it reads `snapshot_blob.bin`, walks a string chain from a literal position
`31082` to `53291` with a literal page base `8706`, and bolts on seven strings by
hand:

```js
let pos = 31082;
while (pos < 53291) {
  const map = buf.readUInt32LE(pos);
  if (map !== 0x155) break;
  ...
  const chunk = pos - 8706;
...
const earlyStrings = [
  { p: 25894, s: 'prototype' }, { p: 25918, s: 'name' }, ...
```

The checked-in file is the output of the later script: 3182 entries spread over
chunks `{0: 831, 6: 817, 8: 1534}`, which only the page-walking version produces.

Two corrections to the comments in that script, both established from upstream
source in §4:

* `map === 0x155` is **not** `SeqOneByteStringMap`. At 14.4.258.16,
  `kSeqOneByteStringMap = 0x105` and `kInternalizedOneByteStringMap = 0x155`
  (identical in all four build variants, since the string maps come first). In
  the stale 12.8 copy in `rules/raw/static-roots.h`, `0x155` is not a map at all:

```
rules/raw/static-roots.h (==12.8.374.38) 0x155=-  0x105=-  0x10d=SeqOneByteStringMap  0x69=UndefinedValue
14.4.258.16 intl+wasm          0x155=InternalizedOneByteStringMap  0x105=SeqOneByteStringMap  0x11=FirstAllocatedRoot
```

  Constant-pool strings are internalized, so the scan found the right objects by
  accident of using the right magic number for a 14.4 build.
* `+ 16` is correct and *is* derivable (not a guess, even though it was written as
  one) — see §4.1.

---

## 2. Is `rules/raw/` really V8 14.4.258.16?

Upstream is reachable over plain HTTPS without depot_tools. Both of these work:

* gitiles, base64-encoded blob:
  `https://chromium.googlesource.com/v8/v8/+/refs/tags/14.4.258.16/src/interpreter/bytecodes.h?format=TEXT`
* GitHub mirror, plain text:
  `https://raw.githubusercontent.com/v8/v8/14.4.258.16/src/interpreter/bytecodes.h`

`scratch/recon/fetch_v8.mjs` implements the first (with retry on gitiles' 429/503)
and caches under `scratch/recon/v8src/<tag>/<path>`.

Tag existence probe (`node scratch/recon/fetch_v8.mjs --exists …`):

```
OK   200  14.4.258.16  https://chromium.googlesource.com/v8/v8/+/refs/tags/14.4.258.16?format=JSON
OK   200  14.6.202.34  https://chromium.googlesource.com/v8/v8/+/refs/tags/14.6.202.34?format=JSON
OK   200  14.4.258.15
FAIL 404  99.0.0.1
```

Both target tags exist. The full ref listing
(`https://chromium.googlesource.com/v8/v8/+refs?format=TEXT`, 580 413 lines,
38 MB, cached as `scratch/recon/v8_refs.txt`) contains 45 965 four-component tags;
`14.4.258.1` … `14.4.258.74` all exist, each with a `-pgo` twin, plus
`refs/branch-heads/14.4`. **How to pin: use `refs/tags/<a.b.c.d>`** — it is an
immutable tag and the `?format=TEXT`/raw URL for any path under it is stable. Use
`refs/branch-heads/<a.b>` only if you deliberately want the moving branch tip.

### 2.1 File-by-file diff (`diff_raw.mjs`, CRLF-normalised)

```
file                        localLines  == 14.4.258.16      == 14.6.202.34
accessors.h                      168  IDENTICAL             differs@L45 (171L)
bytecode-array.h                 195  IDENTICAL             differs@L157 (196L)
bytecode-operands.h              241  IDENTICAL             differs@L45 (242L)
bytecode-register.h              279  IDENTICAL             IDENTICAL
bytecodes.h                     1180  IDENTICAL             differs@L329 (1185L)
code-serializer.cc               918  IDENTICAL             differs@L700 (920L)
code-serializer.h                182  IDENTICAL             IDENTICAL
deserializer.cc                 1697  IDENTICAL             differs@L330 (1707L)
deserializer.h                   403  IDENTICAL             differs@L89 (405L)
frame-constants-x64.h            153  IDENTICAL             IDENTICAL
frame-constants.h                824  IDENTICAL             differs@L463 (881L)
heap-symbols.h                  1189  IDENTICAL             differs@L632 (1195L)
object-deserializer.cc           143  IDENTICAL             differs@L44 (143L)
object-deserializer.h             53  IDENTICAL             IDENTICAL
objects-definitions.h            244  IDENTICAL             differs@L175 (246L)
roots.cc                         134  IDENTICAL             IDENTICAL
roots.h                          751  differs@L35 (793L)    differs@L35 (805L)
serializer-deserializer.h        314  IDENTICAL             IDENTICAL
snapshot-source-sink.h           159  IDENTICAL             IDENTICAL
static-roots.h                  1569  differs@L5 (26L)      differs@L5 (26L)
```

18 of 20 are byte-identical to the 14.4.258.16 tag. The local copies are CRLF
(written through Windows text-mode I/O); after `\r\n → \n` they match exactly.

### 2.2 The two mismatches are from V8 12.8.374.38

`bisect_raw_version.mjs` probes the newest tag of every minor from 11.0 to 15.8
and compares sha256 of the LF-normalised content:

```
### roots.h  local sha=142d653defe033e5 lines=751
  12.7.10020222.0 sha=2598441be73e2933 lines=  744  | V(HeapNumber, hole_nan_value, HoleNanValue)
  12.8.374.38     sha=142d653defe033e5 lines=  751 *** EXACT MATCH ***
  12.9.66450133.1 sha=03bac3377b9d1837 lines=  755
  ...
  13.9.205.21     sha=391098dfda75a6fe lines=  789  | V(HeapNumber, undefined_nan_value, UndefinedNanValue)
  exact matches: 12.8.374.38

### static-roots.h  local sha=38163b26f3185f86 lines=1569
  12.8.374.38     sha=38163b26f3185f86 lines= 1569 *** EXACT MATCH ***
  14.2.231.22 … 15.3.76.24  sha=4051415318513b6b lines=26
  exact matches: 12.8.374.38
```

Two independently visible markers:

* `src/roots/roots.h` line 35 — local says `V(HeapNumber, hole_nan_value, HoleNanValue)`;
  upstream 14.4.258.16 says `V(HeapNumber, undefined_nan_value, UndefinedNanValue)`.
  The rename landed between 13.8 and 13.9.
* `src/roots/static-roots.h` — local is the 1569-line generated table guarded by
  `static_assert(V8_ENABLE_WEBASSEMBLY); static_assert(V8_INTL_SUPPORT);`.
  Upstream 14.4.258.16 is a 26-line dispatcher:

```c
#if V8_STATIC_ROOTS_BOOL
#ifdef V8_ENABLE_WEBASSEMBLY
#ifdef V8_INTL_SUPPORT
#include "src/roots/static-roots-intl-wasm.h"   // IWYU pragma: export
#else
#include "src/roots/static-roots-nointl-wasm.h" // IWYU pragma: export
...
```

  The split happened between 14.1 and 14.2 (14.2.231.22 onwards is the 26-line
  form).

Consequences of the stale copies, measured:

```
                               consts  orderedTable   min     max      UndefinedValue
14.4.258.16 intl+wasm            1040      1045       0x11   0x1a0111        0x11
14.4.258.16 nointl+wasm           898       903       0x11   0x1a0111        0x11
14.4.258.16 intl+nowasm           1021     1026       0x11   0x180121        0x11
14.4.258.16 nointl+nowasm          879      884       0x11   0x180121        0x11
rules/raw/static-roots.h (12.8)   757       763       0x69   0x2006d         0x69
```

Every single static-root address in the checked-in copy is wrong for the corpus.
Resolving the corpus's read-only refs through it yields 2.4 % hits; through the
correct 14.4 `intl+wasm` variant it yields 22.9 % (see §4.2).

**Fix:** replace `rules/raw/roots.h` and `rules/raw/static-roots.h` with the
14.4.258.16 versions, and add the four `static-roots-<intl|nointl>-<wasm|nowasm>.h`
variants, selecting `intl+wasm` for an Electron/Chromium build.

---

## 3. Can we get the whole needed source set?

### 3.0 Minimum upstream file set

All paths relative to the repo root, all fetchable at `refs/tags/<version>`.

| need | files | derivable from source? |
|---|---|---|
| (a) opcode table, operand types/scales, implicit register use | `src/interpreter/bytecodes.h`, `src/interpreter/bytecode-operands.h`, `src/interpreter/bytecode-register.h` | **yes, fully** |
| (b) serializer/deserializer tags | `src/snapshot/serializer-deserializer.h` | **yes, fully** |
| (c) root list + values | `src/roots/roots.h`, `src/init/heap-symbols.h`, `src/objects/objects-definitions.h`, `src/builtins/accessors.h`, **`torque-generated/instance-types.h`** | **partially** — last file is a build artifact |
| (d) static-roots offsets | `src/roots/static-roots-{intl,nointl}-{wasm,nowasm}.h` (≥14.2) or `src/roots/static-roots.h` (≤14.1) | **yes** (pick the variant matching the build config) |
| (e) object field offsets | `src/objects/*.tq` + the owning `src/objects/*.h`, plus `src/utils/utils.h` for the offset-accumulation macro, plus `src/common/globals.h` for the size constants | **yes** for `FIELD_LIST` classes; **yes modulo conditionals** for Torque classes |
| code-cache header | `src/snapshot/code-serializer.h`, `src/snapshot/code-serializer.cc` | yes |
| RO image format | `src/snapshot/read-only-serializer-deserializer.h`, `read-only-serializer.cc`, `read-only-deserializer.cc`, `src/heap/read-only-spaces.h`, `src/heap/memory-chunk-layout.h`, `src/heap/memory-chunk.h` | yes |
| snapshot blob format | `src/snapshot/snapshot.cc`, `src/snapshot/snapshot-data.h` | yes |
| source position table | `src/codegen/source-position-table.h/.cc`, `src/codegen/source-position.h` | yes |
| handler table | `src/codegen/handler-table.h` | yes |

### 3.1 (a) Ignition opcode table — fully derivable, verified

`gen_bytecode_table.mjs` collects every function-like `#define` in `bytecodes.h`,
resolves the single relevant conditional, and expands `BYTECODE_LIST(V, V)`.

The only build-config assumption:

```c
// src/interpreter/bytecodes.h:506-512 @14.4.258.16
#ifdef V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS
#define BYTECODE_LIST_WITH_UNIQUE_HANDLERS(V, V_TSA) \
  BYTECODE_LIST_WITH_UNIQUE_HANDLERS_IMPL(V, V_TSA)
#else
#define BYTECODE_LIST_WITH_UNIQUE_HANDLERS(V, V_TSA) \
  BYTECODE_LIST_WITH_UNIQUE_HANDLERS_IMPL(V, V)
#endif
```

i.e. take the `#else` branch (`V_TSA` collapses to `V`) — that is the shipping
default. Numbering then comes straight from the enum:

```c
// src/interpreter/bytecodes.h:517-531, 622-634 @14.4.258.16
#define BYTECODE_LIST(V, V_TSA)                                      \
  BYTECODE_LIST_WITH_UNIQUE_HANDLERS(V, V_TSA)                       \
  SHORT_STAR_BYTECODE_LIST(V)                                        \
  V(Illegal, ImplicitRegisterUse::kNone)

enum class Bytecode : uint8_t {
#define DECLARE_BYTECODE(Name, ...) k##Name,
  BYTECODE_LIST(DECLARE_BYTECODE, DECLARE_BYTECODE)
  ...
  kFirstShortStar = kStar15,
  kLastShortStar = kStar0
};
```

so `opcode_value = index of the entry in the fully-expanded BYTECODE_LIST`.
There are no `#if`s inside the list itself (checked: the only preprocessor
directives in the whole file are the include guard, the TSA block at 506-512, and
an unrelated `V8_TARGET_OS_ANDROID` block at 689-715).

Operand properties come from `OPERAND_TYPE_LIST` in `bytecode-operands.h`, which
maps each `OperandType` to an `OperandTypeInfo`, and the four `OperandTypeInfo`
classes give (scalable?, signed?, base size):

```c
// src/interpreter/bytecode-operands.h @14.4.258.16
#define REGISTER_INPUT_OPERAND_TYPE_LIST(V)        \
  V(Reg, OperandTypeInfo::kScalableSignedByte)     ...
#define UNSIGNED_FIXED_SCALAR_OPERAND_TYPE_LIST(V)           \
  V(Flag8,  OperandTypeInfo::kFixedUnsignedByte)             \
  V(Flag16, OperandTypeInfo::kFixedUnsignedShort)            ...
#define OPERAND_SCALE_LIST(V) V(Single, 1) V(Double, 2) V(Quadruple, 4)
```

Derivation rule: `size(op, scale) = scalable ? base_size * scale : base_size`,
where `scale` is 1 / 2 / 4 selected by a `Wide` / `ExtraWide` prefix.

Result for 14.4.258.16 (`out/bytecodes_report.txt`):

```
=== 14.4.258.16 : 212 opcodes (0x00..0xd3) ===
  operand types in OPERAND_TYPE_LIST: 22
  unknown operand types referenced   : (none)
  Wide                   0x00  kNone  []
  ExtraWide              0x01  kNone  []
  GetNamedProperty       0x33  kWriteAccumulator  [kReg, kConstantPoolIndex, kFeedbackSlot]
  CallProperty           0x65  kWriteAccumulator  [kReg, kRegList, kRegCount, kFeedbackSlot]
  CallUndefinedReceiver  0x69  kWriteAccumulator  [kReg, kRegList, kRegCount, kFeedbackSlot]
  CreateClosure          0x8b  kWriteAccumulator  [kConstantPoolIndex, kFeedbackSlot, kFlag8]
  Return                 0xb7  kReadAccumulator  []
  short-star range: Star15=0xc3 .. Star0=0xd2
  Illegal                0xd3
```

### 3.2 14.4 vs 14.6 opcode diff

```
=== DIFF 14.4.258.16 -> 14.6.202.34 ===
  count: 212 -> 212
  removed in 14.6.202.34 (0): (none)
  added   in 14.6.202.34 (0): (none)
  renumbered opcodes (0)
  operand types added  : kEmbeddedFeedback
  signature changed (6):
    TestEqual:              kReadWriteAccumulator[kReg,kFeedbackSlot] -> [kReg,kEmbeddedFeedback]
    TestEqualStrict:        kReadWriteAccumulator[kReg,kFlag16]        -> [kReg,kEmbeddedFeedback]
    TestLessThan:           kReadWriteAccumulator[kReg,kFeedbackSlot] -> [kReg,kEmbeddedFeedback]
    TestGreaterThan:        kReadWriteAccumulator[kReg,kFeedbackSlot] -> [kReg,kEmbeddedFeedback]
    TestLessThanOrEqual:    kReadWriteAccumulator[kReg,kFeedbackSlot] -> [kReg,kEmbeddedFeedback]
    TestGreaterThanOrEqual: kReadWriteAccumulator[kReg,kFeedbackSlot] -> [kReg,kEmbeddedFeedback]
```

**Opcode numbering is identical between the two tags.** The `BYTECODE_LIST` macro
diff is exactly those six entries; verified by grep on the two cached files:

```
# 14.4.258.16 src/interpreter/bytecodes.h:328-340
  V(TestEqual, ImplicitRegisterUse::kReadWriteAccumulator, OperandType::kReg,  \
    OperandType::kFeedbackSlot)                                                \
  V(TestEqualStrict, ImplicitRegisterUse::kReadWriteAccumulator,               \
    OperandType::kReg, OperandType::kFlag16)                                   \
# 14.6.202.34 src/interpreter/bytecodes.h:329-339
  V(TestEqual, ImplicitRegisterUse::kReadWriteAccumulator, OperandType::kReg,  \
    OperandType::kEmbeddedFeedback)                                            \
  V(TestEqualStrict, ImplicitRegisterUse::kReadWriteAccumulator,               \
    OperandType::kReg, OperandType::kEmbeddedFeedback)                         \
```

and the new type:

```c
// 14.6.202.34 src/interpreter/bytecode-operands.h:46
  V(EmbeddedFeedback, OperandTypeInfo::kFixedUnsignedShort)
```

This matters for a decoder far more than the name change suggests:
`kFeedbackSlot` is `kScalableUnsignedByte` (1/2/4 bytes depending on prefix)
while `kEmbeddedFeedback` is `kFixedUnsignedShort` (always 2). **A 14.4 table
mis-measures the length of `TestLessThan` etc. in 14.6 bytecode and vice versa**,
so the table must be per-version, not shared across 14.x.

14.6 also adds a predicate worth mirroring:

```c
// 14.6.202.34 src/interpreter/bytecodes.h:909-921
  static constexpr bool IsCompareWithEmbeddedFeedback(Bytecode bytecode) { ... }
  static constexpr bool IsEmbeddedFeedbackBytecode(Bytecode bytecode) {
    return IsCompareWithEmbeddedFeedback(bytecode);
  }
```

### 3.3 (b) Serializer/deserializer tags — fully derivable, identical across tags

`derive_tables.mjs` parses `enum Bytecode : uint8_t { … }` in
`src/snapshot/serializer-deserializer.h`, honouring explicit `= 0x40` anchors and
auto-incrementing otherwise. Identical result for both tags:

```
## SerializerDeserializer::Bytecode (35 tags)
kNewObject=0x0  kBackref=0x4  kReadOnlyHeapRef=0x5  kStartupObjectCache=0x6
kRootArray=0x7  kAttachedReference=0x8  kSharedHeapObjectCache=0x9  kNop=0xa
kSynchronize=0xb  kVariableRepeatRoot=0xc  kOffHeapBackingStore=0xd
kOffHeapResizableBackingStore=0xe  kEmbedderFieldsData=0xf
kApiWrapperFieldsData=0x10  kVariableRawData=0x11  kApiReference=0x12
kExternalReference=0x13  kSandboxedApiReference=0x14
kSandboxedExternalReference=0x15  kSandboxedRawExternalReference=0x16
kClearedWeakReference=0x17  kWeakPrefix=0x18  kRegisterPendingForwardRef=0x19
kResolvePendingForwardRef=0x1a  kNewContextlessMetaMap=0x1b
kNewContextfulMetaMap=0x1c  kIndirectPointerPrefix=0x1d
kInitializeSelfIndirectPointer=0x1e  kAllocateJSDispatchEntry=0x1f
kJSDispatchEntry=0x20  kProtectedPointerPrefix=0x21
kRootArrayConstants=0x40  kFixedRawData=0x60  kFixedRepeatRoot=0x80  kHotObject=0x90

constants: {"kRootArrayConstantsCount":"0x20","kFixedRawDataCount":"0x20",
            "kFixedRepeatRootCount":"0x10","kHotObjectCount":"8",
            "kFirstEncodableFixedRawDataSize":"1","kFirstEncodableRepeatRootCount":"2",
            "kDoubleAlignmentSentinel":"0","kEmptyBackingStoreRefSentinel":"0"}
kNumberOfSnapshotSpaces = 4

## DIFF: count 35 -> 35, value changed (none), removed (none), added (none)
```

`kNewObject` occupies `0x00..0x03` (one per snapshot space) because of
`SpaceEncoder<kNewObject> = BytecodeValueEncoder<kNewObject, 0, kNumberOfSnapshotSpaces - 1, …>`;
the `static_assert(4 == kNumberOfSnapshotSpaces)` in the same header is the
machine-readable anchor for that. The ranged tags decode as
`value = byte - kBytecode + kMinValue` per `BytecodeValueEncoder::Decode`.

### 3.4 (c) Root list — partially derivable; two concrete blockers

`derive_tables.mjs` expands `ROOT_LIST(ENTRY)` using a mini-preprocessor with
`IF_WASM(V, ...) → V(__VA_ARGS__)` etc. Result:

```
                       14.4.258.16   14.6.202.34
READ_ONLY_ROOT_LIST         870           874
MUTABLE_ROOT_LIST           105           107
ROOT_LIST (total)           975           981
StaticReadOnlyRootsPointerTable (intl+wasm)  1045   1049
```

The first 187 entries agree positionally with the static-roots table, then drift.
`root_gap_probe.mjs` accounts for the entire 222-entry shortfall:

```
## is each generator macro present in the checked-in headers?
  TORQUE_DEFINED_MAP_ROOT_LIST        *** NOT DEFINED IN CHECKED-IN SOURCE ***
  (everything else: defined)

## how the INTL string list is wired in
  L8:   #ifdef V8_INTL_SUPPORT
  L9:   #define INTERNALIZED_STRING_LIST_GENERATOR_INTL(V, _)  \   <- 142 strings
  L152: #else
  L153: #define INTERNALIZED_STRING_LIST_GENERATOR_INTL(V, _)      <- empty
  L154: #endif
  L568: INTERNALIZED_STRING_LIST_GENERATOR_INTL(V, _)

## where does TORQUE_DEFINED_MAP_ROOT_LIST come from?
  src/roots/roots.h: 1 reference(s) (use only, no definition)
  src/objects/instance-type.h includes torque-generated/instance-types.h : true
  fetching torque-generated/instance-types.h -> HTTP 404 (absent: it is a build artifact)

## present in static table but NOT in the naive expansion: 222
  by kind: {"_string":142,"other":1,"Map":79}
```

So:

1. **142 missing `*_string` roots** = the whole ICU/Intl internalized-string list.
   My expander keeps the *last* `#define` of a doubly-defined macro, i.e. the
   empty `#else` body. Fix: evaluate `#ifdef V8_INTL_SUPPORT` /
   `#ifdef V8_ENABLE_WEBASSEMBLY` properly (a ~100-line `#if` evaluator, or
   `pcpp`, which is what `tools/compare_roots.py` already reaches for). **Fully
   derivable once conditionals are honoured.**
2. **79 missing `*Map` roots** = `TORQUE_DEFINED_MAP_ROOT_LIST`, which Torque
   emits into `torque-generated/instance-types.h`. That path 404s in the repo.
   Options: (i) run Torque over `src/objects/*.tq` (needs a build), (ii) derive
   the list from the `.tq` class declarations, or (iii) read the names out of the
   target binary — i.e. exactly what `build_canonical_roots.py` did. **Not
   derivable from checked-in source alone.**

Cross-tag root diff, for pluggability:

```
## roots  read-only: 870 -> 874   total: 975 -> 981
   removed (0):
   added   (6): Deferred_Module_string immutable_string detached_symbol
                prototype_shared_closure_info_map module_namespace_property_accessor
                lazy_closure_accessor
   first index where the root order diverges: 504 (defineProperty_string vs Deferred_Module_string)
```

Root *indices shift from 504 onward* between 14.4 and 14.6, so the root table is
hard version-specific — unlike the opcode table, which is stable across these two.

### 3.5 (d) `static-roots.h` offsets

Since ≥14.2 the table lives in one of four variant headers. Pick by build config:
Electron/Chromium x64 is `V8_INTL_SUPPORT` + `V8_ENABLE_WEBASSEMBLY` →
`src/roots/static-roots-intl-wasm.h` (1045 ordered entries at 14.4.258.16,
1049 at 14.6.202.34). The variant choice matters a lot: resolving the corpus's
read-only refs against the wrong variant drops the hit rate from 22.9 % to 4-10 %
(§4.2).

Note also that the ordered `StaticReadOnlyRootsPointerTable` at the bottom of
those files **is** `READ_ONLY_ROOT_LIST` in order, so its length equals
`ReadOnlyRoots::kEntriesCount`. That was confirmed independently: the locally
minted non-static-roots snapshot writes exactly 1049 `uint32` root entries for
V8 14.6.202.34, matching the 1049 names in `static-roots-intl-wasm.h@14.6.202.34`
(§4.4). So the ordered table is a usable source of `kEntriesCount` and of the
canonical root ordering even for builds that don't use static roots.

### 3.6 (e) Object field offsets

There are **two** layout mechanisms in 14.x and you need both.

**Mechanism 1 — hand-written `FIELD_LIST` + `DEFINE_FIELD_OFFSET_CONSTANTS`.**
The accumulation rule is exact, from `src/utils/utils.h`:

```c
#define DEFINE_ONE_FIELD_OFFSET(Name, Size, ...) \
  Name, Name##End = Name + (Size)-1,
#define DEFINE_FIELD_OFFSET_CONSTANTS(StartOffset, LIST_MACRO) \
  enum {                                                       \
    LIST_MACRO##_StartOffset = StartOffset - 1,                \
    LIST_MACRO(DEFINE_ONE_FIELD_OFFSET)                        \
  };
#define FIELD_SIZE(Name) (Name##End + 1 - Name)
```

Because it is a plain C enum, `offset(field[k+1]) = offset(field[k]) + size(field[k])`,
seeded at `StartOffset`. There is **no automatic alignment** — padding is explicit,
written as a zero-named field whose size is `OBJECT_POINTER_PADDING(...)`.

`BytecodeArray` (`src/objects/bytecode-array.h:133-149`, identical at both tags):

```c
#define FIELD_LIST(V)                                                   \
  V(kLengthOffset, kTaggedSize)                                         \
  V(kWrapperOffset, kTaggedSize)                                        \
  V(kSourcePositionTableOffset, kTaggedSize)                            \
  V(kHandlerTableOffset, kTaggedSize)                                   \
  V(kConstantPoolOffset, kTaggedSize)                                   \
  V(kFrameSizeOffset, kInt32Size)                                       \
  V(kParameterSizeOffset, kUInt16Size)                                  \
  V(kMaxArgumentsOffset, kUInt16Size)                                   \
  V(kIncomingNewTargetOrGeneratorRegisterOffset, kInt32Size)            \
  V(kOptionalPaddingOffset, 0)                                          \
  V(kUnalignedHeaderSize, OBJECT_POINTER_PADDING(kUnalignedHeaderSize)) \
  V(kHeaderSize, 0)                                                     \
  V(kBytesOffset, 0)
  DEFINE_FIELD_OFFSET_CONSTANTS(ExposedTrustedObject::kHeaderSize, FIELD_LIST)
```

Computed by `derive_tables.mjs` with `kTaggedSize = 4` (pointer compression on,
like the QQ build), relative to `ExposedTrustedObject::kHeaderSize`:

```
kLengthOffset=+0  kWrapperOffset=+4  kSourcePositionTableOffset=+8
kHandlerTableOffset=+12  kConstantPoolOffset=+16  kFrameSizeOffset=+20
kParameterSizeOffset=+24  kMaxArgumentsOffset=+26
kIncomingNewTargetOrGeneratorRegisterOffset=+28
kOptionalPaddingOffset=+32  kUnalignedHeaderSize=+32  kHeaderSize=+32  kBytesOffset=+32
```

(`OBJECT_POINTER_PADDING` is 0 here because 32 is already 8-aligned; under
`kTaggedSize = 8` the five tagged fields become 40 bytes and the padding fires.)

`FixedArrayBase` is even simpler — plain constants in
`src/objects/fixed-array.h:387-388`:

```c
  static constexpr int kLengthOffset = HeapObject::kHeaderSize;
  static constexpr int kHeaderSize = kLengthOffset + kTaggedSize;
```

with element addressing from `src/objects/fixed-array.h:181-187`:

```c
  static inline constexpr int SizeFor(int capacity) {
    return sizeof(Header) + capacity * kElementSize;
  }
  static inline constexpr int OffsetOfElementAt(int index) { return SizeFor(index); }
```

**Mechanism 2 — Torque `.tq` field lists.** For `@cppObjectLayoutDefinition` /
`@cppObjectDefinition` classes without a `FIELD_LIST`, the layout is generated into
`torque-generated/src/objects/<name>-tq.inc`, which is a build artifact. But the
field *order* and the conditionals are fully specified in the checked-in `.tq`, and
the rule is mechanical:

* fields are laid out in declaration order, starting at the parent class's size;
* `HeapObject` contributes the map word (`kTaggedSize`); `Smi`, `Object`,
  `String`, `FixedArray`, `ProtectedPointer<T>`, `TrustedPointer<T>` are all one
  tagged slot (**4 bytes** under pointer compression, 8 without);
* `int32`/`uint32`/`float64`/`uint16`/`uint8` take their natural size;
* `@if(TAGGED_SIZE_8_BYTES) optional_padding: uint32` is the standard
  "re-align after an odd number of 4-byte fields when tagged size is 8" idiom —
  it is *present* only when `kTaggedSize == 8`;
* `name[count]: T` is an indexed (variable-length) region placed after all the
  fixed fields, so everything after it is reachable only by computing `count`;
* `name?[cond]: T` is an optional slot — present only when `cond` holds — so
  offsets past the first optional field are **data-dependent**, not static;
* the whole object is then `OBJECT_POINTER_ALIGN`ed (8 bytes).

Verified field lists, fetched live:

`src/objects/bytecode-array.tq` @14.4.258.16 — matches the `FIELD_LIST` above
one-for-one, which is the cross-check that the rule is right:

```
extern class BytecodeArray extends ExposedTrustedObject {
  const length: Smi;
  wrapper: BytecodeWrapper;
  source_position_table: ProtectedPointer<TrustedByteArray>;
  handler_table: ProtectedPointer<TrustedByteArray>;
  constant_pool: ProtectedPointer<TrustedFixedArray>;
  frame_size: int32;
  parameter_size: uint16;
  max_arguments: uint16;
  incoming_new_target_or_generator_register: int32;
  @if(TAGGED_SIZE_8_BYTES) optional_padding: uint32;
  @ifnot(TAGGED_SIZE_8_BYTES) optional_padding: void;
  bytes[length]: uint8;
}
```

`src/objects/scope-info.tq` @14.4.258.16 — the interesting one, because almost
everything after the fixed prefix is conditional:

```
extern class ScopeInfo extends HeapObject {
  @cppRelaxedLoad @cppRelaxedStore const flags: ScopeFlags;        // uint32 bitfield
  @if(TAGGED_SIZE_8_BYTES) optional_padding: uint32;
  parameter_count: Smi;
  const context_local_count: Smi;
  position_info: PositionInfo;                                     // {start: Smi, end: Smi}
  const module_variable_count?[flags.scope_type == ScopeType::MODULE_SCOPE]: Smi;
  context_local_names[ context_local_count < kMaxInlinedLocalNamesSize
                       ? context_local_count : 0 ]: String;
  context_local_names_hashtable?[kMaxInlinedLocalNamesSize <= context_local_count]:
      NameToIndexHashTable;
  context_local_infos[context_local_count]: SmiTagged<VariableProperties>;
  saved_class_variable_info?[flags.has_saved_class_variable]: Smi|Name;
  function_variable_info?[flags.function_variable != VariableAllocationInfo::NONE]:
      FunctionVariableInfo;                                        // {name, context_or_stack_slot_index}
  inferred_function_name?[flags.has_inferred_function_name]: String|Undefined;
  outer_scope_info?[flags.has_outer_scope_info]: ScopeInfo;
  module_info?[flags.scope_type == ScopeType::MODULE_SCOPE]: SourceTextModuleInfo;
  module_variables[... module_variable_count ...]: ModuleVariable; // {name, index, properties}
  dependent_code?[flags.sloppy_eval_can_extend_vars]: DependentCode;
  const unused_parameter_bits?[flags.scope_type == ScopeType::FUNCTION_SCOPE]: Smi;
}
```

`src/objects/literal-objects.tq` @14.4.258.16:

```
extern class ObjectBoilerplateDescription extends HeapObject {
  const length: Smi;  backing_store_size: Smi;  flags: Smi;  raw_entries[length]: Object;
}
extern class ArrayBoilerplateDescription extends Struct {
  flags: Smi;  constant_elements: FixedArrayBase;
}
extern class RegExpBoilerplateDescription extends Struct {
  data: TrustedPointer<RegExpData>;  source: String;  flags: SmiTagged<JSRegExpFlags>;
}
```

`src/objects/template-objects.tq` @14.4.258.16:

```
extern class TemplateObjectDescription extends Struct {
  raw_strings: FixedArray;  cooked_strings: FixedArray;
}
```

`src/objects/shared-function-info.tq` @14.4.258.16 (`SharedFunctionInfo` and the
`UncompiledData` hierarchy):

```
extern class SharedFunctionInfo extends HeapObject {
  @customWeakMarking trusted_function_data: TrustedPointer<ExposedTrustedObject>;
  untrusted_function_data: Object;
  name_or_scope_info: String|NoSharedNameSentinel|ScopeInfo;
  outer_scope_info_or_feedback_metadata: ScopeInfo|FeedbackMetadata|TheHole;
  script: Script|Undefined;
  length: uint16;
  formal_parameter_count: uint16;
  function_token_offset: uint16;
  expected_nof_properties: uint8;
  flags2: SharedFunctionInfoFlags2;      // uint8
  flags: SharedFunctionInfoFlags;        // uint32
  function_literal_id: int32;
  unique_id: int32;
  age: uint16;
  padding: uint16;
}
@abstract extern class UncompiledData extends ExposedTrustedObject {
  inferred_name: String;  start_position: int32;  end_position: int32;
}
extern class UncompiledDataWithoutPreparseData extends UncompiledData {}
extern class UncompiledDataWithPreparseData extends UncompiledData { preparse_data: PreparseData; }
extern class UncompiledDataWithoutPreparseDataWithJob extends UncompiledDataWithoutPreparseData { job: RawPtr; }
extern class UncompiledDataWithPreparseDataAndJob extends UncompiledDataWithPreparseData { job: RawPtr; }
```

`src/objects/fixed-array.tq` @14.4.258.16 gives `FixedArray`, `TrustedFixedArray`,
`ProtectedFixedArray`, `ByteArray` and — relevant to the handler table —
**`TrustedByteArray`**:

```
extern class TrustedByteArray extends TrustedObject {
  const length: Smi;  values[length]: uint8;
}
```

The bitfield structs (`ScopeFlags`, `VariableProperties`,
`SharedFunctionInfoFlags`, `SharedFunctionInfoFlags2`) are also fully specified in
the same `.tq` files as `bitfield struct … { field: Type: N bit; }`, allocated
LSB-first in declaration order, so they are mechanically derivable too.

Supporting constant: `kScopeInfoMaxInlinedLocalNamesSize = 75`
(`src/common/globals.h`), referenced from `scope-info.tq` as
`const kMaxInlinedLocalNamesSize: constexpr int32 generates 'kScopeInfoMaxInlinedLocalNamesSize';`.

`ScopeInfo` also still carries a *slot-index* enum in the C++ header
(`src/objects/scope-info.h:288-295`), which is the fixed prefix in tagged slots:

```c
  enum Fields {
    kFlags, kParameterCount, kContextLocalCount,
    kPositionInfoStart, kPositionInfoEnd,
    kVariablePartIndex
  };
```

### 3.7 SourcePositionTable encoding

Defined in `src/codegen/source-position-table.cc` (fetched at 14.4.258.16), and
the file's own comment states the scheme:

```c
// - code_offset: An integer index into the BytecodeArray or code.
// - source_position: An integer index into the source string.
// - position type: Each position is either a statement or an expression.
//   ... variable-length integer coding, each byte 7 bits payload + 1 'more' bit,
//   ... difference from the previous position, LSB first, zig-zag for signed.
using MoreBit  = base::BitField8<bool, 7, 1>;
using ValueBits = base::BitField8<unsigned, 0, 7>;
```

Decoder, verbatim:

```c
void DecodeEntry(base::Vector<const uint8_t> bytes, int* index,
                 PositionTableEntry* entry) {
  int tmp = DecodeUInt<int>(bytes, index);
  entry->code_offset = tmp >> 2;
  entry->is_breakable = (tmp & 0b10) >> 1;
  entry->is_statement = tmp & 1;
  entry->source_position = DecodeInt<int64_t>(bytes, index);
}
T DecodeInt(...) {            // zig-zag
  unsigned_type z = DecodeUInt<unsigned_type>(bytes, index);
  return static_cast<T>((z >> 1) ^ (-(z & 1)));
}
```

and entries are *deltas*: `AddAndSetEntry` adds both `code_offset` and
`source_position` of each entry to the running value. The table lives in
`BytecodeArray::source_position_table` as a `TrustedByteArray` (so: `length` Smi
then raw bytes).

### 3.8 Exception handler table encoding

`src/codegen/handler-table.h` @14.4.258.16:

```c
// 1) Based on ranges: Used for unoptimized code. Stored in a
//   {TrustedByteArray} that is attached to each {BytecodeArray}. Layout:
//      [ range-start , range-end , handler-offset , handler-data ]
  static const int kRangeStartIndex = 0;
  static const int kRangeEndIndex = 1;
  static const int kRangeHandlerIndex = 2;
  static const int kRangeDataIndex = 3;
  static const int kRangeEntrySize = 4;
  using HandlerPredictionField = base::BitField<CatchPrediction, 0, 3>;
  using HandlerWasUsedField = HandlerPredictionField::Next<bool, 1>;
  using HandlerOffsetField = HandlerWasUsedField::Next<int, 28>;
```

So: four `int32` per entry; the third is a bitfield —
prediction in bits 0..2 (`UNCAUGHT, CAUGHT, PROMISE, ASYNC_AWAIT,
UNCAUGHT_ASYNC_AWAIT`), "was used" at bit 3, handler bytecode offset in bits
4..31.

### 3.9 Targeting 14.6.202.34 with the same generator

Everything above works unchanged at the 14.6 tag; `gen_bytecode_table.mjs` and
`derive_tables.mjs` both take the tag as `argv`. The deltas a generator must
handle:

* opcode table: same 212 values, but 6 operand-type changes and 1 new operand
  type (§3.2) → different instruction lengths;
* roots: +6 roots, order diverges from index 504 → root indices are not portable;
* serializer tags: no change;
* `src/roots/static-roots.h` is the same 4-variant dispatcher at both tags.
