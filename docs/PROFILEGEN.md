# profilegen — generating a V8 profile from source

`tools/profilegen/` fetches pinned upstream V8 sources and emits
`profiles/<tag>/`: ten JSON tables that fully describe one V8 build's bytecode
encoding, heap object layouts, root order and read-only addresses. No table is
transcribed by hand, nothing is scraped from a binary, and nothing is padded to
make a count match.

```
node tools/profilegen/index.mjs --tag 14.4.258.16 --variant intl+wasm --tagged-size 4 --out profiles/
node tools/profilegen/selftest.mjs
node tools/profilegen/diff.mjs 14.4.258.16 14.6.202.34 --out profiles/DIFF-14.4-vs-14.6.md
```

Node ESM, no Python, no depot_tools, no build of V8.

---

## 1. Adding a new V8 version

1. **Check the tag exists.** `profilegen` does this for you before fetching;
   it probes `https://chromium.googlesource.com/v8/v8/+/refs/tags/<tag>?format=JSON`.
   Use an immutable four-component tag (`14.4.258.16`), not a branch head.

2. **Run the generator.**

   ```
   node tools/profilegen/index.mjs --tag <a.b.c.d> --variant intl+wasm --tagged-size 4 --out profiles/
   ```

   First run for a tag fetches ~280 files: a handful of headers individually,
   and the `.tq` sources as seven directory archives (gitiles `+archive`), so
   the whole `.tq` universe costs seven requests rather than 246. Everything
   lands in `.v8src-cache/<tag>/` (gitignored) and is reused thereafter.
   `--offline` fails instead of fetching.

3. **Read the log.** It prints the counts and the root-order agreement. The line
   you care about is

   ```
   roots: 1150 total (1045 read-only); static table 1045; agreement 1045/1045
   ```

   Anything less than `N/N` means a build-config flag is wrong for that tag
   (see §4). The generator does *not* silently paper over it: it writes the
   derived table as-is and records `unresolved.unresolvedRoots` in `meta.json`
   with the residual count and the first divergent index.

4. **Run the self-test.** `node tools/profilegen/selftest.mjs --tag <a.b.c.d>`
   asserts the root-order agreement, the `BytecodeArray` offsets, the
   `.tq` ↔ `FIELD_LIST` cross-checks, the decoder-level invariants and (for
   14.4.258.16) the checked-in opcode oracle. It prints a pass/fail table and
   exits non-zero on any failure.

5. **Diff against the nearest existing profile** so the delta is on the record:
   `node tools/profilegen/diff.mjs <old> <new> --out profiles/DIFF-<old>-vs-<new>.md`.

6. **Consume it** through `src/profile/index.mjs`:

   ```js
   import { loadProfileForVersion } from './src/profile/index.mjs';
   const p = loadProfileForVersion('14.4.258.16');   // validates + verifies sha256s
   p.getOpcode(0x33);              // { name: 'GetNamedProperty', operands: [...] }
   p.operandSize('kReg', 4);       // 4   (scalable, ExtraWide)
   p.getRoot(5);                   // { cppName: 'empty_string', kind: 'string', value: '' }
   p.resolveRoRef(0, 3528);        // { address: 0xdc9, cppName: 'prototype_string', ... }
   p.layoutOf('ScopeInfo');        // the layout program
   p.runtimeName(157);             // the real name behind __runtime_157(...)
   p.intrinsicName(0);             // 'AsyncFunctionAwait'
   p.constants.handlerTable;       // 4 int32 per entry + the bitfield layout
   ```

### If a new tag does not reach N/N root agreement

The failure is almost always one of three things, in decreasing likelihood:

* **A new `#if` guard in `roots.h` or `heap-symbols.h`** whose macro is not in
  the defines map. Check `meta.json → unresolved.unknownConditionIdentifiers`:
  anything there evaluated to 0 by the C rule. If it gates list content rather
  than a compiler attribute, add it to `resolveGnFlags`/`buildDefines` in
  `tools/profilegen/config.mjs` with a citation.
* **A new Torque build flag.** `gen/buildflags.mjs` derives the flag table from
  `src/torque/torque-parser.cc`'s `class BuildFlags`, so new flags normally
  appear by themselves; if one resolves through a macro we do not know it lands
  in `unresolved.torqueBuildFlags`.
* **A new generator macro used in `roots.h` but defined in a header we do not
  read.** `ROOT_HEADERS` in `gen/roots.mjs` is the list; the symptom is a
  non-empty `unexpandedMacros`.

---

## 2. What each table is derived from

All paths are relative to the V8 repo root at `refs/tags/<tag>`.

| output | derived from | rule |
|---|---|---|
| `bytecodes.json` | `src/interpreter/bytecodes.h` | opcode value = index in the fully expanded `BYTECODE_LIST`, per `enum class Bytecode : uint8_t`. `kFirstShortStar`/`kLastShortStar` give the short-star range. |
| `operands.json` | `src/interpreter/bytecode-operands.h` | `OPERAND_TYPE_LIST` maps each type to an `OperandTypeInfo`; `OPERAND_TYPE_INFO_LIST(V)` → `V(Name, IsScalable, IsUnsigned, UnscaledSize)` gives the four classes; `enum class OperandSize` gives the byte widths; `OPERAND_SCALE_LIST` gives 1/2/4. |
| `serializer-tags.json` | `src/snapshot/serializer-deserializer.h` | the `enum Bytecode : uint8_t` read as C reads it (explicit `= 0x40` anchors restart the count). Ranged-tag widths from the `*Count` constants; `kNewObject` spans `kNumberOfSnapshotSpaces`, anchored by the file's own `static_assert`. |
| `roots.json` | `src/roots/roots.h`, `src/init/heap-symbols.h`, `src/objects/objects-definitions.h`, `src/builtins/accessors.h`, `src/base/macros.h`, plus the derived `TORQUE_DEFINED_MAP_ROOT_LIST` | root index = position in the fully expanded `ROOT_LIST`, because `enum class RootIndex : uint16_t { ROOT_LIST(DECL) ... }`. `READ_ONLY_ROOT_LIST` is its prefix. |
| `static-roots.json` | `src/roots/static-roots-<variant>.h` | `StaticReadOnlyRoot::k<CamelName>` → `Tagged_t`, plus the ordered `StaticReadOnlyRootsPointerTable`, which *is* `READ_ONLY_ROOT_LIST` in order. |
| `layouts.json` | `src/objects/*.tq` and the `FIELD_LIST` blocks in `src/objects/*.h` | two mechanisms, see §3. |
| `runtime.json` | `src/runtime/runtime.h` | `enum FunctionId : int32_t { FOR_EACH_INTRINSIC(F) FOR_EACH_INLINE_INTRINSIC(I) }`, with `F`→`k##name` and `I`→`kInline##name`. |
| `intrinsics.json` | `src/interpreter/interpreter-intrinsics.h` | `INTRINSICS_LIST(V)` → `V(Name, lower_case, argc)`; the id is the position. |
| `constants.json` | `include/v8-internal.h`, `src/common/globals.h`, `src/heap/memory-chunk.h`, `src/heap/memory-chunk-layout.h`, `src/codegen/handler-table.h`, `src/codegen/source-position-table.cc`, `src/snapshot/code-serializer.h`, `src/snapshot/snapshot-data.h` | see §5. |
| `meta.json` | — | tag, variant, `kTaggedSize`, the resolved GN flags, the C++ defines map, the Torque build flags, every consumed source file with its URL and sha256, the generator version, the timestamp, the acceptance results, and `unresolved`. |

### The two hard derivations

**`TORQUE_DEFINED_MAP_ROOT_LIST` does not exist in the repository.** Torque
writes it into `torque-generated/instance-types.h` at build time (that path 404s
upstream). `tools/profilegen/torque.mjs` reproduces it from the `.tq` sources
using the Torque compiler's own rules:

* *which classes* — `src/torque/instance-type-generator.cc`:
  ```cpp
  for (const ClassType* type : TypeOracle::GetClasses())
    if (type->ShouldGenerateUniqueMap())
      torque_defined_map_root_list << "  V(Map, " << lower_case_name << "_map, "
                                   << upper_case_name << "Map) \\\n";
  ```
  with `src/torque/types.h`:
  ```cpp
  bool ShouldGenerateUniqueMap() const {
    return (flags_ & ClassFlag::kGenerateUniqueMap) || (!IsExtern() && !IsAbstract());
  }
  ```
  and `SnakeifyString` from `src/torque/utils.cc`.
* *in what order* — `TypeOracle::GetClasses()` (`src/torque/type-oracle.cc`)
  returns the `ClassType`s of `aggregate_types_` in **creation** order. Creation
  happens inside `TypeVisitor::ComputeType`, driven by
  `PredeclarationVisitor::ResolvePredeclarations()` walking every predeclared
  type alias in declaration order — files in `BUILD.gn`'s `torque_files` order —
  and resolving it. Resolution is recursive, so a declaration's eagerly-resolved
  type references are created *before* it:

  | declaration | what it resolves eagerly (`src/torque/type-visitor.cc`) |
  |---|---|
  | `class` / `shape` | `decl->super` only — field types are lazy (`ClassType::Finalize`) |
  | `type X = EXPR;` | the whole right-hand type expression, so every union member |
  | `type X extends Y;` | `Y` |
  | `struct X { … }` | every field type, eagerly |
  | `bitfield struct X extends B` | `B` and every field type |

  This is why `FunctionTemplateInfoMap` is the **first** Torque map root even
  though `templates.tq` is near the end of `torque_files`:
  `src/builtins/base.tq:1088` declares
  `type … = Context|EmptyString|Symbol|FunctionTemplateInfo|WasmFuncRef|WasmNull;`
  and resolving that alias creates `FunctionTemplateInfo`'s `ClassType` right
  there. Modelling only parent-before-child gets 1040/1045; modelling the full
  eager-reference rule gets 1045/1045.

**The 142 missing Intl string roots** were a preprocessor bug, not a source gap.
`src/init/heap-symbols.h` defines `INTERNALIZED_STRING_LIST_GENERATOR_INTL`
twice — 142 entries under `#ifdef V8_INTL_SUPPORT`, empty in the `#else`.
Collecting `#define`s without evaluating conditionals keeps the last one.
`tools/profilegen/cpp.mjs` is a real conditional evaluator
(`#if`/`#ifdef`/`#ifndef`/`#else`/`#elif`/`#endif`, `defined()`, full integer
constant expressions, `##` pasting, `#` stringising, `__VA_ARGS__`), and
`#define`s are only collected inside active regions.

One more root was lost to a subtler bug worth recording: `heap-symbols.h`
contains `V_(_, close_parenthesis_string, ")")`, and a paren matcher that counts
the `)` inside the string literal swallows the following entry whole. `matchParen`
in `cpp.mjs` skips string and char literals for exactly this reason.

---

## 3. Object layouts

Both of V8's layout mechanisms are supported, and where a class has both, they
are cross-checked against each other.

**Mechanism 1 — `FIELD_LIST` + `DEFINE_FIELD_OFFSET_CONSTANTS`** (`src/utils/utils.h`):

```c
#define DEFINE_ONE_FIELD_OFFSET(Name, Size, ...) Name, Name##End = Name + (Size)-1,
#define DEFINE_FIELD_OFFSET_CONSTANTS(StartOffset, LIST_MACRO) \
  enum { LIST_MACRO##_StartOffset = StartOffset - 1, LIST_MACRO(DEFINE_ONE_FIELD_OFFSET) };
```

A plain C enum, so `offset(f[k+1]) = offset(f[k]) + size(f[k])` seeded at
`StartOffset`, with **no automatic alignment** — padding is an explicit
zero-named field sized `OBJECT_POINTER_PADDING(...)`.

Headers `#define FIELD_LIST`, use it, then `#undef` it, several times per file.
The generator therefore expands each list **where it is used**, via an
`onLine` hook on the preprocessor that exposes the macro table at that point.

**Mechanism 2 — Torque `.tq` field lists.** `src/torque/type-visitor.cc`:

```cpp
ResidueClass class_offset = super_class ? super_class->size() : 0;
for (field : class_declaration->fields) { … class_offset += field_size; }
```

Same running sum, seeded at the parent class's size, again with no automatic
alignment (`ValidateAlignment` only *checks*). Field sizes come from
`SizeOf(const Type*)` in `src/torque/types.cc`: tagged types and
`ProtectedPointer<T>` are `kTaggedSize`; `TrustedPointer<T>` is
`kTrustedPointerSize`; `RawPtr`/`intptr` are `kSystemPointerSize`;
`int8`…`float64` take their natural size; `void` is 0; a `struct` is its packed
size; a `bitfield struct` is the size of the integer it extends.

`@if(FLAG)` / `@ifnot(FLAG)` fields are filtered **at parse time**, exactly as
`MakeClassDeclaration` does. Dropped fields are recorded in
`layouts.json → classes.<X>.droppedFields` with the flag and the value chosen,
because a build-config-gated field that is absent shifts every offset after it,
and that decision has to be visible rather than implied.

### Layout programs, not flat tables

A class is only given flat `offsets` when every offset is a build-time constant.
Otherwise `layouts.json` carries an ordered **field program**:

* `present: true` — always there.
* `present: "conditional"` — a `name?[cond]: T` field. `condition.expr` is the
  Torque source text and `condition.ast` is a parsed tree over the object's own
  bitfields and the Torque enums, both of which are in the same file
  (`layouts.json → bitfields`, `→ enums`). Every field after the first
  conditional one has `offset: null`.
* `indexed: true` — a `name[count]: T` region, with `elementSize` and `count`
  (literal count folded into the offsets; anything else makes the rest
  data-dependent).

`ScopeInfo` is the case that forces this: 14 fields, 7 conditional, 2 indexed, 8
with data-dependent offsets. A flat offset table for `ScopeInfo` is simply
wrong, which is why `layoutOf('ScopeInfo').offsets` does not exist.

When Torque declares no layout at all — `extern class FeedbackMetadata extends
HeapObject;`, i.e. `ClassFlag::kUndefinedLayout` — the `FIELD_LIST` is promoted
into the same field-program shape and `layoutSource` says `"FIELD_LIST"`. There
is nothing to cross-check in that case and `crossCheck.skipped` says so.

### The cross-check

For `BytecodeArray` at `kTaggedSize = 4`, relative to
`ExposedTrustedObject::kHeaderSize`:

```
length=+0  wrapper=+4  source_position_table=+8  handler_table=+12
constant_pool=+16  frame_size=+20  parameter_size=+24  max_arguments=+26
incoming_new_target_or_generator_register=+28  headerSize=+32
```

Both derivations produce exactly this, independently: `src/objects/bytecode-array.tq`
through the Torque rule, and `src/objects/bytecode-array.h`'s `FIELD_LIST`
through the enum rule. 12 fields compared, 0 mismatches. That agreement is the
evidence that both rules are implemented right; the self-test asserts it.

The anchor values (`ExposedTrustedObject::kHeaderSize` = 8 at
`kTaggedSize = 4` with the sandbox on) are themselves derived from the Torque
class hierarchy, not typed in.

---

## 4. Build-config assumptions, with citations

Every one of these is a claim about how the *target binary* was compiled.
Line numbers are for `BUILD.gn` at 14.4.258.16. They are all recorded in
`meta.json → gnFlags` and `meta.json → cppDefines`.

### Derived from GN's own logic

| flag | value | GN derivation |
|---|---|---|
| `v8_enable_pointer_compression` | true | implied by `--tagged-size 4` |
| `v8_enable_pointer_compression_shared_cage` | true | L580: defaults to pointer compression |
| `v8_enable_external_code_space` | **true** | L603-608: `pointer_compression && shared_cage && cpu in {x64, arm64, loong64, riscv64}` |
| `v8_enable_sandbox` | **true** | L674-681: `shared_cage && external_code_space && os != fuchsia` |
| `v8_enable_static_roots` | **true** | L683-688: `pointer_compression && external_code_space`. This is what makes `static-roots-*.h` usable as an address table at all. |
| `v8_enable_short_builtin_calls` | true | L598-602: x64/arm64/loong64/riscv64 |
| `v8_enable_undefined_double` | **false** | L461: `= v8_fuzzilli`, which is false in a release build. Gates 20 `.tq` fields (none in a profiled class). |
| `v8_enable_continuation_preserved_embedder_data` | **true** | L393: default `true`. Gates 13 `.tq` fields, all in `promise.tq` / `microtask.tq` / `contexts.tq`. |
| `v8_enable_swiss_name_dictionary` | false | L372: default `false` |
| `v8_enable_javascript_promise_hooks` | false | L388: default `false` |
| `v8_enable_experimental_tsa_builtins` | false | L457: default `false` |
| `v8_enable_drumbrake` | false | default `false` |
| `v8_enable_temporal_support` | true | `gni/v8.gni:64`: true unless `build_with_node`. Adds `js-temporal-objects.tq`; verified not to change the root list either way. |
| `v8_enable_i18n_support`, `v8_enable_webassembly` | from `--variant` | `gni/v8.gni:55`; both true in every desktop Chromium/Electron release |

### The one that cannot be settled from V8 source

`v8_scriptormodule_legacy_lifetime` — **assumed false**, the `BUILD.gn:409`
default. Chromium does not override it; **Node does**, and Electron embeds Node.
It gates one field:

```
src/objects/script.tq:74  @if(V8_SCRIPTORMODULE_LEGACY_LIFETIME) script_or_modules: ArrayList;
```

If the target build enabled it, every `Script` field after `script_or_modules`
shifts by one tagged slot. `Script` has no `FIELD_LIST`, so there is no
cross-check to catch it, and no root or opcode depends on it — nothing in the
acceptance suite can falsify the choice. It is reported in
`meta.json → unresolved.buildConfigUncertain` for both tags, and
`--scriptormodule-legacy-lifetime` flips it.

### The `V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS` `#else` branch

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

`v8_enable_experimental_tsa_builtins` is `false` (`BUILD.gn:457`), so the
preprocessor takes the `#else` branch and `V_TSA` collapses to `V`. The
generator does not special-case this: it evaluates the `#ifdef` like any other.
The consequence is that `BYTECODE_LIST(V, V)` is the right invocation, and the
resulting 212-opcode table matches the checked-in
`rules/v8-14.4.258.16.json` byte for byte (0 mismatches).

### Torque build flags

Not transcribed. `gen/buildflags.mjs` isolates `class BuildFlags`'s constructor
in `src/torque/torque-parser.cc`, runs the preprocessor over it with the C++
defines map, and evaluates each `build_flags_["X"] = expr;`. `TaggedSize()` is
substituted with the chosen `--tagged-size`; `FOO_BOOL` macros resolve through
`src/common/globals.h`. That is why 14.6's new
`V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS_WITHOUT_TQ_TO_TSA`
(`= V8_EXPERIMENTAL_TSA_BUILTINS_BOOL && !V8_EXPERIMENTAL_TQ_TO_TSA_BOOL`)
resolved without a code change.

---

## 5. Constants, and the ABI facts we seed

`constants.json` is derived, with one documented category of exception.

Derived from source:

* `kTaggedSize`, `kPageSizeBits` (18), `kRegularPageSize` (2^18 = 262144),
  `kObjectAlignment`, `kScopeInfoMaxInlinedLocalNamesSize` (75), and ~250 other
  `constexpr`/`const int` constants from `src/common/globals.h`.
* `kHeapObjectTag` (1), `kSmiTag`, `kSmiTagSize`, the masks — from
  `include/v8-internal.h`. `kSmiShiftSize` / `kSmiValueSize` resolve through the
  `SmiTagging<N>` template specialisation for the chosen tagged size.
* **Read-only page header size (16).** `MemoryChunkLayout::ObjectStartOffsetInDataPage()`
  is `RoundUp(sizeof(MemoryChunk), ALIGN_TO_ALLOCATION_ALIGNMENT(kDoubleSize))`,
  and read-only pages use the data-page layout. `sizeof(MemoryChunk)` is computed
  from its non-static data members *after preprocessing*, because under
  `V8_ENABLE_SANDBOX` the second member is `uint32_t metadata_index_` rather
  than `MemoryChunkMetadata* metadata_`. The members are listed in
  `constants.json → readOnlyPage.memoryChunkMembers` so the arithmetic is
  auditable. Result: `{MainThreadFlags @0 (8), uint32_t @8 (4)}` → 12 → aligned
  to 16, which matches the `+16` that was established empirically in the recon.
* Handler table: `kRange*Index`, `kRangeEntrySize` (4 int32 = 16 bytes), the
  `base::BitField` chain (`prediction` bits 0-2, `was_used` bit 3,
  `handler_offset` bits 4-31) and the `CatchPrediction` enum — all from
  `src/codegen/handler-table.h`.
* Source-position table: the varint payload width (7 bits + a more bit), the
  delta encoding, the zig-zag signing, and the first-entry bit layout
  (`code_offset = tmp >> 2`, `is_breakable = (tmp & 2) >> 1`,
  `is_statement = tmp & 1`) — read out of
  `src/codegen/source-position-table.cc`.
* `.jsc` header offsets: the `SerializedCodeData` offset chain from
  `src/snapshot/code-serializer.h`, seeded at
  `SerializedData::kMagicNumberOffset`, with `POINTER_SIZE_ALIGN` applied.
  Result: magic 0, versionHash 4, sourceHash 8, flagHash 12,
  readOnlySnapshotChecksum 16, payloadLength 20, checksum 24, headerSize 32.

**Seeded, not derived** — listed in `constants.json → seededConstants`:

* The C++ `sizeof` primitives for an LP64 / x64 target: `kInt32Size = 4`,
  `kSystemPointerSize = 8`, `kDoubleSize = 8`, and so on. `globals.h` defines
  these as `sizeof(int32_t)`; they are properties of the ABI, not of the V8
  version.
* `sizeof()` of the V8 handle typedefs that `globals.h` uses to define the slot
  sizes (`IndirectPointerHandle`, `JSDispatchHandle`, `ExternalPointer_t`,
  `CppHeapPointer_t`, …). Where a `static_assert(kX == kY)` in an active region
  pins the value independently, that is used in preference.

**Reported as unresolved**: 43 constants (44 at 14.6) whose right-hand side is a
`sizeof`/`offsetof` of a C++ class, a sandbox/cage reservation size or an
`uintptr_t` bit pattern — `kMaximalCodeRangeSize`, `kSandboxGuardRegionSize`,
the `k*TableReservationSize` family, the `k*ZapValue` family, `kUintptrAllBitsSet`,
`kSmiMinValue`/`kSmiMaxValue`. None of them feeds an emitted table. They are
listed in `meta.json → unresolved.unresolvedGlobalConstants` so the gap is
visible rather than assumed away. Note that `kSmiValueSize` and `kSmiShiftSize`,
which *are* used, resolve through the `SmiTagging<N>` specialisation and are not
in that list.

---

## 6. Being polite to gitiles

* Every fetch is cached on disk under `.v8src-cache/<tag>/`, which is
  gitignored. A 404 is cached too (as a `.missing` marker), so a build artifact
  such as `torque-generated/instance-types.h` costs one request per tag.
* 429 and 5xx are retried with quadratic backoff.
* On any failure the **GitHub raw mirror** (`raw.githubusercontent.com/v8/v8`)
  is tried for the same path.
* The 246 `.tq` files are fetched as seven directory archives via gitiles
  `+archive/<ref>/<dir>.tar.gz` (gunzip + a 40-line tar reader), so the Torque
  universe costs seven requests, not 246.
* `--seed-dir <dir>` imports from another cache laid out the same way.
* Re-running the generator on a warm cache makes **zero** network requests
  except the tag-existence probe; `--offline` skips that too.

---

## 7. Provenance and the honesty rules

`meta.json` carries, for every source file actually consumed, its repo path, the
gitiles blob URL, its sha256 and its byte length — 283 files per tag. The
loader re-verifies those hashes against `.v8src-cache/` whenever the cache is
present, and refuses the profile on a mismatch.

Two rules the generator holds to, because breaking them is what broke the old
`rules/`:

1. **Never pad a table to make a count match.** If the derived read-only root
   order does not agree positionally with `StaticReadOnlyRootsPointerTable`, the
   derived table is written as-is and `meta.json → unresolved.unresolvedRoots`
   records the residual count and the first divergent index.
2. **Never read a checked-in copy of a V8 header.** `rules/raw/roots.h` and
   `rules/raw/static-roots.h` are from V8 12.8.374.38, six minor versions behind
   the corpus, and `static-roots.h` has been a four-way variant dispatcher since
   14.2. `profilegen` touches nothing under `rules/`; the self-test asserts that
   `meta.json → sources` contains no `rules/raw` path.

### `src/profile/` carries no version-specific value

The loader's only literals are JSON key names, structural expectations and the
arithmetic of the two decoding rules the profile itself states:

```
operand size     size(type, scale) = scalable ? baseSize * scale : baseSize
read-only ref    Tagged_t = (chunkIndex << pageSizeBits) + chunkOffset + kHeapObjectTag
```

Both the shift and the tag are read from `constants.json`. The self-test greps
`src/profile/index.mjs` for hex literals and 3-or-more-digit decimals and fails
on any hit.
