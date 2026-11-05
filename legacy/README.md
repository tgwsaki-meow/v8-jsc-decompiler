# legacy/ — the abandoned prototype

The first implementation of this project, moved here wholesale with `git mv` so
that its own relative imports keep resolving and the files stay readable as what
they were. It is here for two different reasons at once, and confusing them
costs real work:

* its **back end** is condemned and must never be imported again;
* its **front end** is still imported on purpose, as a second, independently
  written reader whose agreement with the current one is evidence.

Nothing here is a reference for how V8 works. Where a number or a layout is
wanted, `profiles/<tag>/` is the authority (docs/ARCHITECTURE.md §1.2, §3).

## What condemned it

`scratch/audit/BASELINE_AUDIT.md` measured the prototype against the 1039-file
corpus it had already produced, and found output that is syntactically perfect
and semantically broken: 1039/1039 outputs parse, 212/212 opcodes are
"handled", and across 20 files whose bytecode holds 167 `JumpLoop` back-edges
the output contains zero loops, zero `break`, zero `continue` and zero
`switch`; 667 exception opcodes produced zero `try` statements. Both saturated
metrics measure the printer and a `case`-label count, not reconstruction. The
defects behind that are structural, not bugs to patch: `relooper.js` takes the
lowest-numbered block reachable from both branches as a merge point, which is
not the immediate post-dominator; `decompiler.js:70-76` propagates register
state by letting the first predecessor win, with no phi nodes and no fixpoint;
`dataflow.js` inlines expressions with no effect-ordering constraint, so 12.9%
of adjacent statement pairs duplicate a side-effecting call and 50.3% of
allocations are re-emitted per use, destroying object identity. The prototype
also hardcodes what has to be data: `slotIndex >= 6` to decide which raw span
is bytecode, and `kTaggedSize = 4` as a literal.

## The four dead modules

`decompiler.js` `lifter.js` `relooper.js` `dataflow.js`

**Nothing on the decompiler's read path may import these.** No file under
`src/` does, and nothing new should: they are the condemned back end plus the
CFG builder that fed it. What replaces each is recorded where the replacement
lives — `src/ir/ssa.mjs` (dataflow and phis), `src/ir/cfg.mjs` (the CFG,
including the exception edges `lifter.js:buildCFG` never added),
`src/ir/dominators.mjs` and `src/structure/regions.mjs` (merge points),
`src/disasm/` (instruction decoding), `src/emit/decompile.mjs` (the pipeline).
The docs cite these four by path as the historical record of what was wrong;
those citations are about the past and are not a dependency.

One live exception, and it is a measurement rather than a read path:
`tools/metrics/collect/control_flow.mjs` imports `lifter.js` to count the
control flow present in the *bytecode* — `JumpLoop` back-edges, handler-table
ranges, switch dispatches. That is the denominator of metrics 1-3 and 10, i.e.
the input side. The prototype's back end is not run there and its output is not
graded.

## The two modules that are live on purpose

`deserializer.js` (`JSCDeserializer`, `StrictV8Deserializer`) and `profile.js`
(`V8Profile`) **are imported by current code, deliberately.**
`src/disasm/adapter_legacy.mjs` turns their object graph into the FunctionUnit
of ARCHITECTURE.md §8.1, and `src/cli/disasm.mjs`,
`tools/disasm/corpus_scan.mjs` and `tools/disasm/oracle_agreement.mjs` reach
them through it. The metrics collectors `control_flow.mjs` and `ro_refs.mjs`
import them directly.

The reason is the oracle. `tools/disasm/oracle_agreement.mjs` runs both
FunctionUnit input paths against the same V8 `--print-bytecode` listing —
`cache` through this adapter, `cache-t4` through `src/cache` + `src/heap` — and
both come back 102/102 functions instruction-exact over 31 919 instructions,
0 diffs (docs/DISASM.md §10). Two readers written years apart from different
sources agreeing on every instruction is evidence about the bytecode; one
reader agreeing with itself is not. So the adapter's "expected to be deleted
the moment T4 lands" note no longer holds: T4 landed, and this became the
second reader. Deleting it would delete the measurement, not just the code.

The prototype's own front end is not blameless — `deserializer.js` reads the
constant pool as `slots[5]` and folds handler-table bit 3 into the prediction —
which is why it is the *compared* reader and never the authority. A
disagreement between the two paths says one of them has the contract wrong, and
that is the point.

Two consequences of the move, recorded because both have already bitten:

* `rules/` stayed at the repository root, so `profile.js`'s three table paths
  are now `../../rules/`. Two of the three are guarded by `existsSync`, so a
  wrong path there does not throw — it silently produces an empty roots map and
  an empty read-only-heap table, which is the "before" column of metric 9.
* moving `profile.js` ended its name collision with the real `src/profile/`
  directory. `src/profile.js` and `src/profile/index.mjs` differed by nothing
  but an extension, in a project where one is the generated-profile loader and
  the other is a hand-made table from a binary that no longer exists.

## legacy/tools/ and legacy/src/lifter.py

22 ad-hoc scripts from the same era — batch drivers, root-table scrapers,
one-off debug probes named after a single corpus file (`decompile_r8878.js`,
`profile_r96064.js`) — plus a Python lifter that predates the JavaScript one.
Kept as a record of how the prototype's tables were produced, which is the
provenance question `rules/README.md` answers. **They are not expected to run.**
Several assume a working directory, an `extracted_jsc/` tree or a Windows QQ
install that is not in this repository; `parallel_batch_decompile.js` resolves
`tools/worker_decompile.js` from the process CWD and that path no longer
exists. Two are still cited as the origin of a committed table
(`extract_rules.js`, `build_canonical_roots.py`) and that is the only reason to
open them.
