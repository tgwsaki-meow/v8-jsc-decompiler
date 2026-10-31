# The verification harness — O1, O2, O3

`README.md` in this directory documents O1's comparison machinery (the parser,
the normaliser and the comparator, all T2's work). This file documents the
harness built on top of it: the three oracles, the decompiler interface they
grade, and what each oracle can and cannot see.

```
corpus/features/x.js ──mint (Electron, V8 14.4.258.16)──→ x.jsc
                          │
                          ├─ O1 ─ pipeline → JS′ ; print bytecode of BOTH sides with d8 14.4 ; normalise ; compare
                          ├─ O2 ─ pipeline → JS′ → mint → pipeline → JS″ ; JS′ must equal JS″ byte for byte
                          └─ O3 ─ run x.js and JS′ in isolated vm contexts with an instrumented global ; compare traces
```

| file | role |
|---|---|
| `corpus.mjs` | manifest loader, stratified sampling, **execution policy** |
| `mint.mjs` + `mint_child.cjs` | source → `.jsc`, with a pluggable producing engine |
| `pipeline.mjs` + `pipeline_child.mjs` | the decompiler behind one interface, forked, capped, never throwing |
| `trace.mjs` | deterministic value serialisation + the instrumented global |
| `mutate.mjs` | one-token mutations for the discrimination self-checks |
| `o1_bytecode.mjs` | O1 + its identity/discrimination self-check |
| `o2_fixpoint.mjs` | O2 + the `cachedData` mechanism control |
| `o3_behaviour.mjs` + `o3_child.mjs` | O3 + its identity/discrimination/policy self-check |
| `run_oracles.mjs` | CLI |

## The decompiler interface

Everything grades the pipeline through this, so T4/T5/T6 can replace the
implementation without touching an oracle:

```js
decompile(jscPath)        -> { ok, code, perFunction: [{index, name, code, bytes}], stats…, error }
decompileInChild(jscPath, { timeoutMs, maxOldSpaceMB, codePath })  // same shape, forked
```

Default implementation: `src/decompiler.js` → `new V8Decompiler().decompileFile(path)`.
Override with `V8D_PIPELINE=<module>` or `--pipeline <module>`; the module needs
to export `decompileFile` / `decompile` / `default`, or a `V8Decompiler` class.

`decompileInChild` is what the oracles and the metric collectors use. A throw,
an out-of-memory, a hard crash and a hang all come back as a row with `ok:false`
and a `stage`, because this host has 4 GB and the pipeline under test has inputs
that take minutes and 1.5 GB. **A broken pipeline must not break a measurement
run.**

## Which engine does what, and why

| job | engine | why |
|---|---|---|
| mint the `.jsc` | Electron 40.0.0 as node (`ELECTRON_RUN_AS_NODE=1`), V8 **14.4.258.16** | same build as the corpus: magic `0xc0de0674` and versionHash `0x12819a30` match `extracted_jsc/*.jsc` exactly. The local node is V8 14.6.202.34, whose cache the 14.4 tables mis-decode (six comparison bytecodes changed operand type — ARCHITECTURE.md §1.3) |
| print bytecode | `d8` 14.4.258.17 from `.v8bin-cache` | measured: `node --print-bytecode` on a 12-line corpus file prints **517** functions (its own bootstrap) against d8's **2**. A whole-file comparison needs the listing to contain only the file |
| run traces (O3) | the local node, in a `vm` context | O3 compares behaviour, not encoding, so the engine version is not part of the question |

`mint.mjs` falls back to the local node when Electron is absent and every row
records which minter produced it. Get Electron with
`node tools/oracle/fetch_electron.mjs 40.0.0 win32-x64` and then
`tar -xf .v8bin-cache/electron-v40.0.0-win32-x64.zip -C .v8bin-cache/electron-v40.0.0-win32-x64`.

## O1 — bytecode equality

Both streams come from a real V8, so O1 does not depend on our own decoder
being correct. It answers exactly: *does the decompiled text compile to the
same program the original compiled to?*

Functions are paired by name first; leftovers are paired greedily by opcode
similarity when both sides are small, else positionally. The pairing mode is in
every row, because a number produced by positional pairing means less than one
produced by name matching. Per function: `exactMatch`, Dice-over-LCS opcode and
instruction similarity, prefix length, first divergence. Metric 4 is the mean
and median of the per-function opcode similarity over all paired functions.

**Two limits, both measured rather than assumed.**

1. *A V8 run executes the script after printing its bytecode.* There is no
   compile-only mode for `--print-bytecode`. O1 is therefore corpus-only, like
   O3, and `assertExecutable()` enforces it. O1 against `extracted_jsc/` needs
   our own decoder for stream A — that is T4/T5, and it is the diagram in
   `README.md`.
2. *Values inside boilerplate constants are invisible.* V8 prints an array
   literal as `<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS,
   <FixedArray[3]>>` and never prints the element values — on `node` with a
   fully dumped pool as well as on a release `d8`
   (`scratch/t3/probe_pool.mjs`). Changing `f([1,2,3])` to `f([2,2,3])` is
   therefore an exact O1 match. O3 catches it. This is the concrete reason
   three oracles exist instead of one.

## O2 — round-trip fixpoint

`decompile → mint → decompile`; the two outputs must be byte-identical.
Catches instability and state leaking between runs: a decompiler whose output
depends on a cache, a counter or a visit order. It is also the cheapest check
that the output is *compilable*, because step 3 cannot mint a `.jsc` from text
V8 rejects.

O2 says nothing about correctness — a decompiler that emits `0;` for everything
has a perfect fixpoint — so it is only ever read next to O1.

Mechanism control: `new vm.Script(src, {cachedData})` sets
`cachedDataRejected = true` when the cached data was not produced from `src`.
The control asserts `false` for the same source and `true` for a mutated one,
which proves the round trip is checking the source rather than accepting
anything.

## O3 — behavioural differential, corpus only

The trace is the ordered list of observable effects: every `T(label, …)` the
file makes, every property write or call routed through `G`, every `console.*`,
the completion value, and anything that escaped as a throw. Serialisation is
total, cycle-safe and deterministic (`trace.mjs`); functions serialise as
`[function/<arity>]` without their name, because function names are a
symbol-recovery question (metric 5) and folding them in would make every row
fail for a naming reason. A corpus file that cares about `f.name` traces it
explicitly as a string, and that comparison is kept.

Each side runs in its own process, so an infinite loop in a bad decompilation
costs one row and a timeout. Modules run through `vm.SourceTextModule` with a
linker that resolves relative specifiers inside the corpus directory.

**Accommodation A1.** The current emitter wraps the whole script body in
`function main(){…}` and never calls it, so a decompiled script would trace
nothing for a packaging reason rather than a semantic one. When the decompiled
side produces an otherwise empty trace and a `main` function exists, O3 calls
`main()` once and sets `invokedMain` on the row. It fires only in that case, so
it becomes inert as soon as the emitter emits top-level code.

## Execution policy

Stated in `corpus.mjs` and enforced by `assertExecutable()`:

> The only JavaScript this project executes is `corpus/features/**` and the
> decompiler's output for those files, under `scratch/t3/work/`.
> `extracted_jsc/` and `decompiled_js/` are reverse-engineered third-party code
> from a chat client; they are read, parsed, disassembled and compared, never
> run.

`extracted_jsc/` and `decompiled_js/` are on an explicit denylist, everything
outside the two allowed roots is refused, the O3 child re-checks after the fork,
and the self-check asserts that a path under `decompiled_js/` is rejected.

## Self-checks

An oracle that always answers "match" passes every identity check, so each one
is shown both halves:

```
node src/verify/run_oracles.mjs --selfcheck
```

| check | assertion |
|---|---|
| O1 identity | an identity decompiler (output = input) scores 100% exact on every function |
| O1 discrimination | a one-token mutation is not exact; mutations O1 cannot see are listed as its blind spot |
| O2 control | `cachedDataRejected` is `false` for the same source and `true` for a mutated one |
| O3 identity | the same file traced twice is identical |
| O3 discrimination | a one-token mutation changes the trace (candidates are tried until one is observable, because `unshift` on an empty array is `push`) |
| O3 policy | a path under `decompiled_js/` is refused |

## Usage

```powershell
node src/verify/run_oracles.mjs --selfcheck
node src/verify/run_oracles.mjs --all --sample 24
node src/verify/run_oracles.mjs --o1 --grep '^try-'
node src/verify/run_oracles.mjs --o3 --group class --keep-traces
node src/verify/run_oracles.mjs --all --minter node          # fall back to V8 14.6
node src/verify/run_oracles.mjs --all --pipeline src/newdec.mjs
```

Results are always written as JSON (`scratch/t3/oracles/`); stdout is a
summary. Redirect it to a file rather than piping it.

## Row statuses

| status | meaning |
|---|---|
| `match` / `fixpoint` | the oracle is satisfied |
| `ok` | compared, not identical (O1: see `meanOpcodeSimilarity` and `firstDivergence`) |
| `differ` | O3 traces diverge; `firstDivergence` names the record |
| `unstable` | O2: the two outputs differ; `firstDifference` gives the offset |
| `mint-failed` | V8 would not compile the source, or the minter crashed |
| `pipeline-threw` / `pipeline-timeout` | the decompiler failed on the input; `errorClass` and `error` are kept verbatim |
| `output-unparseable` | the emitted text is not parseable JavaScript |
| `recompile-failed` | O2: V8 would not compile the decompiler's output |
| `engine-failed` / `engine-no-functions` | the `--print-bytecode` run produced nothing usable |
| `original-no-effects` | the corpus file itself traces nothing — a corpus defect, not a pipeline one |
| `refused` | the execution policy blocked it |
