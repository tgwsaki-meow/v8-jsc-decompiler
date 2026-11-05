# The front end: `.jsc` → typed object model

`src/cache/` reads the container. `src/heap/` turns the bytes inside it into
typed objects and emits the `FunctionUnit` the disassembly layer consumes.
Together they are W2/T4 of `docs/ARCHITECTURE.md`.

Everything here is driven by `profiles/<v8-version>/*.json` plus one companion
file, `layouts-overlay/<v8-version>.json`, described in §2. Neither layer states
an offset, a tag value, a root index or a bit position of its own; the self-test
enforces that mechanically (§7).

---

## 1. Layering

```
profiles/<tag>/            generated data: opcodes, operands, serializer tags,
                           roots, layouts, bitfields, constants, ro-heap
layouts-overlay/<tag>.json generated data: the facts the above does not carry
                           (§2), produced by tools/layoutpatch

src/profile/index.mjs      loads and validates a profile              [T1, read-only here]

src/cache/                 the container
  source.mjs               SnapshotByteSource: GetUint30 / GetUint32 / raw
  version-hash.mjs         Version::Hash() reimplemented (the one header hash
                           that a profile can predict)
  header.mjs               the 7 header fields, sourceHash's bit layout,
                           pre-flight verification, adler32
  overlay.mjs              loads layouts-overlay/<tag>.json
  deserialize.mjs          the snapshot bytecode loop -> a slot-level object graph
  index.mjs                loadEnvironment() + readCache()

src/heap/                  the objects
  layout.mjs               the layout-program walker (conditional and
                           variable-length Torque fields)
  view.mjs                 HeapView: field reads by byte offset, Smi decoding
  classify.mjs             map word -> layouts.json class
  roref.mjs                kReadOnlyHeapRef resolver + unresolved report
  strings.mjs              Seq/Cons/Sliced/Thin/External string decoding
  handlertable.mjs         HandlerTable rows
  sourceposition.mjs       SourcePositionTable, absolute values
  objects.mjs              ScopeInfo, SharedFunctionInfo, UncompiledData,
                           boilerplates (including ClassBoilerplate and the
                           DescriptorArray / AccessorPair it reaches a class's
                           member list through), HeapNumber, BigInt, Symbol,
                           arrays
  index.mjs                HeapContext, buildUnits() -> FunctionUnit[],
                           contextSlotNamingStats()

src/cli/dump-cache.mjs     the CLI
tests/t4/                  the oracle harness, the self-test, the corpus run
tools/layoutpatch/         the overlay generator
```

`src/cache/` knows nothing about what a BytecodeArray is; it knows the container
format. `src/heap/` reaches every field through
`layout.walk(className, view).fields.get(name)` — never by slot index. The old
`legacy/src/deserializer.js` read the constant pool as `slots[5]` and the handler table
as `slots[4]`; here those are `constant_pool` and `handler_table`, so a field
moving between V8 versions is a data change rather than a code change.

### Running it

```
node src/cli/dump-cache.mjs <file.jsc> [--profile <tag|dir>] [--json out.json]
                                       [--function <literal-id>] [--sfi <id>]
                                       [--constants N] [--no-scopes] [--quiet]

node tests/t4/selftest.mjs          # no V8 needed
node tests/t4/acceptance.mjs        # against this node's --print-bytecode
node tests/t4/corpus-run.mjs        # all of extracted_jsc/
node tools/layoutpatch/index.mjs --tag <v8-version>
```

Without `--profile`, `dump-cache` picks the profile whose `Version::Hash()`
matches the file's `versionHash` field, and refuses with the exact
`profilegen` + `layoutpatch` command lines when none does.

---

## 2. Why there is an overlay

`tools/layoutpatch/index.mjs` generates `layouts-overlay/<tag>.json` from the
same pinned V8 sources `profilegen` uses, recording each file's URL and sha256.
It exists because `profiles/<tag>/*.json` has four gaps that this layer cannot
work around in code. All four were found while building T4; none is reported in
`meta.json`'s `unresolved` section.

### 2.1 `layouts.json` silently drops three ScopeInfo fields

`src/objects/scope-info.tq` declares 18 fields. `layouts.json` carries 14. The
missing ones are

| field | why profilegen dropped it |
|---|---|
| `context_local_names[…]` | the count expression contains `Convert<intptr>(context_local_count)` |
| `context_local_names_hashtable?[…]` | the condition contains the same cast |
| `function_variable_info?[…]` | the condition contains `FromConstexpr<VariableAllocationInfo>(…)` |

profilegen's Torque reader does not parse a call form in an index or condition
expression, so it skips the field. These are **interior** fields: their absence
does not merely lose data, it shifts every later field. Walking layouts.json's
ScopeInfo program would read `context_local_infos` out of the region where
`context_local_names` actually lives, and would misplace
`inferred_function_name` and `outer_scope_info` for every named function
expression. And `context_local_names` is the variable-name table — the single
thing this task exists to recover.

The overlay re-reads the class from the pinned `.tq` and emits the full ordered
field list. The generator then **cross-checks**: every field layouts.json does
carry must come out of the overlay's reader with the same type, kind, size,
conditionality and — up to the first data-dependent field — the same absolute
offset. All 14 agree, for both 14.4.258.16 and 14.6.202.34. A single
disagreement fails the generator and `loadOverlay` refuses the file.

### 2.2 FunctionKind and FunctionSyntaxKind are C++ enums

`SharedFunctionInfoFlags.function_kind` is 5 bits of `FunctionKind` and
`function_syntax_kind` is 3 bits of `FunctionSyntaxKind`. Both are plain C++
enums (`src/objects/function-kind.h`, `src/objects/function-syntax-kind.h`), not
Torque enums, so `layouts.json`'s `enums` table has no entry for either — and
`function_kind` is the only source of `isGenerator`, `isAsync`, `arrow`,
`getter`, `setter` and `method`.

`function-kind.h` also *states* the groupings, as `base::IsInRange` predicates
over kind ordinals. The overlay extracts those 19 predicates rather than
reinventing them, so `isGenerator` is V8's `IsGeneratorFunction`, not a guess
about which kinds are generators. Three predicates
(`IsResumableFunction`, `IsStatic`, `BindsSuper`) are compositions of the others
and are reported as not extracted rather than approximated.

### 2.3 Two Torque `extern enum` declarations disagree with C++

For an `extern enum` Torque states the member *names*; C++ states the *values*.
They are not always in the same order, and `layouts.json` records Torque's:

| enum | layouts.json (Torque declaration order) | C++ value |
|---|---|---|
| `LanguageMode::kStrict` | 0 | **1** |
| `LanguageMode::kSloppy` | 1 | **0** |
| `ElementsKind::PACKED_SMI_ELEMENTS` | 1 | **0** |
| `ElementsKind::NO_ELEMENTS` | 0 | last |
| … 7 ElementsKind members in total | | |

Using the Torque order would name every `ArrayBoilerplateDescription` one
elements kind too high and invert every strict/sloppy report. The overlay
carries the C++ values and lists the disagreements; `HeapContext.enumName()`
prefers the overlay. `ElementsKind` is extracted only up to the first
macro-generated member (`TYPED_ARRAYS`), which covers every kind a literal can
have; a value past that resolves to `null` and is counted, rather than falling
back to a table known to be shifted.

### 2.4 Five C++ facts `constants.json` does not carry

* `0xC0DE0000`, the code-cache magic base (`src/snapshot/snapshot-data.h`).
  `magic ^ 0xC0DE0000` recovers `ExternalReferenceTable::kSize`, which is the
  build identity that tied the corpus to Electron's snapshot blob (1652 on
  both).
* `SerializedCodeData::SourceHash`'s bit widths
  (`src/snapshot/code-serializer.cc`): length at bits 0–28,
  `hasWrappedArguments` at 29, `isModule` at 30.
* `SourcePosition`'s bitfield (`src/codegen/source-position.h`) — see §5.3.
* `BigIntBase`'s layout and `HashTableBase`'s index constants, both
  `@cppObjectLayoutDefinition` classes with no Torque declaration.
* `ClassBoilerplate`'s vocabulary: the `ValueKind` enum, the
  `DefineClassArgumentsIndices` enum and the `ComputedEntryFlags` bit widths
  (`src/objects/literal-objects.h`). Torque declares the seven *fields*; what
  they mean is C++'s, and without it a getter cannot be told from a method —
  see §4.2a.

### 2.5 Only a Torque field may enter the overlay's type dictionary

The overlay sizes a Torque type by *observation*: `buildTypeTable` walks every
field `layouts.json` carries, and since each field already states its own kind
and size, a type the profile has seen needs no rule. Two of profilegen's three
layout mechanisms produce fields that have no Torque type to key on, and
`layouts.json` records `type: null` for them:

| mechanism | what it states instead of a type |
|---|---|
| hand-written `FIELD_LIST` | a size expression — `kInt32Size`, `OBJECT_POINTER_PADDING(…)` |
| `V8_OBJECT class X { TaggedMember<T> f_; }` | a C++ template argument |

Entering those fields anyway put all of them under the single key `null`, and
the first pair whose widths differed came out as a conflict *in the type
`null`* — which printed as an empty name, because that is what `null` joins to.
It stayed invisible for as long as every untyped field happened to be the same
width: at `kTaggedSize=4` `AccessorPair`'s two `TaggedMember`s are 4 bytes,
exactly like `FeedbackMetadata`'s two `uint32` `FIELD_LIST` fields, and at
`kTaggedSize=8` they are not. Both committed profiles are `kTaggedSize=4`, and
the only caller of this generator is the `V8 oracle` workflow, which runs it
against one `kTaggedSize=8` profile generated for the runner's own node — so the
first machine to see it was CI.

The rule now: a field with no Torque type is left out of the dictionary, which
loses nothing because a lookup key here is always a Torque type string and
could never have reached a `null` entry; and a field with no Torque type whose
class claims `layoutSource: "torque"` **throws**, naming the field, because
that is a profilegen regression and not a case to skip. A genuine conflict
names the type, both fields that disagree and what each said.
`tools/profilegen/selftest.mjs`'s `TYPETABLE` group asserts all three at the
widths a `kTaggedSize=8` profile would produce.

---

## 3. The container: `src/cache/`

### 3.1 Header

Field offsets come from `constants.codeCacheHeader`. `verifyHeader` returns
`{errors, warnings, checks}`; `readCache` throws a `CacheVersionError` on any
error unless told otherwise.

| field | checked against | on mismatch |
|---|---|---|
| `magic` | the blob the read-only table came from, via `ExternalReferenceTable::kSize` | warning (error if the caller supplies an expectation) |
| `versionHash` | `Version::Hash()` recomputed from the profile's `v8Version` | **error**, with the `profilegen` and `layoutpatch` command lines |
| `sourceHash` | bits above the three documented fields must be zero | warning |
| `flagHash` | nothing — see below | reported |
| `readOnlySnapshotChecksum` | the stored checksum of the blob behind `ro-heap.json` | warning |
| `payloadLength` | file size minus header size | **error** |
| `checksum` | recomputed adler32 when non-zero | error |

`versionHash` is the only header hash a profile can predict, because it is a
pure function of the four version numbers:

```
Version::Hash() = Hasher::Combine(major, minor, build, patch)      src/utils/version.h
                = fold hash_combine(acc, hash<int>{}(n)), acc = 0  src/base/hashing.h
```

`src/cache/version-hash.mjs` reimplements it and reproduces `0x12819a30` for
14.4.258.16 (the corpus headers) and `0x97ffbd52` for 14.6.202.34 (a cache
minted by the local node) from the version strings alone. It is the only file
under `src/cache` + `src/heap` + `src/cli` that holds unexplained numbers — the
mixing constants of Thomas Wang's integer hash and MurmurHash64A — and the fact
that one implementation satisfies two different V8 releases is what establishes
that those constants are not version data.

`sourceHash` is not a hash: it is the source character count in bits 0–28 plus
two flags. It gives an exact upper bound on the original source length
(4,241,501 characters for `r_8878.jsc`).

### 3.2 Deserializer

`src/snapshot/deserializer.cc`, transcribed and driven by
`serializer-tags.json`. All 35 tags are referenced; the hardcodes the task
listed are gone:

| was | now |
|---|---|
| `kTaggedSize = 4` | `profile.taggedSize` |
| `sizeInTagged * 4` | `sizeInTagged * profile.taggedSize` |
| literal tag bytes `0x00`–`0x21` | `profile.serializerTag(name)` |
| ranged-tag arithmetic | a 256-entry dispatch table built from `rangedTags` |
| the `kVariableRepeatRoot` base `18` | `kFirstEncodableRepeatRootCount + kFixedRepeatRootCount` |
| `slotIndex >= 6 → bytecodePayload` | gone; `src/heap` addresses raw bytes by the offset `layouts.json` states |
| the 32-byte header | `constants.codeCacheHeader.kHeaderSize` |
| `BytecodeArray` field offsets, pool in `slots[5]`, handlers in `slots[4]` | `layoutOf('BytecodeArray')` |

Added relative to `legacy/src/deserializer.js`:
`kNewContextlessMetaMap` / `kNewContextfulMetaMap`,
`kExternalReference` / `kSandboxedExternalReference` /
`kSandboxedRawExternalReference`, `kApiReference` / `kSandboxedApiReference`,
`kStartupObjectCache` / `kSharedHeapObjectCache` as distinct kinds, the weak /
indirect / protected prefix flags recorded per slot, and the `kSynchronize`
inside an object body treated as the error V8 marks `UNREACHABLE`.

Two tags refuse by name: `kEmbedderFieldsData` and `kApiWrapperFieldsData` are
in V8's `Bytecode` enum but not in `ReadSingleBytecodeData`'s switch — only the
context deserializer consumes them, and their payload is embedder-defined. A
byte in V8's `UNUSED_SERIALIZER_BYTE_CODES` range is refused with its offset.

The output is a **slot-level** object graph: per object, its map, its size in
tagged slots, one entry per tagged slot, and the raw byte runs the serializer
emitted. Typing happens one layer up, which is what lets the layout layer
address fields by byte offset.

After the deferred-object section's `kSynchronize`, the remaining bytes must all
be `kNop` and must fit `Serializer::Pad`'s budget
(`kUInt32Size - 1 + kPointerAlignment - 1`). Both are asserted and reported.

---

## 4. The objects: `src/heap/`

### 4.1 The layout program

A Torque class is not a fixed set of offsets. A field can be absent (`?[cond]`)
or variable-length (`[count]`), and either makes every later field's offset
depend on the object's own data. ScopeInfo is almost entirely of this kind.

`LayoutResolver.walk(className, view)` therefore *walks*: start at the parent's
size and, for each declared field in order, decide whether it is there and how
wide it is, reading the values earlier fields hold to answer. Condition and
count expressions are evaluated from the ASTs `layouts.json` and the overlay
carry (`name` / `member` / `binary` / `ternary` / `literal` / `enumRef`);
`member` access resolves through the profile's bitfield tables, `enumRef`
through the overlay's enums, and a bare name through earlier field values or
`constants.globals` (via the Torque `generates '…'` mapping, which is how
`kMaxInlinedLocalNamesSize` becomes
`kScopeInfoMaxInlinedLocalNamesSize` = 75).

The program is split at the first data-dependent field. The prefix before it has
one set of offsets for every instance, computed once and shared; only the tail is
walked per object, and only the field values the tail's expressions actually
read are fetched. `SharedFunctionInfo` has no dependent field at all, so its
walk is free after the first object.

When a condition or count cannot be evaluated, the walk **stops** and reports
`truncatedAt` rather than continuing with offsets it cannot know.

### 4.2 Which class is this?

From the map word, which in a code cache is always a root reference or a
read-only reference, so the map's *name* is available even though the Map object
is not in the payload. Resolution is two steps:

1. strip the trailing `Map` and look the remainder up in `layouts.json`,
   case-insensitively, trying both the root's snake_case `cppName` and its
   ROOT_LIST `camelName` (they differ: `feedback_metadata_map` is spelled
   `FeedbackMetadataArrayMap`);
2. for a string map, decompose it. V8 spells string maps as optional
   `shared_` / `uncached_` / `internalized_` decorations over a representation
   and an encoding, and only the representation and encoding affect the layout:
   `cons_*` → `ConsString`, `sliced_*` → `SlicedString`, `thin_*` →
   `ThinString`, `external_*` → `ExternalString`, otherwise
   `SeqOneByteString` / `SeqTwoByteString` by encoding.

Two explicit aliases, each a structural V8 fact rather than version data:
`fixed_cow_array` → `FixedArray` (copy-on-write is a map-level marker, the
layout is identical) and `bigint` → `BigIntBase` (BigInt's layout is C++, and
the overlay carries it under the base class's name).

Anything neither step resolves is **not** guessed. The report separates two
failures: a map that is named but has no `layouts.json` class (benign for
classes the front end never decodes) from a map word that could not be named at
all (which would hide real objects). The corpus produces zero of the latter.

### 4.2a `ClassBoilerplate`: the member list of a `class`

`%DefineClass`'s first argument. It is the only place a class's member list is
written down, and until it was decoded every method, getter and setter of every
class in the corpus was emitted as a sibling function declaration next to a
class whose body was empty (RECOVER.md §9.6).

`decodeClassBoilerplate` returns `{t:'classBoilerplate'}` with `entries`, the
same way `decodeObjectBoilerplate` returns `entries` and
`decodeArrayBoilerplate` returns `elements`. What it does **not** return is the
members' values: `ClassBoilerplate::New` stores `Smi(value_index)` — the index
of the register in the `%DefineClass` argument list that holds that member's
closure — and the argument list belongs to the caller, not to the constant. So
this layer reports argument indices and `src/recover` performs the join.

The seven fields (`src/objects/literal-objects.tq`,
`literal-objects.cc::ClassBoilerplate::New:680`):

| field | what it holds |
|---|---|
| `arguments_count` | the final `dynamic_argument_index`: how many registers the `%DefineClass` call takes (`:812`) |
| `static_` / `instance_properties_template` | every member with a non-index literal key. A `DescriptorArray` unless the class has a computed-name member or more than `kMaxNumberOfDescriptors` properties, when `ObjectDescriptor::HasDictionaryProperties:471` switches it to a name dictionary |
| `static_` / `instance_elements_template` | the members whose key is an array index, in a `NumberDictionary`; the canonical `empty_slow_element_dictionary` when there are none (`CreateTemplates:521`) |
| `static_` / `instance_computed_properties` | one Smi per computed-name member, packing `(ValueKind, key index)` through `EncodeComputedEntry:33`; `empty_fixed_array` when there are none |

A template entry's value is the whole of the link to the bytecode:
`Smi(value_index)` for a data member, and an `AccessorPair` whose `getter` and
`setter` are two such Smis for an accessor
(`AddToDescriptorArrayTemplate:80`, `AddToDictionaryTemplate:196`,
`SetAccessorPlaceholderIndices:41`). That is also how V8's own descriptors are
told apart from members, **by value and not by name**: `ObjectDescriptor::
AddConstant` adds `length`, `name` and `prototype` (whose values are the
function-accessor roots), `class_positions_symbol` (a `ClassPositions`) and
`constructor` → `Smi(kConstructorArgumentIndex)` = 1, which is below
`kFirstDynamicArgumentIndex` = 3. So the rule is: a member's value is a Smi at
or above `kFirstDynamicArgumentIndex`, or an `AccessorPair` of those. Everything
else is reported under `synthesised` with the root or class it points at.

`entries` is sorted by argument index, which **is** the declaration order:
`ClassBoilerplate::New:756-793` walks `expr->public_members()` once and only
ever increments `dynamic_argument_index`. The templates themselves do not keep
that order — a `DescriptorArray` is sorted by key hash (`Finalize:610`).

Three things are refused rather than guessed, each with a named reason carried
all the way to a counted hole in the emitted text:

* `propertiesTemplateIsADictionary` — a `NameDictionary` or
  `SwissNameDictionary`. Its `kPrefixSize` / `kEntrySize` live with the table
  class in C++ and are in no profile table (the same wall §8.3 describes), so
  the entries are named rather than read with a guessed stride.
* `elementsTemplateIsADictionary` — a `NumberDictionary`, i.e. `class C { 0(){} }`.
* `computedPropertyValueKindUnknown` — a `ValueKind` ordinal the profile's
  `cppLayouts.ClassBoilerplate.valueKind` does not name.

**A class FIELD is not in here at all.** `ClassBoilerplate::New:769` `continue`s
on `ClassLiteral::Property::FIELD` before any `desc.Add*`, after bumping the
argument index by one when the field's name is computed. So the decode cannot
make fields reachable even in principle, and
`argumentsUnclaimed` — dynamic arguments no template describes — is the
measure of it. Measured over the 29-file sample
(`node tools/probes/probe_class.mjs shape`): 82 boilerplates, 1 054 descriptors
read, **648 members** (531 instance methods, 107 instance getters, 4 instance
setters, 6 static methods), 410 = 82 × 5 descriptors attributed to V8 itself,
**0 refusals** and **0 unclaimed arguments**.

Three layouts are reached by name to do this, and all three are now in
`layouts.json` because `tools/profilegen` was extended rather than because any
offset was written down here: `ClassBoilerplate` and `DescriptorArray` from
their Torque bodies, `StrongDescriptorArray` (the map the corpus actually uses;
`class StrongDescriptorArray extends DescriptorArray {}` adds no field but has
its own map), and `AccessorPair` from a third layout mechanism —
`V8_OBJECT class AccessorPair : public StructLayout { … TaggedMember<Object>
getter_; TaggedMember<Object> setter_; }`, which neither Torque (`extern class
AccessorPair extends Struct;` declares no layout) nor a `FIELD_LIST` describes.
The C++-only vocabulary — `ValueKind`, `DefineClassArgumentsIndices`,
`ComputedEntryFlags` and the two minimum-properties counts — is derived into
`layouts.json -> cppLayouts.ClassBoilerplate`, next to `BigIntBase`,
`HashTableBase` and `SourcePosition`.

### 4.3 ScopeInfo and the names

`decodeScopeInfo` walks the 18-field program against the object's own
`ScopeFlags` and produces the `scope` structure of §8.1, then follows
`outer_scope_info` to build the chain `LdaContextSlot`'s depth operand indexes
into. Results are memoised per ScopeInfo object: an outer scope is reached once
per inner function and the corpus has chains ten deep.

`context_local_names` is an inlined `String` array below
`kScopeInfoMaxInlinedLocalNamesSize` (75) context locals and a
`NameToIndexHashTable` at or above it. Both paths are implemented; see §6.3 for
the assumption the hash-table path rests on.

Where a function's name comes from, in V8's own order
(`SharedFunctionInfo::Name()`): `name_or_scope_info` when it holds a String;
otherwise the ScopeInfo's `function_variable_info.name`; otherwise its
`inferred_function_name`; otherwise, for a function that was never compiled, the
`UncompiledData.inferred_name`. Each unit records which of these it used in
`nameSource`.

`function_variable_info` is present whenever `ScopeFlags.function_variable` is
not `NONE`, and V8 sets that field to `UNUSED` for every function, script, eval
and module scope specifically to reserve room for the debug name
(`ScopeInfo::Create`). So `UNUSED` with a real name is the normal case, not an
anomaly.

### 4.4 Side tables

**HandlerTable** (`src/codegen/handler-table.h`): four int32 per row, with
`handler_bits` a bitfield whose positions come from
`constants.handlerTable.bitFields`. The previous implementation computed
`handlerOffset = val >> 4` and `catchPrediction = val & 0xf`, which folded
`was_used` into the prediction and lost both. Here `prediction`, `wasUsed` and
`handlerOffset` are separate, and `prediction` is named — it is what
distinguishes a source-level `catch` (`CAUGHT`) from the handler an `await`
desugaring installs (`ASYNC_AWAIT` / `UNCAUGHT_ASYNC_AWAIT`) and from a promise
rejection handler (`PROMISE`). Across the corpus every non-zero prediction seen
is reported in the corpus run's table.

**SourcePositionTable** (`src/codegen/source-position-table.cc`): see §5.3 for
the two things that are easy to get silently wrong.

---

## 5. Three bugs the V8 oracle caught

Worth recording, because each produced plausible-looking output.

### 5.1 Smi decoding without pointer compression

`value = (signed)raw >> (kSmiTagSize + kSmiShiftSize)`. With pointer
compression the shift is 1 and the word is 4 bytes, so a 32-bit arithmetic shift
works. Without it, `kSmiShiftSize` is 31, the shift is 32 — which JavaScript's
`>>` cannot express, since it truncates its operand to 32 bits and takes the
shift count mod 32 — and the raw value reaches 2^63, past the
exactly-representable integer range. The 8-byte case goes through BigInt. Before
the fix, every Smi on a `kTaggedSize == 8` build decoded as 0, which showed up
as `bytecodeLength = 0` and an empty bytecode buffer.

### 5.2 BigInt digit alignment

`raw_digits` is `FLEXIBLE_ARRAY_MEMBER(UnalignedValueMember<digit_t>, …)`, and
`UnalignedValueMember` declares `alignas(alignof(Tagged_t)) char storage_[…]`
(`src/objects/tagged-field.h`). So the digit array starts at the next
`kTaggedSize` boundary after the 4-byte bitfield, not immediately after it. With
pointer compression there is no padding; without it there are 4 bytes, and
reading the first digit 4 bytes early made `1n` decode as 4294967296.

### 5.3 The source position table stores `SourcePosition::raw()`, not an offset

Two separate traps:

* The second value of each entry is a 64-bit bitfield
  (`src/codegen/source-position.h`), not a character offset. The offset is
  `ScriptOffsetField::decode(raw) - 1`; the `+1` bias exists so
  `kNoSourcePosition` (−1) stores as 0, and bits 31–46 carry an inlining id.
  V8's own `--print-bytecode` prints `ScriptOffset()`. Taking `raw` as the
  offset doubled every position, which looks like plausible data until you
  notice positions beyond the end of the source.
* The accumulator for `code_offset` starts at **`kFunctionEntryBytecodeOffset`
  (−1)**, not 0, because both the writer's `previous_` and the reader's
  `current_` begin as a default-constructed `PositionTableEntry`. Starting at 0
  shifts every code offset by one and invents a spurious entry.
  `SourcePositionTableIterator` defaults to `kSkipFunctionEntry`, so V8's listing
  never prints the entry at −1; this decoder emits it with
  `isFunctionEntry: true` because it is real data (the position of the
  parameter list).

---

## 6. The `FunctionUnit` contract, as implemented

`buildUnits(env, graph, opts)` returns
`{ ctx, units, unitBySfiId, unitByFunctionLiteralId, rootSfiId, stats, reports }`.
Each unit follows `docs/ARCHITECTURE.md` §8.1, with the additions and the three
deviations below.

```js
{
  // identity
  sfiId, bytecodeId, functionLiteralId, parentSfiId,
  name, nameSource,                 // see 4.3
  kind,                             // normal | arrow | method | classCtor | getter | setter | module
  functionKindName,                 // the raw FunctionKind member, e.g. 'kAsyncArrowFunction'
  functionSyntaxKind,               // FunctionSyntaxKind member
  isGenerator, isAsync, isStrict, isTopLevel,
  startPosition, endPosition, positionSource,
  formalParameterCount, functionTokenOffset, expectedNofProperties, uniqueId,
  compiled,                         // true when a BytecodeArray was serialized
  functionDataClass,                // 'BytecodeArray' | 'UncompiledData…' | null
  sfiFlags, sfiFlags2,              // the bitfields, expanded

  // body (null throughout when compiled === false)
  bytecode,                         // Buffer, bytecode only
  bytecodeLength, frameSize, registerCount,
  parameterCount,                   // includes the receiver -- see 6.1
  parameterCountWithoutReceiver,
  maxArguments,
  incomingNewTargetOrGeneratorRegister,     // raw operand, null when invalid -- 6.2
  incomingNewTargetOrGeneratorRegisterRaw,

  constants: [ …tagged unions… ],
  constantPoolId, constantPoolSmiRuns,      // see 6.4
  handlers: [{ rangeStart, rangeEnd, handlerOffset, prediction, predictionName,
               wasUsed, data, rawHandlerBits }],
  handlerTableBytes,
  sourcePositions: [{ codeOffset, sourcePosition, isStatement, isBreakable,
                      rawPosition, inliningId, isFunctionEntry? }],
  sourcePositionTableBytes,

  scope, outerScope, scopeSource,   // §8.1's `scope`, plus the outer-only case
  uncompiled,                       // { startPosition, endPosition, inferredName,
                                    //   className, hasPreparseData } | null
  children: [{ sfiId, functionLiteralId }],
  warnings: [ … ],
}
```

The constant union members are those of §8.1 plus `rootObject`, `array` and
`byteArray`:

| `t` | payload |
|---|---|
| `string` | `v` |
| `number` | `v`, `repr: 'smi'` when it was a Smi rather than a HeapNumber |
| `bigint` | `v` as a decimal string |
| `boolean` / `null` / `undefined` / `hole` | — |
| `symbol` | `desc` |
| `sfi` | `sfiId` |
| `scopeInfo` | `scopeInfoId` |
| `objectBoilerplate` | `entries: [{key, value}]`, `rawEntries`, `flags`, `backingStoreSize`, `length` |
| `arrayBoilerplate` | `elements`, `flags`, `elementsKind` |
| `regexpBoilerplate` | `source`, `flags`, `flagBits`, `flagString` |
| `classBoilerplate` | `entries: [{side, keyKind, key, kind, valueIndex, keyIndex, details}]`, `synthesised`, `refusals`, `argumentsCount`, `firstDynamicArgumentIndex`, `descriptorsRead`, `argumentsUnclaimed` — §4.2a |
| `templateObject` | `raw`, `cooked` |
| `smiArray` | `values` — a FixedArray whose every element is a Smi |
| `array` | `className`, `values` |
| `byteArray` | `className`, `length`, `bytes` |
| `roRef` | `chunk`, `offset`, `address`, and `resolved` **only when resolved** |
| `rootObject` | `rootName`, `cppType`, `isEmpty` — a canonical read-only root |
| `unresolved` | `why`, `detail` |

`rootObject` exists because a canonical root is how V8 spells "nothing here":
`{}` stores `empty_object_boilerplate_description`, a BytecodeArray with no
handlers stores `empty_trusted_byte_array`. The object itself lives in the
read-only heap, not in the payload, so the honest report is the root's name and
the C++ type `roots.json` gives it.

### 6.1 `parameterCount` includes the receiver

`BytecodeArray::parameter_count()` returns the `parameter_size` field, which
counts the receiver; `parameter_count_without_receiver()` subtracts it, and
`--print-bytecode` prints the former. `parameterCount` matches what V8 prints
(so the oracle can assert on it) and `parameterCountWithoutReceiver` is also
emitted. `registerCount` is `frameSize / kSystemPointerSize`, V8's own formula.

### 6.2 `incomingNewTargetOrGeneratorRegister` is the raw operand

V8 stores 0 for `Register::invalid_value()` and otherwise a register operand
that `Register::FromOperand` decodes. Structured register decoding is
§8.3's contract and belongs to the disassembly layer, so this layer emits
`null` for invalid and the raw int32 otherwise.

### 6.3 Deviation: a jump table is not an array object

§8.1 asks for `{t:'smiArray', values}` so that `SwitchOnSmiNoFeedback`'s jump
table can be read. In V8 a jump table is **not** an array object:
`ConstantArrayBuilder::InsertJumpTable` reserves a run of *consecutive constant
pool slots* and later writes a Smi into each, and the instruction's operand is
the index of the first slot. So each entry surfaces as its own
`{t:'number', repr:'smi'}` and the run is reported separately as

```js
constantPoolSmiRuns: [{ start, length, values }]   // maximal runs of >= 2 Smis
```

which is exactly the shape a jump table has. `{t:'smiArray'}` is still produced,
for a `FixedArray` whose every element is a Smi. The `switch` acceptance case
asserts a run of 8 or more for an 8-case dense switch.

### 6.4 Uncompiled functions are first-class

An SFI whose `trusted_function_data` is an `UncompiledData*` rather than a
`BytecodeArray` becomes a unit with `compiled: false`, `bytecode: null` and a
populated `uncompiled: {startPosition, endPosition, inferredName, className,
hasPreparseData}`. Its outer ScopeInfo is still decoded, from
`outer_scope_info_or_feedback_metadata`, and reported as `outerScope`. Nothing
is dropped, so the decompiler can emit the hole with its real source range and
its real outer scope.

### 6.5 The SFI tree

`functionLiteralId` indexes `unitByFunctionLiteralId`. Parent/child comes from
the constant pool: an inner function appears in its parent's pool as
`{t:'sfi'}`, which gives `children` and `parentSfiId`. A duplicate
`function_literal_id` is reported rather than silently overwriting.

---

## 7. What the self-test enforces

`node tests/t4/selftest.mjs` — 22 checks, no V8 required (17 of them without a
corpus, which is what CI runs).

* **No version-specific literal.** After block comments are removed, no
  hexadecimal literal and no 3-or-more-digit decimal may appear in
  `src/cache/`, `src/heap/` or `src/cli/` unless its line, or the comment block
  immediately above it, carries a `VERSION-FREE:` justification. 13 literals
  are justified that way: 32-bit masks, adler32's modulus and block size,
  printing widths and one recursion cap. One file,
  `src/cache/version-hash.mjs`, is allowlisted, and a second check asserts that
  it contains *only* the two published hash multipliers and a 32-bit mask.
* No V8 version tag appears in code outside a comment.
* `Version::Hash()` reproduces the recorded header value for every installed
  profile.
* adler32 is correct against the textbook value and is seeded with 0.
* `GetUint30` round-trips all four encodable widths.
* The source position table round-trips through a reimplementation of V8's own
  encoder, including an entry at `kFunctionEntryBytecodeOffset`.
* The handler table keeps `prediction`, `wasUsed` and `handlerOffset` apart,
  including a maximal 28-bit offset and a negative `data`.
* Every one of the 35 serializer tags is referenced by the loop; the two
  unimplementable ones throw an error naming themselves; a byte in V8's unused
  range is refused with its offset.
* The overlay recovers exactly the three ScopeInfo fields, with a clean
  cross-check, for every installed profile.
* Every static field offset the walker computes (225 of them) equals the offset
  `layouts.json` states.
* **Every field `decodeClassBoilerplate` reads by name is in the walk** — the
  seven `ClassBoilerplate` fields, `StrongDescriptorArray`'s three, the two of
  `AccessorPair`, the three of the `DescriptorEntry` struct, and the five values
  of `cppLayouts.ClassBoilerplate` — for every installed profile. This one
  exists because the failure is silent: `fields.get(name)` answers `undefined`
  rather than throwing, so a profile that stopped carrying any of them would
  turn every class into a counted hole and read exactly like a corpus with no
  classes in it.
* The enum corrections the overlay makes are still real disagreements.
* A corpus file decodes with a clean header check, ends in `kNop` padding, has
  no unresolved forward reference, and yields units with names, source ranges
  and scopes; and decoding it with the *wrong* profile is refused with a message
  naming both `profilegen` and `layoutpatch`.
* **Every `ClassBoilerplate` in that file decodes to a member list that fits its
  argument list**: every member's index is a real register of its own
  `%DefineClass` call, a computed member's key index is its value index minus
  one, and every descriptor read is accounted for as a member, as one of the
  five `ObjectDescriptor::AddConstant` adds, or as a named refusal. Each
  assertion is a property of `ClassBoilerplate::New`, not of that file.

### The oracle

`node tests/t4/acceptance.mjs` compares against V8's own `--print-bytecode`.
For each of 31 sources a child process mints a real `.jsc` with
`vm.Script#createCachedData()` and a second prints the bytecode of *the same
program* — `tests/t4/listing-runner.cjs` compiles it with `new vm.Script` rather
than letting node load it as a CommonJS module, because node's module wrapper
turns every top-level `var` from a global property into a function local and
changes the bytecode of any inner function that reads one.

Units are matched to listing functions by **byte-for-byte bytecode equality**,
reconstructed from the raw-byte column of every instruction line, and
disambiguated by source position when two functions share a bytecode string.
Per matched function the harness asserts `parameterCount`, `registerCount`,
`frameSize`, `bytecodeLength`, byte-for-byte bytecode equality, constant pool
length, every resolved constant value, the handler table rows, and the source
position entries against the `NN S>` / `NN E>` markers.

Note that the oracle runs against a **`kTaggedSize == 8`** profile while the
corpus run uses a `kTaggedSize == 4` one. The local node is built without
pointer compression and without the sandbox
(`process.config.variables.v8_enable_pointer_compression === 0`,
`v8_enable_sandbox === 0`), so its object layouts differ from the
Electron/Chromium configuration that produced the corpus. That is not a
complication to work around, it is the strongest available evidence that the
decoder carries no build assumption of its own:

```
node tools/profilegen/index.mjs --tag 14.6.202.34 --variant intl+wasm \
     --tagged-size 8 --out profiles-local/
node tools/layoutpatch/index.mjs --tag 14.6.202.34 \
     --profiles profiles-local --out layouts-overlay-local
```

---

## 8. Assumptions I could not verify

Listed because each one is a place where this layer could be wrong without
saying so.

### 8.1 The read-only table is the right layout, not provably the same build

The corpus's headers carry `readOnlySnapshotChecksum = 0x4be885e`;
`profiles/14.4.258.16/ro-heap.json` was built from a blob storing `0xe0a58cd1`
(see `profiles/14.4.258.16/RO-HEAP-PROVENANCE.md`). `verifyHeader` reports this
as a warning on every corpus file. The supporting evidence is that
`ExternalReferenceTable::kSize` is 1652 on both and that all 883 distinct
`(chunk, offset)` pairs the corpus references land on object starts with
plausible identifier values — but it is not bit-identical proof. A wrong-build
table would resolve read-only references to the wrong strings while reporting
100 % success. Closing this needs the `v8_context_snapshot.bin` from QQ's own
install directory.

### 8.2 `flagHash` is unverifiable from any profile

`FlagList::Hash()` covers the producing isolate's *runtime* flag values. Nothing
derivable from V8 source predicts it, so it is reported and compared only
against a caller-supplied expectation. A cache produced under unusual flags
would decode normally here even though its bytecode might differ from what the
same source produces under default flags.

### 8.3 The `NameToIndexHashTable` name recovery is a validated pair scan

Above 75 context locals, `context_local_names` becomes a
`NameToIndexHashTable`. Its entries start at
`HashTableBase::kPrefixStartIndex + Shape::kPrefixSize` with `Shape::kEntrySize`
slots each — and the *Shape* constants live with each table class in C++, not in
any profile table. Rather than assume them, the decoder scans every slot and
keeps a pair whenever a string is immediately followed by a Smi in range, then
**validates**: the result must be exactly `context_local_count` names at
distinct indices. If it is not, no names are returned and the reason is
reported. In the acceptance suite the 90-local case recovers 90/90; across the
corpus the hash-table path contributes the `viaHashtable` figure in the corpus
report. The assumption is that no other (string, small-Smi) adjacency exists in
such a table — true for the two-slot (`Name`, `Smi`) entry shape, and the count
validation would catch it if it were not.

### 8.4 Classes with no `layouts.json` entry are reported, not decoded

`layouts.json` has 48 classes. These appear in the corpus and are reported by
map name with a count rather than decoded:

`ClassPositions`, `WeakFixedArray`, `NameToIndexHashTable`, `NameDictionary`,
`NumberDictionary`, `FixedDoubleArray`.

Only one of them loses information the `FunctionUnit` contract asks for:
**`FixedDoubleArray`** is the `constant_elements` of an array literal whose
elements are all doubles, so `{t:'arrayBoilerplate'}` has `elements: null` and a
`why` naming the map. Its Torque element type is
`float64_or_undefined_or_hole`, a 9-byte Torque struct, while the on-heap
element is an 8-byte double — so the element size cannot be taken from the
profile either, and guessing a stride is exactly the kind of silent error this
layer refuses to make.

`ClassPositions` is the value of the `class_positions_symbol` descriptor V8 adds
to a class's static template; it is the class's source range, which
`FunctionUnit` already carries from the ScopeInfo, so §4.2a reports it under
`synthesised` by map name and reads nothing out of it.

`ClassBoilerplate`, `StrongDescriptorArray` and `AccessorPair` were on this list
and are not any more: §4.2a decodes all three. `NameDictionary` and
`NumberDictionary` remain, and §4.2a names them as its two refusals when a class
is shaped so that V8 uses them for its templates.

### 8.5 `RegExpBoilerplateDescription` is implemented but never exercised

`BytecodeGenerator::VisitRegExpLiteral` emits
`CreateRegExpLiteral [pattern_constant_index], FBV[slot], #flags`, so a constant
pool holds the pattern as a plain string and the flags as an immediate. The
`RegExpBoilerplateDescription` is built at runtime and cached in the feedback
vector, which a code cache does not carry. The decoder handles the class — the
flag-letter mapping in particular is untested — and the corpus run reports
whether any cache contains one.

### 8.6 `isStrict` comes from the SFI, not from `ScopeFlags.language_mode`

`SharedFunctionInfoFlags.is_strict` is a bool bit and unambiguous.
`ScopeFlags.language_mode` is a `LanguageMode`, whose values Torque does not
state (§2.3); the overlay's C++ values are used to *name* it, and `languageMode`
is reported for information. If the two ever disagree, `isStrict` is the one to
trust.

### 8.7 References whose target is not in the cache

`kStartupObjectCache`, `kSharedHeapObjectCache`, `kAttachedReference`,
`kExternalReference`, `kApiReference` and `kSandboxedRawExternalReference` all
name something in the producing isolate rather than in the payload. They are
decoded structurally (the right number of slots consumed, the index or address
recorded) but their *targets* cannot be resolved here. `kAttachedReference`
index 0 is the source string, which `CodeSerializer` always attaches.

### 8.8 Tags implemented but not reachable from a code cache

`kNewContextlessMetaMap` / `kNewContextfulMetaMap` need `Map::kSize` from
`layouts.json` and refuse if it is not a whole number of tagged slots. A code
cache never contains a meta map (the map of a map is a root), so this path is
untested. The same applies to `kOffHeapBackingStore` /
`kOffHeapResizableBackingStore` (TypedArray backing stores) and
`kClearedWeakReference`.

### 8.9 `checksum` is almost always absent

V8 writes the payload checksum only when the producer ran with
`--verify-snapshot-checksum`; otherwise the field is 0. Every corpus file stores
0, so the payload-integrity check never actually runs on real input. `checksum
=== 0` is reported as "not written", not as "verified".

### 8.10 Throughput

The decoder is roughly linear in objects, but it is not fast: the corpus run's
wall time and per-file rate are in `tests/t4/CORPUS_RUN.txt`. The measurements
on this host vary by a factor of two between runs under memory pressure, so the
per-file figure should be read as an order of magnitude rather than a benchmark.
Nothing from a file is retained after its statistics are folded in — units hold
`Buffer` views into the payload, so keeping one would keep the whole payload
alive, and the corpus has a 10.2 MiB input.

### 8.11 One `(unclassified)` object per file is normal

Every corpus file contains a `WeakFixedArray` (the `Script.infos` list) with no
`layouts.json` class. It is counted, named, and carries nothing the front end
needs.

---

## 9. Measured results

Full reports: `tests/t4/ACCEPTANCE.txt`, `tests/t4/CORPUS_RUN.txt`,
`tests/t4/corpus-run.json`.

### Acceptance, against V8 14.6.202.34's own `--print-bytecode`

```
31 sources, 120 units matched by byte-for-byte bytecode equality,
0 unmatched, 1200 assertions, 0 failures
```

Capability notes from that run:

| what | result |
|---|---|
| function kinds recovered from `class-full` | classCtor, getter, setter, method, normal |
| generators / async functions detected | 2 / 2 per source, including async generators |
| handler predictions seen | `ASYNC_AWAIT` on the `await` desugaring |
| `switch` jump table | one Smi run of 8 for an 8-case dense switch |
| `TemplateObjectDescription` | `raw` and `cooked` both decoded |
| BigInt constants | `1n`, `2n`, `123456789012345678901234567890n` — including the two inside an array boilerplate |
| regexp patterns | 3/3 present as string constants (see §8.5) |
| `ScopeInfo` hash-table branch | 1 scope, 90/90 names recovered |
| `ScopeInfo` inlined branch | 70/70 names recovered |
| lazy hole | 3 uncompiled units, each with start/end positions |
| Wide / ExtraWide | both sources decode and match byte for byte |

### Corpus, all 1039 `extracted_jsc/*.jsc` against `profiles/14.4.258.16`

```
files      1039/1039 parsed, 0 failed       104.0 MiB
objects    2 485 908
units      239 979   compiled 239 979 (100.00%)   uncompiled 0
decoded    1 790 172 constants, 25 189 handler rows,
           4 406 509 source positions, 6 389 constant-pool Smi runs
header     0 errors, 1039 warnings (all of them the read-only checksum of §8.1)
           0 files with non-kNop padding, 0 unresolved forward references
wall time  464 719 ms   (447 ms/file, 0.23 KiB/ms)
```

**Context slot naming — the headline number:**

```
scopes 242 345   context slots 161 968   named 161 968 (100.00%)   anonymous 0
  129 482 from the inlined name array, 32 486 from the name hash table
  455 849 outer_scope_info links walked, deepest chain 10
  per-file rate: min 100.00%, median 100.00%, max 100.00%
  (1018 of 1039 files have at least one context slot)
```

Every context slot in the corpus resolves to a real identifier. That is the
161 968 `ctx[d][i]` placeholders the back end will not have to invent.

Read-only references: **159 497 / 159 497 occurrences resolved (100.00 %)**,
0 distinct unresolved — consistent with T2's measurement.

Function kinds, which is where `isAsync` / `isGenerator` / accessor detection
shows up:

```
93 216 normal   79 720 arrow   37 350 method   10 820 getter   5 627 classCtor
 9 887 async method   2 279 async arrow   718 async function   213 setter
    76 generator   66 generator method   5 async generator   2 async generator method
```

Handler catch predictions — the distinction the previous implementation folded
away:

```
13 713 ASYNC_AWAIT    5 821 CAUGHT    5 655 UNCAUGHT
```

So two thirds of the corpus's handler ranges are `await` desugarings, not
source-level `try`. A structuring pass that treated all 25 189 ranges as `try`
would be wrong about 13 713 of them.

### What the corpus run says about the open items

* **No uncompiled functions at all.** 239 979 SFIs, 239 979 BytecodeArrays, zero
  `UncompiledData*` objects. Whatever produced these caches compiled every
  function before serializing, so `docs/ARCHITECTURE.md` §0.1's lazy hole does
  not arise for this corpus. The code path is exercised by the
  `uncompiled-inner` acceptance source instead.
* **No `RegExpBoilerplateDescription`** anywhere in 2.49 million objects,
  confirming §8.5: the class is implemented and untested.
* 24 `BigIntBase` objects and 76 `TemplateObjectDescription` objects, so both
  are exercised by real input as well as by the oracle.
* 39 256 unresolved occurrences, all of them a named map with no `layouts.json`
  class (§8.4). 0 unnamed map words, 0 unit warnings.

---

## 10. Files

| path | role |
|---|---|
| `src/cache/*.mjs` | the container layer |
| `src/heap/*.mjs` | the object layer |
| `src/cli/dump-cache.mjs` | the CLI |
| `layouts-overlay/<tag>.json` | generated; §2 |
| `tools/layoutpatch/{index,torque-lite}.mjs` | the overlay generator |
| `tests/t4/sources.mjs` | the 31 acceptance sources, each with what it covers |
| `tests/t4/{make-cache.cjs,listing-runner.cjs}` | the two child entry points |
| `tests/t4/compare.mjs` | one unit vs one `--print-bytecode` listing |
| `tests/t4/acceptance.mjs` | the oracle run; writes `tests/t4/out/ACCEPTANCE.txt` |
| `tests/t4/selftest.mjs` | §7 |
| `tests/t4/corpus-run.mjs` | the 1039-file regression |

The old pipeline (`legacy/src/deserializer.js`, `legacy/src/lifter.js`,
`legacy/src/dataflow.js`, `legacy/src/relooper.js`, `legacy/src/decompiler.js`,
`legacy/src/profile.js`, `rules/`) still runs, unchanged except for the move
itself; `legacy/README.md` says which two of those modules current code imports
and why the other four must not be.
