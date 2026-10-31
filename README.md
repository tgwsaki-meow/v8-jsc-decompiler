# V8 bytecode cache decompiler

Turns a V8 code-cache file (`.jsc` — what `vm.Script.createCachedData()` and
Chromium's code cache write) back into readable JavaScript.

The pipeline is: deserialise the cache into typed heap objects → disassemble the
`BytecodeArray` into Ignition instructions → build a CFG with real dominators
and pruned SSA → recover expressions and names → recover control flow → emit an
AST and print it.

**Every version-specific table is generated, not hand-written.** Opcode
numbering, operand widths, object layouts, root lists, runtime function ids and
the read-only heap are derived per V8 version from pinned upstream sources
fetched over HTTPS, each recorded with its sha256. Supporting a new V8 version
is one command, not a patch to the decompiler.

> **Status: the front end and the IR are done and verified against real V8; the
> back end's last stage is in progress.** See [Status](#status). This is a
> working tool on the paths that are marked done and an honest construction site
> elsewhere — a region it cannot structure comes out marked `UNSTRUCTURED`
> rather than quietly wrong.

## What is not here

No decompiled application code, and no input corpus. This repository is the
tool. It was developed against a large real-world corpus, which is **not
redistributable** and is excluded by `.gitignore`; the committed test inputs are
270 syntax fixtures written for this project and 24 `.jsc` files minted from
them by a real V8.

## Why not just use the source maps / the original bundle

You usually can. This is for the case where you have a shipped code cache and no
source: the cache is a serialised snapshot of V8's heap, so the function
bodies, the variable names from `ScopeInfo`, the constant pool and the source
positions are all still in there. What is gone is comments, formatting, and
anything the parser folded.

| | recoverable | note |
|---|---|---|
| statements, expressions, control flow | yes | from the bytecode |
| local and closure variable names | yes | from `ScopeInfo`'s `context_local_names` |
| parameter count and function kind | yes | from `SharedFunctionInfo` |
| line/column of every statement | yes | from the source position table |
| string, number, bigint, regexp literals | yes | from the constant pool |
| comments, whitespace, original identifier spelling of non-context locals | **no** | not serialised |
| bodies of functions never compiled | **no** | only a source range is kept; emitted as a marked hole |

## Quick start

```bash
npm ci
npm test                      # every self-test that needs no V8 binary

node src/cli/dump-cache.mjs   <file.jsc>                # header, units, constant pool, scopes
node src/cli/disasm.mjs       <file.jsc> --function 3    # Ignition listing, V8's own column layout
node src/cli/dump-ir.mjs      <file.jsc> --function 3 --verify
```

The profile is selected automatically: `readCache` recomputes `Version::Hash()`
from each profile in `profiles/` and refuses a cache whose header disagrees, so
a mismatched version is an actionable error rather than a silent misparse.

### Adding a V8 version

```bash
node tools/profilegen/index.mjs --tag 14.4.258.16 --variant intl+wasm \
     --tagged-size 4 --out profiles/
node tools/profilegen/selftest.mjs
```

One thing cannot be derived from source: the **read-only heap**. A cache
references read-only objects by `(page, offset)`, and
`code-serializer.cc` emits that form only for *non-root* objects, so the
`static-roots-*.h` table resolves **0** of them (measured, not assumed). The
addresses have to come from a real snapshot blob:

```bash
node tools/oracle/gen_ro_heap.mjs --blob <v8_context_snapshot.bin> \
     --static-roots .v8src-cache/<tag>/src/roots/static-roots-intl-wasm.h \
     --tag <tag> --variant intl-wasm --out profiles/<tag>/ro-heap.json
```

Use the snapshot from the build that produced your cache — a cache header
carries that snapshot's checksum, so the tool tells you whether you have the
right one.

## Verification

Three independent oracles, because a decompiler that only checks itself proves
nothing:

| | what it does |
|---|---|
| **O1** | decompile, recompile the output with the matching V8, and compare the two bytecode streams after normalising registers, feedback slots and pool indices |
| **O2** | `decompile → recompile → decompile` must be byte-identical — catches nondeterminism and state leaks |
| **O3** | run the original and the decompiled form of our *own* fixtures in an instrumented `vm` sandbox and diff the side-effect traces |

Plus structural invariants asserted on **every function of every file** rather
than on a sample: every SSA use has exactly one reaching definition, `ipdom`
agrees with a brute-force oracle, every reachable block appears in the output
exactly once, and so on.

Measured against real V8 (`d8 --print-bytecode`, V8 14.4.258.16):

| | result |
|---|---|
| front end vs V8's own listing | **1200 assertions, 0 failures** |
| disassembler, instruction for instruction | **1680 / 1680 functions exact** |
| IR structural invariants | **17 / 17 over 239,979 functions** |
| read-only reference resolution | **883 / 883 distinct, 161,059 / 161,059 occurrences** |
| context slots resolved to a real variable name | **98.7%** of 980,989 |

## Status

| stage | state |
|---|---|
| `profiles/` — generated per-version tables | done, 85/85 |
| `src/cache` + `src/heap` — `.jsc` → typed objects | done, 1200/1200 vs V8 |
| `src/disasm` — → Ignition instructions | done, 1680/1680 exact |
| `src/ir` — CFG, dominators, pruned SSA, effects | done, 17/17 invariants |
| `src/recover` — expressions, inlining, idioms, names | done, 91/91 |
| `src/structure` — loops, conditionals, switch, try, generators | done, 63/63 |
| `src/emit` — AST + source map | **in progress** |

## Documentation

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the design reference and the
place where measurements that contradicted the design are recorded — §9, §10 and
§11 exist because each build stage disproved something. Then
[`PROFILEGEN`](docs/PROFILEGEN.md), [`FRONTEND`](docs/FRONTEND.md),
[`DISASM`](docs/DISASM.md), [`IR`](docs/IR.md),
[`RECOVER`](docs/RECOVER.md), [`STRUCTURE`](docs/STRUCTURE.md),
[`METRICS`](docs/METRICS.md), [`CI`](docs/CI.md).

## Prior art

[view8](https://github.com/suidpit/view8) (Check Point Research) is the closest
existing work and was read while building this. The differences and the reasons
are in `references/README.md` and ARCHITECTURE.md §0.

## Legal

For analysing code you are authorised to analyse — your own builds, your own
incident response, security research within scope. Decompiling third-party
software may be restricted where you are; that is on you, not on the tool.
