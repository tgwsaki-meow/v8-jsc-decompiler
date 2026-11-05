# V8 `.jsc` → JS Decompiler: Quantified Baseline Audit

Measurement only. No file under `src/`, `rules/`, `tools/`, `decompiled_js/` or
`extracted_jsc/` was modified. Everything new lives under `scratch/audit/`.

| | |
|---|---|
| Date | 2026-10-29 (UTC) |
| Host | Windows, pwsh, **4.0 GB total RAM** (≈180 MB free physical during the run) |
| Node | v26.12.1 |
| Parser | `@babel/parser` 8.0.8, `@babel/traverse` 8.0.7 (installed for this audit) |
| Entry point under test | `src/decompiler.js` → `new V8Decompiler().decompileFile(path)` |
| Profile | `rules/v8-14.4.258.16.json` (212 opcodes) |
| Corpus | `decompiled_js/` 1039 `.js` files, 309,051,093 bytes; `extracted_jsc/` 1039 `.jsc` files |

The 4 GB memory ceiling shaped the methodology: every script streams or forks a
child process instead of loading the corpus into memory. Where that mattered it
is called out.

---

## 0. Headline numbers

| Question | Answer |
|---|---|
| What fraction of the output is valid JavaScript? | **1039 / 1039 = 100.00%** parse clean as `sourceType: 'script'` |
| Opcodes in profile vs handled by `src/dataflow.js` | **212 / 212 = 100%**; **0** unhandled |
| Unhandled-opcode share of 2,766,343 real instructions | **0.0000%** |
| Lifter failures over 2,766,343 instructions / 58,413 functions | **0** |
| `.jsc` inputs that decompile end-to-end (12 sampled, 180 s budget) | **10 / 12**; 2 time out |
| Deserialized functions that reach the emitted text (10 successes) | **5,051 / 13,030 = 38.76%** aggregate; per-file median **96.78%** |
| Free identifiers in the output that are invented placeholders | **70.0%** of free references (20-file sample) |
| Files containing raw context slots `ctx.slot_<N>` | **1018 / 1039 = 98.0%** |
| **Loop statements emitted for 167 `JumpLoop` back-edges (same 20 files)** | **0** |
| **`try` statements emitted for 667 exception opcodes (same 20 files)** | **0** |
| **`switch` statements emitted for 160 switch-dispatch opcodes** | **0** |
| Loop statements in the 60-file AST sample (any kind) | **0** |
| Adjacent statement pairs that duplicate a side-effecting call | **2787 / 21,550 = 12.9%** |
| Allocation expressions re-emitted per use (object identity destroyed) | **2160 / 4297 = 50.3%** |

The output is **syntactically perfect and semantically broken**. That inverts the
obvious hypothesis and it is the single most important thing this audit found.
`@babel/generator` cannot emit invalid syntax from a valid AST, so 100%
parseability is a property of the *printer*, not evidence of correctness. The two
metrics the brief expected to be damning — parseability and opcode coverage — are
both already saturated at 100%, and both are measuring the wrong thing.

The actual defect is worse than placeholder names: **`src/relooper.js` does not
reconstruct loops.** Across 20 files whose bytecode contains 167 `JumpLoop`
back-edges, the corresponding output contains zero loop statements of any kind,
zero `break`, zero `continue` and zero `switch`. Across the whole 309 MB corpus,
at most 2 files contain a `while` and 6 contain a `for`. Every loop in every
input program has been flattened into straight-line or `if`-guarded code, so the
output does not just look wrong — it computes something different. See §5.4.

---

## 1. Corpus static audit

Script: `scratch/audit/audit_corpus.mjs`. Streams each file in 1 MB chunks split
on newlines (markers never span a newline), so the 115 MB output never enters
memory whole. Run time 15.9 s for 309 MB.

```
node scratch/audit/audit_corpus.mjs
```

### 1.1 Totals

| Metric | Value |
|---|---|
| Files | 1039 |
| Total bytes | 309,051,093 |
| Empty files (0 bytes) | **0** |
| Banner-only files (nothing but `"[Decompiled from: …]";`) | **0** |
| Smallest / largest output | 304 B (`r_73065.js`) / 115,185,723 B (`r_8878.js`) |

No output is empty or a bare banner. Every one of the 1039 files has a body.

### 1.2 Marker counts, full corpus

`total` = occurrences across all 1039 files. `filesWith` = files containing at
least one. Each row is one precise regex, listed so the number is reproducible.

| Marker class | Regex | Total | filesWith | % of files |
|---|---|---|---|---|
| `__the_hole__` | `/__the_hole__/g` | 58,151 | 974 | 93.7% |
| `__runtime_<N>(` call | `/\b__runtime_\d+\s*\(/g` | 488 | 57 | 5.5% |
| `__runtime_<N>` any ref | `/\b__runtime_\d+\b/g` | 488 | 57 | 5.5% |
| `__intrinsic_<N>` | `/\b__intrinsic_\d+\b/g` | 37,513 | 291 | 28.0% |
| `__obj_<N>` | `/\b__obj_\d+\b/g` | 435 | 43 | 4.1% |
| `ctx.slot_<N>` | `/\bctx\.slot_\d+\b/g` | **1,710,336** | **1018** | **98.0%** |
| `ctx_d<N>.slot_<N>` | `/\bctx_d\d+\.slot_\d+\b/g` | **582,886** | 755 | 72.7% |
| register `r<N>` | `/\br\d+\b/g` | **1,775,206** | 978 | 94.1% |
| param `a<N>` | `/\ba\d+\b/g` | **1,856,031** | **1039** | **100%** |
| `__caughtErr` | `/\b__caughtErr\b/g` | **0** | 0 | 0% |
| `__state` | `/\b__state\b/g` | **0** | 0 | 0% |
| `switch (__state)` | `/switch\s*\(\s*__state\s*\)/g` | **0** | 0 | 0% |
| `acc` | `/\bacc\b/g` | 119 | 6 | 0.6% |
| `arguments` | `/\barguments\b/g` | 27,016 | 708 | 68.1% |
| `break` token | `/\bbreak\b/g` | 341 | 16 | 1.5% |
| `continue` token | `/\bcontinue\b/g` | 405 | 12 | 1.2% |
| `this` | `/\bthis\b/g` | 390,606 | 830 | 79.9% |
| `function func_<N>` decl | `/\bfunction\s+func_\d+\b/g` | 380,811 | 1039 | 100% |
| bare `func_<N>` ref | see §1.4-§1.5 | 6,053 → **corrected to 0** | 273 → **0** | — |

Three classes are **exactly zero across the whole corpus**: `__caughtErr`,
`__state` and `switch (__state)`. `__caughtErr` is seeded by
`src/decompiler.js:58` for every `try`/`catch` handler block and `__state` is
emitted by `src/relooper.js:170` for irreducible control flow. Both are
unreachable in practice on this corpus. That means the irreducible-CFG path of
the relooper and the exception-handler path have **zero** coverage from these
1039 outputs — not that they work.

### 1.3 Top 20 files by marker density

`markerTotal` counts the leak classes only (`__the_hole__`, `__runtime_<N>`,
`__intrinsic_<N>`, `__obj_<N>`, `ctx.slot_<N>`, `ctx_d<N>.slot_<N>`, `r<N>`,
`a<N>`, `__caughtErr`, `__state`, `acc`, bare `func_<N>`); `function func_<N>`
declarations and `this` are excluded. Density is markers per KB of output.

| # | File | Bytes | Markers | Markers/KB |
|---|---|---|---|---|
| 1 | `r_commonNodeModuleXieee754.js` | 3,892 | 217 | 57.09 |
| 2 | `r_commonNodeModuleXbase64Xjs.js` | 4,676 | 249 | 54.53 |
| 3 | `b_4background.js` | 34,423 | 1,800 | 53.55 |
| 4 | `r_10305.js` | 1,349 | 68 | 51.62 |
| 5 | `r_75746.js` | 12,720 | 626 | 50.39 |
| 6 | `r_79117.js` | 1,646 | 81 | 50.39 |
| 7 | `r_59781.js` | 1,357 | 66 | 49.80 |
| 8 | `r_12066.js` | 1,040 | 50 | 49.23 |
| 9 | `r_7438.js` | 39,566 | 1,877 | 48.58 |
| 10 | `r_71248.js` | 7,276 | 343 | 48.27 |
| 11 | `r_356.js` | 2,294 | 108 | 48.21 |
| 12 | `r_10795.js` | 3,595 | 169 | 48.14 |
| 13 | `r_60031.js` | 8,902 | 415 | 47.74 |
| 14 | `b_536background.js` | 3,565 | 166 | 47.68 |
| 15 | `b_648background.js` | 3,565 | 166 | 47.68 |
| 16 | `r_73162.js` | 13,049 | 607 | 47.63 |
| 17 | `r_14302.js` | 23,086 | 1,073 | 47.59 |
| 18 | `r_50295.js` | 990 | 46 | 47.58 |
| 19 | `r_811.js` | 2,412 | 112 | 47.55 |
| 20 | `r_45302.js` | 1,165 | 54 | 47.46 |

Roughly one placeholder token every 20 bytes at the top of the distribution.
The density range across the corpus is narrow, so this is not a tail of a few
bad files — it is the normal texture of the output.

### 1.4 Validating the lexical counts against the AST

Script: `scratch/audit/ast_census.mjs`. A lexical regex also matches inside
string literals, so the same 60-file stratified sample (4,721,319 chars, all
files ≤ 1.5 MB) was counted both lexically and by walking the AST.

```
node scratch/audit/ast_census.mjs
```

| Marker | Lexical | AST-exact | Overcount | Verdict |
|---|---|---|---|---|
| `__the_hole__` | 1,939 | 1,939 | 1.000 | lexical count is exact |
| `__runtime_<N>` | 6 | 6 | 1.000 | exact |
| `__intrinsic_<N>` | 1,716 | 1,716 | 1.000 | exact |
| `__obj_<N>` | 1 | 1 | 1.000 | exact |
| `ctx.slot_<N>` | 35,796 | 35,796 | 1.000 | exact |
| `ctx_d<N>.slot_<N>` | 20,546 | 20,546 | 1.000 | exact |
| `r<N>` | 28,825 | 28,825 | 1.000 | exact |
| `a<N>` | 38,568 | 38,568 | 1.000 | exact |
| `arguments` | 615 | 603 | 1.020 | 12 hits were inside strings |
| `this` | 10,340 | 10,324 | 1.002 | 16 hits inside strings |
| `break` | 2 | **0** | — | both lexical hits were inside strings |
| `continue` | 0 | 0 | — | — |
| bare `func_<N>` | 262 | **0** | — | **all 262 were generator declarations** |
| `function func_<N>` | 10,184 | 10,446 | 0.975 | lexical regex missed `function* func_<N>` |

Two corrections fall out of this, and both matter.

**Correction A — there are no unresolved closures.** `audit_corpus.mjs`
classified `func_<N>` as a declaration only when preceded by `function\s+`, so
generator declarations `function* func_<N>` were misfiled as bare references.
`src/decompiler.js:128-136` sets the generator flag whenever a function contains
`SuspendGenerator`/`ResumeGenerator`, so these are declarations, not dangling
references. `scratch/audit/corrections.mjs` recounts the full corpus with the
generator form included; see §1.5. **The reported 6,053 "unresolved closures" is
an artifact of my regex, not a decompiler defect.**

**Correction B — `break`/`continue` outside a loop does not occur.** This cannot
be answered lexically and does not need to be: `@babel/parser` rejects
unsyntactic `break`/`continue` with `reasonCode: IllegalBreakContinue`, which
the control experiment in §2.3 confirms. Since **0 of 1039** files fail to parse,
**0** files contain a `break` or `continue` outside a valid target. §1.5
re-checks every file that lexically contains either token with a real AST walk
that tracks loop and switch nesting.

### 1.5 Corrections applied to the full corpus

Script: `scratch/audit/corrections.mjs`. Both corrections recount all 1039 files,
not a sample.

```
node scratch/audit/corrections.mjs
```

**C1 — `func_<N>` naming**

| Metric | Value |
|---|---|
| Total `func_<N>` declarations | **386,864** |
| of which generator declarations (`function* func_<N>`) | **6,053** |
| **Truly bare (unresolved) `func_<N>` references** | **0, in 0 files** |
| Previously reported by `audit_corpus.mjs` | 6,053 |

The 6,053 figure was exactly the generator count. **There are no unresolved
closure references anywhere in the corpus.** `src/dataflow.js:109` and
`src/dataflow.js:68` can emit a bare `func_<N>` when a `FunctionRef` or
`BytecodeArrayRef` cannot be resolved, and that path never fires here.

**C2 — `break` / `continue` outside a loop**

Every file whose text lexically contains either token was re-parsed and walked
with loop/switch nesting tracked.

| Metric | Value |
|---|---|
| Files lexically containing `break` or `continue` | 19 |
| Lexical `break` / `continue` tokens | 341 / 405 |
| **Real AST `BreakStatement` / `ContinueStatement`** | **0 / 0** |
| **`break` outside both loop and switch** | **0** |
| **`continue` outside any loop** | **0** |

All 746 lexical hits are inside string literals. The answer to the requested
check is **zero** — and §5.4 shows why that is bad news rather than good.

### 1.6 `arguments` in a function with no declared parameters

AST-exact over the 60-file sample: **443 of 603** `arguments` references (73.5%)
sit inside a function whose parameter list is empty. This is legal JavaScript, so
no syntax check catches it, but it means `src/decompiler.js:121-127` derived
`parameterCount = 0` for a function that the bytecode proves takes arguments
(`CreateMappedArguments`/`CreateUnmappedArguments` only appear in functions that
reference `arguments`). The parameter list is being lost, not the `arguments`
object.

---

## 2. Parseability — the headline number

Scripts: `scratch/audit/audit_parse.mjs` (driver) + `scratch/audit/parse_worker.mjs`
(child). The worker writes a `{"ev":"start"}` line *before* each file so an
uncatchable V8 OOM is attributed to the exact file that caused it rather than
losing a whole batch. Children are capped at `--max-old-space-size=2048` and
batched 40 files at a time, with a 180 s no-progress watchdog.

```
npm i -D @babel/parser @babel/traverse
node scratch/audit/audit_parse.mjs
```

### 2.1 Result

| Metric | Value |
|---|---|
| Files attempted | 1039 |
| Records written | 1039 (none lost) |
| **Parse OK** | **1039 (100.00%)** |
| **Parse FAIL** | **0 (0.00%)** |
| OK as `sourceType: 'script'` | 1039 |
| Needed `sourceType: 'module'` | 0 |
| Bytes parsed OK | 309,051,093 (100%) |
| Process crashes / OOM / watchdog kills | 0 |
| Wall time | 234.6 s |

### 2.2 Histogram of syntax-error messages

**Empty.** There are no syntax errors to rank, so the requested top-15 table has
no rows:

| # | reasonCode | Count |
|---|---|---|
| — | *(no failures)* | 0 |

The largest output parses too, which is the case most likely to break: 115 MB,
read and parsed in 15.3 s inside the 2 GB-capped worker. The five slowest parses
were `b_86background.js` 48.8 s, `b_nodeXpluginbackground.js` 31.5 s,
`b_357background.js` 18.5 s, `r_8878.js` 15.3 s, `b_background_ex.js` 10.1 s —
all successful.

### 2.3 Control experiment — is the 100% real?

A 100% pass rate is exactly the shape of a vacuously-passing test, so it was
checked both ways. Script: `scratch/audit/control_parse.mjs`.

```
node --max-old-space-size=2048 scratch/audit/control_parse.mjs
```

**Negative controls.** `decompiled_js/r_73065.js` mutated into invalid JS five
ways, through the identical `parse()` call:

| Mutation | parseOK | Error |
|---|---|---|
| unmodified original | **true** | — |
| drop final `}` | false | `[UnexpectedToken]` Unexpected token (12:0) |
| `continue;` outside a loop | false | `[IllegalBreakContinue]` Unsyntactic continue. (8:8) |
| `break;` outside a loop | false | `[IllegalBreakContinue]` Unsyntactic break. (8:8) |
| `this` as a parameter name | false | `[UnexpectedKeyword]` Unexpected keyword 'this'. (7:37) |
| stray `*;` operator | false | `[UnexpectedToken]` Unexpected token (8:18) |

The check rejects everything it should, including both forms of unsyntactic
`break`/`continue`.

**Positive control on the 115 MB file.** `decompiled_js/r_8878.js`,
115,182,522 chars: parsed, `program.body.length = 1` (a single `function main`,
with the banner captured as a Program directive), **5,732,759 AST nodes counted**
by explicit recursive walk, peak RSS 346 MB / heapUsed 1,300 MB. A real tree was
built; nothing was skipped.

One discrepancy worth stating: this control measured 312,922 ms for the same
file the worker did in 15,304 ms. The control uses default parser options, which
include comment attachment; `parse_worker.mjs` passes `attachComment: false`,
`tokens: false`, `ranges: false`. Both agree the file is valid; only the cost
differs.

### 2.4 Independent cross-check with V8's own parser

`scratch/audit/free_identifiers.mjs` additionally compiles each file it examines
with `new vm.Script(src)` — V8's own parser, a different implementation from
Babel. **20 / 20** sampled files compile. Compilation only; the code is never
executed, since it is reverse-engineered third-party code from a chat client and
running it is not something an audit needs to do.

### 2.5 What this number does and does not mean

`src/decompiler.js` builds a `@babel/types` AST and prints it with
`@babel/generator`. A valid AST cannot print as invalid JavaScript, so 100%
parseability is guaranteed by construction for every input that survives
`decompileFile` without throwing. It confirms the AST is well-formed. It says
nothing about whether the program means what the bytecode meant — and §3-§5 show
that it mostly does not.

The more informative framing: **of 1039 `.jsc` inputs, 1039 produced output that
is valid JavaScript, and ~0 produced output that would run.**

---

## 3. Pipeline liveness

Scripts: `scratch/audit/run_pipeline.mjs` (driver) + `scratch/audit/pipeline_one.mjs`
(child, one `.jsc` per process). Hard 180 s timeout, `--max-old-space-size=2048`.
The child times deserialization separately from `decompileFile` so a
deserializer failure is distinguishable from a lifter/dataflow/relooper failure.

```
node scratch/audit/run_pipeline.mjs
```

Selection from the 1039 `.jsc` files sorted by size: smallest 3 (indices 0-2),
3 straddling the median (518-520), largest 3 (1036-1038), plus the three named
files.

### 3.1 Result table

`deserFns` = functions reported by the deserializer. `emitTop` = top-level
function declarations in the output. `emitFnKw` = total `function` keywords in
the output (one per materialised function body, including inlined closures).

| # | `.jsc` | Bucket | Input B | OK | Stage | Wall ms | deserMs | deserFns | emitTop | emitFnKw | Output B | Peak RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `r_73065.jsc` | smallest | 832 | ✅ | complete | 290 | 80.7 | 3 | 1 | 3 | 304 | 48.4 |
| 2 | `r_82276.jsc` | smallest | 832 | ✅ | complete | 509 | 180.7 | 3 | 1 | 3 | 304 | 49.2 |
| 3 | `r_loginXapp.jsc` | smallest | 832 | ✅ | complete | 378 | 78.5 | 3 | 1 | 3 | 308 | 49.2 |
| 4 | `r_commonNodeModuleXxmlXjs.jsc` | median | 25,752 | ✅ | complete | 545 | 149.6 | 50 | 1 | 54 | 46,659 | 68.5 |
| 5 | `r_98447.jsc` | median | 25,824 | ✅ | complete | 318 | 80.6 | 75 | 1 | 98 | 25,158 | 70.8 |
| 6 | `r_8305.jsc` | median | 25,936 | ✅ | complete | 271 | 55.5 | 93 | 1 | 97 | 17,845 | 67.0 |
| 7 | `b_86background.jsc` | largest | 6,113,080 | ✅ | complete | 166,223 | 1,305.3 | 12,289 | 1 | 6,790 | 3,008,045 | 1,493.7 |
| 8 | `b_nodeXpluginbackground.jsc` | largest | 8,099,944 | ❌ | **TIMEOUT** | 288,769 | — | — | — | — | — | — |
| 9 | `r_8878.jsc` | largest | 10,708,024 | ❌ | **TIMEOUT** | 189,922 | — | — | — | — | — | — |
| 10 | `b_background.jsc` | named | 77,200 | ✅ | complete | 95,934 | 922.8 | 237 | 1 | 241 | 67,910 | 124.1 |
| 11 | `internal_index.jsc` | named | 3,448 | ✅ | complete | 20,635 | — | 4 | 1 | 4 | 2,425 | — |
| 12 | `p_preload.jsc` | named | 91,960 | ✅ | complete | 87,387 | — | 273 | 1 | 375 | 132,780 | — |

**10 / 12 succeed. 2 / 12 time out.**

### 3.2 Failures, stated exactly

Neither failure is an exception — nothing threw. Both are wall-clock timeouts:

| `.jsc` | Error class | Exact message |
|---|---|---|
| `b_nodeXpluginbackground.jsc` | `TimeoutError` | `killed after 180000 ms (no result)` |
| `r_8878.jsc` | `TimeoutError` | `killed after 180000 ms (no result)` |

Zero exceptions were raised in 10 successful runs and 2 timeouts: no
`UnsupportedBytecodeError`, no `MissingExitConditionError`, no
`UninitializedAccumulatorError`, no `ConstantPoolOutOfBoundsError`, no
`UnknownReadOnlyHeapRefError`. Every fail-fast guard in `src/dataflow.js` and
`src/decompiler.js` stayed silent on this sample.

Note on the timeout column: driver wall time for entry 8 reads 288,769 ms
against a 180,000 ms budget. The watchdog fired on schedule; the extra ~109 s is
how long the `SIGKILL`-ed child took to actually exit on a host that was paging
heavily. The timeout is real; the wall figure is not a decompile time.

### 3.3 Timing is pathological relative to input size

| `.jsc` | Input B | Decompile ms | ms per input KB |
|---|---|---|---|
| `r_8305.jsc` | 25,936 | 102 | 4.0 |
| `r_commonNodeModuleXxmlXjs.jsc` | 25,752 | 212 | 8.4 |
| `internal_index.jsc` | 3,448 | ~20,600 | **5,975** |
| `b_background.jsc` | 77,200 | 33,714 | 437 |
| `p_preload.jsc` | 91,960 | ~86,400 | 940 |
| `b_86background.jsc` | 6,113,080 | 155,460 | 25.4 |

`internal_index.jsc` is 3.4 KB with 4 functions and takes ~20 s — roughly 1,500×
the per-byte cost of `r_8305.jsc`. Cost is not driven by input size, so the two
timeouts are not simply "the files are big". Wall times also vary with host
load: re-running `b_background.jsc` on an idle box took 34,638 ms versus 95,934 ms
during the batch, so treat these as order-of-magnitude figures.

### 3.4 Functions emitted vs functions deserialized

Script: `scratch/audit/emitted_fns.mjs`. `src/decompiler.js` names every function
`main` or `func_<index>` where `<index>` is its position in the deserializer's
function list, so counting **distinct** emitted names is an exact count of how
many deserialized functions reached the output text.

```
node scratch/audit/emitted_fns.mjs
```

| `.jsc` | deserFns | in `fnCache` | distinct emitted | emitted % |
|---|---|---|---|---|
| `r_73065.jsc` | 3 | 3 | 3 | 100% |
| `r_82276.jsc` | 3 | 3 | 3 | 100% |
| `r_loginXapp.jsc` | 3 | 3 | 3 | 100% |
| `r_commonNodeModuleXxmlXjs.jsc` | 50 | 50 | 50 | 100% |
| `r_98447.jsc` | 75 | 75 | 69 | 92.00% |
| `r_8305.jsc` | 93 | 93 | 87 | 93.55% |
| `b_86background.jsc` | 12,289 | 12,289 | **4,408** | **35.87%** |
| `b_background.jsc` | 237 | 237 | 216 | 91.14% |
| `internal_index.jsc` | 4 | 4 | 4 | 100% |
| `p_preload.jsc` | 273 | 273 | 208 | 76.19% |
| **Total** | **13,030** | **13,030** | **5,051** | **38.76%** |
| **Median** | | | | **96.78%** |

Note the shape of this: `fnCache` contains **every** function for **every** file,
yet 7,979 of them never appear in the output. `decompileFile` only emits a
function at top level when it is absent from `fnCache`
(`src/decompiler.js:174`), and `decompileFunctionById` populates `fnCache` as a
side effect of resolving a closure reference. A function whose inlined copy lands
inside a body that the relooper or the accumulator-to-statement logic later
discards is therefore cached, suppressed from top-level emission, and silently
lost. The aggregate 38.76% is dominated by `b_86background.jsc`; the typical file
loses 4-24%.

### 3.5 Is the output reproducible, and is `decompiled_js/` current?

`decompiled_js/` is described as previously generated output, so freshly produced
text was SHA-256 compared against it.

| `.jsc` | fresh B | stored B | ratio | byte-identical |
|---|---|---|---|---|
| `r_73065.jsc` | 304 | 304 | 1.000 | ✅ |
| `r_82276.jsc` | 304 | 304 | 1.000 | ✅ |
| `r_loginXapp.jsc` | 308 | 308 | 1.000 | ✅ |
| `r_commonNodeModuleXxmlXjs.jsc` | 46,659 | 46,659 | 1.000 | ✅ |
| `r_98447.jsc` | 25,158 | 25,158 | 1.000 | ✅ |
| `r_8305.jsc` | 17,845 | 17,845 | 1.000 | ✅ |
| `internal_index.jsc` | 2,425 | 2,425 | 1.000 | ✅ |
| `p_preload.jsc` | 132,780 | 132,780 | 1.000 | ✅ |
| `b_86background.jsc` | 3,008,045 | 13,391,022 | **4.452** | ❌ |
| `b_background.jsc` | 67,910 | 291,682 | **4.295** | ❌ |
| `b_nodeXpluginbackground.jsc` | — (timeout) | 11,077,702 | — | not comparable |
| `r_8878.jsc` | — (timeout) | 115,185,723 | — | not comparable |

**8 of 10 comparable files are byte-identical**, so `decompiled_js/` is mostly
reproducible by the current `src/` and the tasks 1-2 numbers do describe current
behaviour. Two files do not match, and current code produces roughly a quarter
of the stored text for both:

| | distinct emitted fns (fresh) | distinct emitted fns (stored) |
|---|---|---|
| `b_86background.jsc` | 4,408 | **10,575** |
| `b_background.jsc` | 216 | **226** |

`b_background.jsc` was decompiled twice to separate nondeterminism from
regression. Both runs produced SHA-256 `4ace20190710eca8…` (67,910 B); the stored
file is `8b44f693438fb1e0…` (291,682 B). **The decompiler is deterministic**, so
the stored output for these two files was produced by different code. Whatever
changed between then and now dropped ~58% of the emitted functions in
`b_86background.jsc`. Also note that the two stored files that differ are the
only two where current code could not reproduce the result — and the two inputs
that time out are both in the same `b_*` family.

---

## 4. Opcode coverage gap

### 4.0 Reading `tools/count_opcodes.js` first

As instructed, `tools/count_opcodes.js` was read before writing anything. It is
**stale and silently broken**, which matters because it is the existing answer to
this question:

| Issue | Detail |
|---|---|
| Feeds `fn.bytecode.subarray(4)` to the lifter | `StrictV8Deserializer.extractFunctions` already slices the 12-byte `BytecodeArray` header (`src/deserializer.js`, `raw.subarray(12, 12+len)`). Removing 4 more bytes starts disassembly mid-instruction. |
| Passes `res.strings` as the constant pool | `deserializeFile` returns `{header, root, functions, …}`. There is no `strings` key, so `undefined` is passed and the lifter falls back to `constants = []`. |
| `catch(e) {}` with an empty body | Every resulting failure is swallowed, so the tool prints a plausible-looking table built from whatever survived. |

Quantified as a control inside `opcode_coverage.mjs`, on the same 20 files:

| Method | Functions disassembled OK | Functions failed | Instructions |
|---|---|---|---|
| `fn.bytecode` (what `src/decompiler.js` does) | **3,710** | **0** | **151,481** |
| `fn.bytecode.subarray(4)` (what `count_opcodes.js` does) | 2,319 | **1,162** | 76,462 |

`count_opcodes.js` loses 33% of functions and half the instructions, and reports
nothing about it. Its output should not be used as a coverage baseline.

### 4.1 Method

Script: `scratch/audit/opcode_coverage.mjs`. Self-spawning: with a file argument
it acts as the child and prints one file's histogram; with no argument it is the
driver. One child per `.jsc`, 1800 MB heap cap, 180 s timeout.

Handled-opcode extraction is done by **parsing `src/dataflow.js` with
`@babel/parser`** and collecting `StringLiteral` case tests from the single
`SwitchStatement` whose discriminant is the identifier `name` — not by grepping,
so nested switches and comments cannot contaminate the set.

```
node scratch/audit/opcode_coverage.mjs
node scratch/audit/opcode_big.mjs
node scratch/audit/loop_matched.mjs
```

### 4.2 Coverage

| Metric | Value |
|---|---|
| Opcodes in `rules/v8-14.4.258.16.json` (`opcodes_by_name`) | **212** |
| `switch (name)` statements in `src/dataflow.js` | 1 |
| `case 'X':` labels on that switch | 213 |
| **Distinct opcode names handled** | **212** |
| **Coverage** | **212 / 212 = 100.0%** |
| `default:` behaviour | `throw UnsupportedBytecodeError` (fail-fast) |
| Duplicate case label | 1 — `FindNonDefaultConstructorOrConstruct` appears twice (second is dead code) |

### 4.3 Unhandled opcodes ranked by real-world frequency

The requested table is **empty**, and it is empty for a structural reason: the
switch covers the entire opcode universe the profile defines, so no bytecode this
lifter can decode can reach `default:`.

| Rank | Opcode | Count | % of all instructions |
|---|---|---|---|
| — | *(none — 0 unhandled opcodes)* | 0 | 0.0000% |

Evidence base for that zero:

| Sample | Files | Functions | Instructions | Distinct opcodes seen | Lifter failures | Unhandled |
|---|---|---|---|---|---|---|
| 20 size-stratified (2 KB - 662 KB) | 20 | 3,710 | 151,481 | 159 | **0** | **0** |
| large + named (`b_86background`, `b_nodeXpluginbackground`, `r_8878`, `b_background`, `p_preload`, `internal_index`) | 6 | 54,703 | 2,614,862 | 179 | **0** | **0** |
| **Combined** | **26** | **58,413** | **2,766,343** | **179** | **0** | **0** |

Both `.jsc` files that time out in task 3 are in the second group: they
disassemble completely and quickly (`r_8878.jsc`: 22,775 functions, 1,197,509
instructions, 130 s; `b_nodeXpluginbackground.jsc`: 19,125 functions, 791,300
instructions, 60 s). **The timeouts are not a lifter or opcode problem** — they
are downstream, in dataflow/relooper/generate.

### 4.4 Top 20 opcodes actually present (all handled)

From the 20-file stratified sample, 151,481 instructions:

| Opcode | Count | % | Handled |
|---|---|---|---|
| `GetNamedProperty` | 17,269 | 11.400% | ✅ |
| `Star` | 9,978 | 6.587% | ✅ |
| `LdaImmutableCurrentContextSlot` | 6,576 | 4.341% | ✅ |
| `Ldar` | 5,707 | 3.767% | ✅ |
| `LdaConstant` | 5,176 | 3.417% | ✅ |
| `Return` | 4,442 | 2.932% | ✅ |
| `Mov` | 4,388 | 2.897% | ✅ |
| `Star2` | 4,293 | 2.834% | ✅ |
| `Star1` | 4,064 | 2.683% | ✅ |
| `Star3` | 4,004 | 2.643% | ✅ |
| `Star0` | 3,711 | 2.450% | ✅ |
| `CreateClosure` | 3,690 | 2.436% | ✅ |
| `DefineNamedOwnProperty` | 3,607 | 2.381% | ✅ |
| `Star5` | 3,354 | 2.214% | ✅ |
| `LdaImmutableContextSlot` | 3,351 | 2.212% | ✅ |
| `Star4` | 3,207 | 2.117% | ✅ |
| `StaCurrentContextSlotNoCell` | 3,086 | 2.037% | ✅ |
| `CallUndefinedReceiver1` | 3,083 | 2.035% | ✅ |
| `LdaSmi` | 3,055 | 2.017% | ✅ |
| `LdaUndefined` | 2,872 | 1.896% | ✅ |

### 4.5 The other half of coverage: 53 handled opcodes never observed

159 of 212 opcodes appear in the 20-file sample, so **53 handled cases have zero
real-world exercise**. Four of them look like dead cases rather than untested
ones: `Wide` and `ExtraWide` are prefix bytes consumed by the lifter and can
never surface as an instruction name (`src/lifter.js` handles `0x00`/`0x01`
before lookup), and `LdaNamedProperty`, `StaNamedProperty`, `LdaKeyedProperty`,
`StaKeyedProperty` are pre-rename V8 aliases that do not exist in the 14.4
profile under those names.

Full list: `Abort, Add_StringConstant_Internalize, BitwiseXor, BitwiseXorSmi,
CallAnyReceiver, CallJSRuntime, CallNoFeedback, CallRuntimeForPair,
CreateEvalContext, CreateWithContext, DebugBreak0-6, DebugBreakWide,
DebugBreakExtraWide, Debugger, Exp, ExpSmi, ExtraWide, ForOfNext,
GetNamedPropertyFromSuper, GetTemplateObject, IncBlockCounter,
JumpIfForInDoneConstant, JumpIfJSReceiverConstant, JumpIfNotNullConstant,
JumpIfNotUndefinedConstant, JumpIfNullConstant, JumpIfUndefinedConstant,
JumpIfUndefinedOrNullConstant, LdaKeyedProperty, LdaLookupContextSlot,
LdaLookupContextSlotInsideTypeof, LdaLookupContextSlotNoCell,
LdaLookupContextSlotNoCellInsideTypeof, LdaLookupGlobalSlot,
LdaLookupGlobalSlotInsideTypeof, LdaLookupSlot, LdaLookupSlotInsideTypeof,
LdaNamedProperty, Mod, ShiftRight, ShiftRightLogical, ShiftRightLogicalSmi,
StaGlobal, StaKeyedProperty, StaLookupSlot, StaNamedProperty, Wide`

`Mod`, `ShiftRight`, `ShiftRightLogical`, `BitwiseXor` and `Exp` being absent
from 151,481 instructions of real minified application code is surprising enough
to be worth a second look — plain arithmetic opcodes should appear.

### 4.6 The coverage number that actually matters

100% opcode coverage is a true statement about `src/dataflow.js` and a misleading
one about the decompiler. Coverage here means *"the switch has a case label"*,
not *"the case reconstructs the right JavaScript"*. The matched measurement in
§5.4 shows what 100% coverage buys: the loop and exception opcodes are all
handled, and all of the loops and exceptions are still lost.

---

## 5. Dynamic semantics spot-check

Scripts: `scratch/audit/free_identifiers.mjs` and
`scratch/audit/free_identifiers_nontrivial.mjs`. Free identifiers come from
`@babel/traverse` Program-scope analysis (`path.scope.globals`), then each name
is tested against a known-globals set built from
`Object.getOwnPropertyNames(globalThis)` plus curated ECMAScript, Node and
browser/Electron globals. Every file is also compiled with `new vm.Script()`
(compile only, never executed).

```
node scratch/audit/free_identifiers.mjs
node scratch/audit/free_identifiers_nontrivial.mjs
```

### 5.1 The 3 smallest parseable outputs (as requested)

| File | Bytes | V8 compile | Free distinct | Free refs | Real globals | **Invented** |
|---|---|---|---|---|---|---|
| `r_73065.js` | 304 | OK | 1 | 3 | `self` | **0 (0%)** |
| `r_82276.js` | 304 | OK | 1 | 3 | `self` | **0 (0%)** |
| `r_loginXapp.js` | 308 | OK | 1 | 3 | `self` | **0 (0%)** |

These three are a useless spot-check and saying so is part of the answer: they
are 304-byte webpack registration stubs whose only free name is `self`. They
would plausibly run. They are also 0.0003% of the corpus.

### 5.2 3 small outputs that have a real body

Picked at the 25th/50th/75th percentile of the 249 files in the 2 KB-12 KB band,
plus `internal_index.js` (inspected by hand).

| File | Bytes | V8 compile | Free distinct | Free refs | Real globals | Invented distinct | Invented refs | **% invented** |
|---|---|---|---|---|---|---|---|---|
| `r_commonNodeModuleXapcaXw3.js` | 3,516 | OK | 12 | 79 | 4 | 8 | 53 | **67.09%** |
| `r_92575.js` | 6,137 | OK | 22 | 168 | 9 | 13 | 141 | **83.93%** |
| `r_57058.js` | 9,308 | OK | 26 | 191 | 8 | 18 | 173 | **90.58%** |
| `internal_index.js` | 2,425 | OK | 23 | 84 | 6 | 17 | 61 | **72.62%** |

Breakdown of the invented names:

| File | `ctx` | `r<N>` | `__the_hole__` | `ctx_d<N>` | `__intrinsic_<N>` | other |
|---|---|---|---|---|---|---|
| `r_commonNodeModuleXapcaXw3.js` | 30 refs | 22 refs / 6 names | 1 | — | — | — |
| `r_92575.js` | 79 refs | 47 refs / 10 names | 13 | — | — | `feedback_vector` ×2 |
| `r_57058.js` | 94 refs | 47 refs / 9 names | 15 | 2 refs / 2 names | 12 refs / 4 names | `__resumeVal` ×3 |
| `internal_index.js` | 29 refs | 30 refs / 15 names | 2 | — | — | — |

Two leaks worth naming individually, because neither is in the marker list the
task asked for and both are decompiler internals escaping into output:

- **`feedback_vector`** comes from `V8Profile.decodeRegister`
  (`src/profile.js`), which returns the string `'feedback_vector'` for frame
  register operand `-2`. That interpreter frame slot is being printed as a
  JavaScript variable name.
- **`__resumeVal`** is a generator-resume placeholder with the same problem.

### 5.3 Wider sample and the aggregate number

20 smallest parseable outputs:

| Metric | Value |
|---|---|
| `vm.Script` compile OK | 20 / 20 |
| Total free references | 247 |
| **Invented (not any JS global)** | **173 = 70.04%** |
| Files with zero invented free identifiers | 4 / 20 |

By class: `ctx` 119 refs / 16 names, `r<N>` 29 refs / 11 names,
`__the_hole__` 23 refs / 16 names, `ctx_d<N>` 2 refs / 1 name.

**Would these run?** Loading any of them succeeds — the top level is a single
`function main` declaration. Calling `main()` does not. `ctx` is referenced
1,710,336 times across 1018 of 1039 files and is **never declared anywhere in the
corpus**, so the first context-slot access throws `ReferenceError: ctx is not
defined` in strict mode, and in sloppy mode a read still throws while a write
silently creates a global. The same applies to every `r<N>`, `ctx_d<N>`,
`__the_hole__`, `__intrinsic_<N>` and `__obj_<N>`. **Roughly 0 of 1039 outputs
would run.**

### 5.4 All cyclic and exceptional control flow is lost

Scripts: `scratch/audit/loop_shapes.mjs` (what shapes are emitted) and
`scratch/audit/loop_matched.mjs` (same files on both sides).

The zero `break` / zero `continue` / zero `__state` result from §1.2 and §1.5
prompted the obvious follow-up: are loops emitted at all?

**What is emitted (full corpus, 1039 files, lexical upper bounds):**

| Construct | Occurrences | Files containing |
|---|---|---|
| `while (` | 13 | **2** |
| `for (` | 131 | **6** |
| `do {` | **0** | **0** |
| `switch (` | 7 | 2 |
| `try {` | 48 | 5 |
| `catch (` | 52 | 5 |
| `if (` | 487,867 | 920 |
| `return` | 343,066 | 1039 |
| `throw` | 27,202 | 534 |

**AST-exact on the 60-file stratified sample:**

| Node type | Count |
|---|---|
| `WhileStatement` | **0** |
| `DoWhileStatement` | **0** |
| `ForStatement` / `ForInStatement` / `ForOfStatement` | **0** / **0** / **0** |
| `SwitchStatement` | **0** |
| `TryStatement` / `CatchClause` | **0** / **0** |
| `BreakStatement` / `ContinueStatement` | **0** / **0** |
| `LabeledStatement` | **0** |
| `IfStatement` | 9,231 |
| `FunctionDeclaration` / `FunctionExpression` | 341 / 10,165 |

**Matched comparison — same 20 files, bytecode on one side, their own
`decompiled_js` output on the other:**

| Control flow | Present in bytecode | Emitted in the output |
|---|---|---|
| Loop back-edges (`JumpLoop`) | **167** | **0** loop statements |
| `for-in` loops (`ForInNext`) | **29** | **0** |
| Exception ops (`Throw`/`ReThrow`/`SetPendingMessage`) | **667** | **0** `try` statements |
| Switch dispatch (`SwitchOnSmiNoFeedback`/`SwitchOnGeneratorState`) | **160** | **0** `switch` statements |
| `break` / `continue` | — | **0** |

Scaled to the 26 files measured in §4.3 (2,766,343 instructions): **7,286
`JumpLoop` back-edges, 361 `for-in` loops, 15,372 exception opcodes, 2,727 switch
dispatch opcodes, 3,730 `SuspendGenerator`/`ResumeGenerator` pairs.** Against
that, the entire 309 MB corpus contains at most 2 files with a `while` and 6 with
a `for`.

This is the most serious defect in the audit and nothing else in it comes close.
Every loop in the input program is emitted as straight-line or `if`-guarded code,
so the output does not merely use ugly names — it computes something different.
Combined with §1.2 (`__caughtErr` = 0, `__state` = 0), the irreducible-CFG path of
`src/relooper.js` and the catch-handler seeding in `src/decompiler.js:55-60` have
**zero** observed coverage over 1039 files.

### 5.5 Two further defects, measured

Script: `scratch/audit/semantic_hazards.mjs`, 40 size-stratified files in the
1 KB-400 KB band, 29,969 statements, 4,447 function bodies.

```
node scratch/audit/semantic_hazards.mjs
```

**H1 — side-effecting calls evaluated twice.** `src/dataflow.js` pushes a call as
a statement *and* leaves it in the accumulator, so it is printed again wherever
the accumulator is consumed.

| Metric | Value |
|---|---|
| Adjacent statement pairs examined | 21,550 |
| Pairs where stmt *i* duplicates a call inside stmt *i+1* | **2,787 (12.93%)** |
| Files affected | **40 / 40** |

Real examples from the corpus:

```js
// decompiled_js/r_32006.js
ctx.slot_2.replace("//", "");            // evaluated once here ...
ctx.slot_2 = ctx.slot_2.replace("//", ""); // ... and again here

// scratch/audit/out/pipeline_code/internal_index.out.js
performance.now();
globalThis.TIMES.P_LAUNCHER_RUN = performance.now();  // two different values
Date.now();
globalThis.TIMES.T_LAUNCHER_RUN = Date.now();
```

Any call that is not pure now runs twice. `performance.now()` returns two
different numbers; a `push`, a counter increment or a network call happens twice.

**H2 — object identity destroyed.** A register holding an object is inlined as
the *constructing expression* at every use, so each use allocates a fresh object.

| Metric | Value |
|---|---|
| Allocation expressions (`ObjectExpression`/`ArrayExpression`/`NewExpression`) | 4,297 |
| **Duplicated within one function body** | **2,160 (50.27%)** |
| Distinct duplicated groups | 796 |
| Worst single allocation re-emitted | **22 times** |
| Files affected | **35 / 40** |

From `b_background.jsc` (the webpack module loader, where this is fatal):

```js
ctx.slot_7[a0] = { id: a0 };
ctx.slot_6[a0].call({ id: a0 }.exports,   // a NEW object, not the cached one
                    { id: a0 },            // another new one
                    { id: a0 }.exports,    // and another
                    ctx.slot_8);
({ id: a0 }).loaded = true;                // writes to a throwaway object
return { id: a0 }.exports;                 // always undefined
```

The original is a module cache: one object created, stored, mutated and returned.
The decompiled version creates five unrelated objects, so `.exports` is
`undefined` and the module registry never populates. The program is not
recoverable from this text by renaming variables.

---

## 6. What failed, was skipped, or is uncertain

Stated explicitly rather than omitted.

| # | Item | What happened |
|---|---|---|
| 1 | `b_nodeXpluginbackground.jsc` task-3 decompile | **Failed.** `TimeoutError: killed after 180000 ms (no result)`. No output produced. |
| 2 | `r_8878.jsc` task-3 decompile | **Failed.** `TimeoutError: killed after 180000 ms (no result)`. No output produced. |
| 3 | Fresh-vs-stored comparison for those two | **Not possible** — no fresh output exists to compare. Rows marked "not comparable" in §3.5. |
| 4 | Agent terminal | Degraded repeatedly: `exit code -1` with empty output, and once into per-character command echo. Cause is the 4 GB host paging under a 1.5-2 GB child. Recovered by killing the terminal and replacing `Tee-Object` pipes with file redirection. **No measurement was affected** — every number here comes from a JSON/text artifact under `scratch/audit/out/`, re-read after the run. |
| 5 | One `node` invocation | Failed with `MODULE_NOT_FOUND` for a script that existed on disk (transient filesystem visibility). Re-ran successfully; no data lost. |
| 6 | `loop_opcodes.mjs` first run | Its redirected output file was lost to a terminal collision with an unrelated session on the same host. Re-run cleanly; `out/loop_opcodes.json` and `out/loop_opcodes_stdout.txt` are the artifacts behind §5.4. |
| 7 | AST-exact census scope | Capped at files ≤ 1.5 MB (60 files, 4.72 M chars). Walking the 115 MB output's 5.7 M-node AST is possible (§2.3 did it) but not 1039 times on 4 GB. The lexical-vs-AST agreement in §1.4 is what licenses using the lexical full-corpus numbers. |
| 8 | Semantic-hazard sample scope | 40 files in the 1 KB-400 KB band. `@babel/generator` is called per node to compare printed text, which is too slow for the whole corpus. |
| 9 | `markersPerKB` for `r_8878.js` etc. | Density ranking covers all 1039 files, but the largest files sit mid-distribution; the top 20 is dominated by small files where the banner is a smaller fraction. Not a defect, just a ranking artifact. |
| 10 | `arguments_in_zero_param_fn` | Measured on the 60-file sample only (443 / 603). Not extrapolated to the corpus. |
| 11 | Loop/exception matched comparison | 20 files, 151,481 instructions. The 26-file scaled figures in §5.4 come from the opcode histograms, where the *output* side is the 60-file AST sample plus full-corpus lexical bounds, not the identical 26 files. The 20-file matched table is the rigorous one. |
| 12 | My own first-pass errors | Two task-1 marker counts were wrong and are corrected in §1.4-§1.5 (`func_ref_bare` 6,053 → 0; `break`/`continue` 341/405 lexical → 0 real). `emitted_fns.mjs` initially compared character length against byte length, inflating the fresh-vs-stored ratio for non-ASCII files; fixed and re-run. |

### Threats to validity

- **100% parseability is structural, not empirical.** `@babel/generator` cannot
  print an invalid program from a valid `@babel/types` AST. The number confirms
  the AST is well-formed and nothing more. It is reported as the headline because
  it was asked for, but §2.5 and §5 are what the number actually means.
- **100% opcode coverage counts case labels, not correct semantics.** §5.4 is the
  counterexample: `JumpLoop` is handled and loops are still gone.
- **Markers are counted in generated text, not in the decompiler.** Where that
  could mislead (string-literal hits, generator declarations) it was cross-checked
  against the AST and corrected.
- **The task-3 sample is 12 of 1039 inputs (1.2%).** The 2 timeouts support
  "large `b_*` inputs are at risk", not a corpus-wide failure rate. A full-corpus
  re-decompile would take an estimated 15-30 h on this host and was not attempted.
- **Wall times are noisy.** `b_background.jsc` measured 95,934 ms in the batch and
  34,638 ms idle, a 2.8× spread on identical work.

---

## 7. Exact commands run

```powershell
# environment
node -v                                    # v26.12.1
npm i -D @babel/parser @babel/traverse     # parser 8.0.8, traverse 8.0.7

# probe: is line-based streaming memory-safe? (max line 165,621 B -> yes)
node scratch/audit/probe_lines.mjs

# TASK 1  corpus static audit
node scratch/audit/audit_corpus.mjs
node scratch/audit/ast_census.mjs          # task 1b: lexical vs AST-exact
node scratch/audit/corrections.mjs         # full-corpus corrections to task 1

# TASK 2  parseability
node scratch/audit/audit_parse.mjs         # spawns parse_worker.mjs per 40-file range
node --max-old-space-size=2048 scratch/audit/control_parse.mjs

# TASK 3  pipeline liveness
node scratch/audit/run_pipeline.mjs        # spawns pipeline_one.mjs per .jsc, 180s cap
node scratch/audit/emitted_fns.mjs
node --max-old-space-size=2048 scratch/audit/pipeline_one.mjs `
     extracted_jsc/b_background.jsc scratch/audit/out/b_background.rerun.js

# TASK 4  opcode coverage
node scratch/audit/opcode_coverage.mjs
node scratch/audit/opcode_big.mjs
node scratch/audit/loop_opcodes.mjs
node --max-old-space-size=1800 scratch/audit/loop_matched.mjs

# TASK 5  dynamic semantics
node scratch/audit/free_identifiers.mjs
node scratch/audit/free_identifiers_nontrivial.mjs
node scratch/audit/semantic_hazards.mjs
node scratch/audit/loop_shapes.mjs
```

Long runs were launched as background processes with `> file 2>&1` redirection
rather than `| Tee-Object`, because the pipe form was what tipped the terminal
into its degraded state.

---

## 8. Artifacts

All under `scratch/audit/`. Nothing outside this directory was created or
modified except `package.json` / `package-lock.json`, from the permitted
`npm i -D @babel/parser` (`@babel/traverse` added for the task-5 scope analysis).

### Scripts

| Script | Task | Purpose |
|---|---|---|
| `audit_corpus.mjs` | 1 | streaming marker scan of all 1039 outputs |
| `ast_census.mjs` | 1b | lexical vs AST-exact marker counts |
| `corrections.mjs` | 1 | full-corpus corrections to two lexical counts |
| `audit_parse.mjs` + `parse_worker.mjs` | 2 | crash-attributing parseability driver |
| `control_parse.mjs` | 2 | negative + positive controls on the parse check |
| `run_pipeline.mjs` + `pipeline_one.mjs` | 3 | per-input decompile with 180 s cap |
| `emitted_fns.mjs` | 3b | emitted vs deserialized functions; fresh vs stored |
| `opcode_coverage.mjs` | 4 | opcode histogram + handled-set AST extraction |
| `opcode_big.mjs` | 4 | same, on the large/named inputs |
| `loop_opcodes.mjs` | 4/5 | loop/exception/generator opcode totals |
| `loop_matched.mjs` | 5 | bytecode vs output control flow, same files |
| `loop_shapes.mjs` | 5 | which control-flow shapes are emitted at all |
| `free_identifiers.mjs` | 5 | scope analysis, 3 smallest + 20-file sample |
| `free_identifiers_nontrivial.mjs` | 5 | same, on 3 non-trivial small outputs |
| `semantic_hazards.mjs` | 5b | duplicated side effects, destroyed identity |
| `probe_lines.mjs` | — | memory-safety probe for the streaming approach |

### Data

`out/corpus.json` (per-file marker counts, all 1039) · `out/parse_results.jsonl`
(one record per file) · `out/parse_summary.json` · `out/pipeline.json` ·
`out/pipeline_code/*.out.js` (10 fresh outputs) · `out/emitted_fns.json` ·
`out/opcode_coverage.json` · `out/opcode_big.json` · `out/op_*.jsc.json` ·
`out/loop_matched.json` · `out/loop_shapes.json` · `out/ast_census.json` ·
`out/corrections.json` · `out/free_identifiers.json` ·
`out/free_identifiers_nontrivial.json` · `out/semantic_hazards.json` ·
`out/determinism.txt` · plus a `*_stdout.txt` transcript per run.

---

## 9. Baseline summary

Where the decompiler stands, by layer:

| Layer | Status | Evidence |
|---|---|---|
| Deserializer (`src/deserializer.js`) | **Working** | 10/10 attempted files deserialize; 26 files / 58,413 functions extracted with 0 errors |
| Lifter (`src/lifter.js`) | **Working** | 0 failures over 2,766,343 instructions / 58,413 functions |
| Opcode profile (`rules/`) | **Complete** | 212/212 opcodes have a handler; 0 can reach `default:` |
| Printer (`@babel/generator`) | **Working** | 1039/1039 outputs are valid JavaScript, confirmed by two independent parsers |
| Naming / symbol recovery | **Broken** | 70-91% of free identifiers are invented; `ctx` referenced 1.71 M times and never declared |
| Dataflow (`src/dataflow.js`) | **Broken** | 12.93% of statement pairs double-evaluate a call; 50.27% of allocations lose object identity |
| Relooper (`src/relooper.js`) | **Broken** | 167 loop back-edges → 0 loop statements; 667 exception opcodes → 0 `try`; 160 switch ops → 0 `switch` |
| Emission completeness | **Lossy** | 38.76% of deserialized functions reach the output (median 96.78%; worst file 35.87%) |
| Throughput | **Not viable at scale** | 2/12 inputs exceed 180 s; cost is not size-driven (5,975 ms/KB for a 3.4 KB input) |

The front half of the pipeline — read the cache, decode the bytecode, know every
opcode — is in good shape, and the output is syntactically flawless. The back
half does not reconstruct the program. Anyone reading `decompiled_js/` as a
recovered source tree is reading 309 MB of valid JavaScript that computes
something other than what the original did, and the places where it diverges are
not marked.

The three measurements to track against this baseline, in order:

1. **Loop statements emitted per `JumpLoop` back-edge.** Currently 0 / 167.
2. **Declared-vs-free identifier ratio.** Currently ~30% of free references are
   real globals; the rest are invented. `ctx` alone is 1,710,336 references.
3. **Functions emitted per function deserialized.** Currently 38.76% aggregate,
   96.78% median — the gap between those two numbers is itself the bug.

Parseability (100%) and opcode coverage (100%) are already saturated and will not
move. They should not be used as progress metrics.
