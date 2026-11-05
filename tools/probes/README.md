# Probes — the one-off measurements that published claims rest on

Six scripts that each answered one question about the measurement rather than
about the decompiler. They are here, and not in `scratch/`, because
`docs/O1.md`, `docs/RECOVER.md`, `docs/METRICS.md`, `src/verify/HARNESS.md`,
`src/verify/mutate.mjs` and `src/verify/o1_bytecode.mjs` all cite them as the
evidence for a number, and `.gitignore` excludes `scratch/*`: for as long as
they lived there the public repo cited evidence a reader could not get.

They are not self-tests and nothing runs them in CI. A probe answers its
question once, the answer goes into a document, and what the project keeps
running is the self-test that the probe's finding became — `probe_gap2`'s
result is check F of `tools/verify/o1_corpus_selftest.mjs`. Keep them
runnable, not green.

Run every one from the repository root; the output paths below are
cwd-relative. Two of them need the corpus (`extracted_jsc/`, not public) and
three need the Electron 40 minter from
`node tools/oracle/fetch_electron.mjs 40.0.0 <platform> --binary`, because
anything that mints has to mint with the corpus's own V8 (docs/O1.md 1).

| probe | needs | backs |
|---|---|---|
| `probe_class.mjs` | corpus | docs/FRONTEND.md 4.2a; docs/RECOVER.md 8.1, 9.3 and 9.6 |
| `probe_pool.mjs` | a cached `d8` | docs/O1.md 3.5 and 6; HARNESS.md O1 limitation 2; METRICS.md 4/12; `o1_bytecode.mjs` `blindSpot.evidence`; `mutate.mjs` header |
| `probe_gap.mjs` | corpus + minter | docs/O1.md 7.2 |
| `probe_gap2.mjs` | minter | docs/O1.md 6.3 and 7.2, now self-test F |
| `probe_rootcause.mjs` | corpus + minter | docs/O1.md 6.5 |
| `probe_closure.mjs` | corpus (`fate`, `cause`), minter (`form`) | docs/RECOVER.md 9 |

## `probe_pool.mjs` — the blind spot is the printer's, not ours

Asks why O1 calls `f([1,2,3])` and `f([2,2,3])` the same program. Dumps both
sources on `d8` and on `node`, prints every constant/literal instruction raw
and normalised, and shows that V8 renders the literal as
`<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS, <FixedArray[3]>>` and never
the element values — on `node` with a fully dumped pool as much as on a
release `d8` with a partial one. So the erasure is in the engine's listing,
upstream of `normalize.mjs`, and no normalisation choice can recover it. This
is the concrete reason O1 is not sufficient on its own and O3 exists.

```
node tools/probes/probe_pool.mjs
```

Writes its dumps to `scratch/t3/work/probe/`. Takes no arguments. Without a
cached `d8` (`.v8bin-cache/v8-*/d8*`) only the two `node` rows are meaningful.

## `probe_gap.mjs` — is the A-side unpaired count real?

26% of stream A's functions have no counterpart in stream B. If the mint or
the loader were dropping functions instead, every per-function number in
docs/O1.md would be wrong. The probe counts the same text three independent
ways: what the emitter reports it emitted, how many function literals Babel
finds actually present in the text, and how many `BytecodeArray`s our loader
finds in the `.jsc` minted from it. It also mints a second time without
`--no-lazy`, to show that the flag is load-bearing rather than cosmetic.

On `r_18269.jsc`: 230 claimed, **229** present, **76** carried. The
instrument is faithful; the gap is output loss.

```
node tools/probes/probe_gap.mjs [extracted_jsc/r_18269.jsc]
```

One JSON object on stdout. Working files in `scratch/o1corpus/gap/`.

## `probe_gap2.mjs` — which functions does a code cache carry?

The controlled follow-up, on synthetic sources, so the answer cannot be
blamed on the decompiler. Mints 16 shapes — N flat declarations with an arrow
each, nesting 2 to 20 deep, 100 declarations inside one function referenced
and unreferenced, and five flag spellings — and counts the units with
bytecode in each cache.

The cache carries everything the text creates (81/81, 201/201, 401/401), and
**2 of 102** when the inner declarations are never referenced: V8's scope
analysis does not allocate the variable of an unreferenced inner declaration,
so no `CreateClosure` is emitted and the SFI is unreachable from the parent's
constant pool. That is what an A-side unpaired function means, and it is now
check F of the O1 self-test.

```
node tools/probes/probe_gap2.mjs
```

A JSON array on stdout, one row per shape. Needs no corpus.

## `probe_rootcause.mjs` — corroborate the #1 ranked cause without the diff

The ranked cause table is built from a sequence diff, where only the first
hunk per function is independent (docs/O1.md 7.3). This probe reaches the
same conclusion without a diff at all: it decompiles a file, mints the
output, and histograms the context opcodes on both sides.

On `r_commonKitComponentXkitXDialog.jsc`, a file where A and B have the same
82 functions so nothing is confounded with function loss: stream A has 4
`CreateFunctionContext`, 10 `PushContext`, 123 `LdaImmutableCurrentContextSlot`
and 29 `ThrowReferenceErrorIfHole`; stream B has **none of them**, and
`LdaUndefined` goes 38 → 594. Closure variables were being emitted as
function-local declarations. It also prints the emitter's own counters
(`outerSlotDeclaredLocally`, `namesReadButNeverWritten`) next to the
histogram, which is how the counter was found to be undercounting by two
orders of magnitude.

```
node tools/probes/probe_rootcause.mjs extracted_jsc/r_commonKitComponentXkitXDialog.jsc [more.jsc ...]
```

A JSON array on stdout, one row per file argument; no argument means no work.
Working files in `scratch/o1corpus/rootcause/`.

## `probe_class.mjs` — what is in a `ClassBoilerplate`, and what reaches the text

`docs/RECOVER.md` §9.6 measured the cost of not decoding `%DefineClass`'s first
argument: **648 of 5 284 function literals — 12.3% —** were class members
emitted as *sibling* declarations next to a class whose body was empty, counted
as `classMembersNotDecoded`. This probe is the evidence for the decode that
closed it, and for the parts of the shape that are still refused.

Three modes:

* **`shape`** — per boilerplate, what the seven fields hold: which class each
  of the six templates resolves to, how many descriptors it carries, and which
  of those are members as against the five `ObjectDescriptor::AddConstant`
  adds itself. This is the question `decodeClassBoilerplate` was written
  against, and the answer is what decided which shapes to decode and which to
  refuse by name. On 29 files: 82 boilerplates, every properties template a
  `StrongDescriptorArray`, every elements template the canonical
  `empty_slow_element_dictionary` and every computed-properties array the
  canonical `empty_fixed_array`; 1 054 descriptors read, **648 members** (531
  instance methods, 107 getters, 4 setters, 6 static methods), 410 = 82 × 5
  added by V8, **0 refusals**, **0 unclaimed arguments**.
* **`members`** — the join `src/recover` makes: every member with the argument
  index it names, against the `%DefineClass` argument list T7 sees. 82 of 82
  `{e:'class'}` nodes carry a member list, 648 members, 0 whose value is not a
  closure, 0 refused.
* **`emit`** — the whole pipeline. `classMembersPlaced` 730 (the 648 plus 82
  constructors), **0** `class*` holes, function literals in a statement
  5 185 of 5 284 = **98.13%** (was 84.9%), and the
  `claimedByAPatternThroughItsUser:class` row of §9.3 at **0**.

```
node tools/probes/probe_class.mjs shape   --corpus extracted_jsc --stride 37
node tools/probes/probe_class.mjs members --corpus extracted_jsc --stride 37
node tools/probes/probe_class.mjs emit    --corpus extracted_jsc --stride 37
```

A table goes to stderr and one JSON object to stdout. All three need the corpus
(`extracted_jsc/`, not public); nothing from it is executed. The findings these
modes became are check `every ClassBoilerplate decodes to a member list that
fits its argument list` in `tests/t4/selftest.mjs` and
`a class member is emitted inside its class body, not beside it` in
`tools/emit/selftest.mjs`.
