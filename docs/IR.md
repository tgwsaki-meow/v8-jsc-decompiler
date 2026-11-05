# `src/ir/` — `Instruction[]` → CFG + dominators + SSA + effect graph

Stage B of [ARCHITECTURE.md §4.2](ARCHITECTURE.md). Input: `Instruction[]`
(§8.2) from `src/disasm`. Output: the IR of §8.4.

```
src/ir/
  index.mjs           buildIR(unit, {profile}) -> IRFunction
  opcode_effects.mjs  what one bytecode does: registers, effect kinds, allocation
  vars.mjs            the variable space, and one instruction's read/write set
  cfg.mjs             leaders -> blocks -> edges, incl. jump-table and exception edges
  dominators.mjs      Cooper-Harvey-Kennedy dominators + frontiers; the same on
                      the reverse graph for post-dominators; a brute-force oracle
  loops.mjs           back edges, natural loops, the nesting forest, reducibility
  ssa.mjs             Cytron phi placement + renaming, pruned
  context.mjs         ContextSlot(depth, index) -> a real variable name
  effects.mjs         the effect graph (memory SSA over effect kinds)
  verify.mjs          the structural invariants
  dot.mjs             Graphviz
src/cli/dump-ir.mjs   the CLI
tools/ir/             the self-test, a profile-driven assembler, the corpus scan
```

What this replaces:

| was | problem | now |
|---|---|---|
| `legacy/src/decompiler.js:70-76` | "first predecessor wins" (`if (!blockStates.has(succ.id))`), no phis, no fixpoint, layout-order traversal | `ssa.mjs` |
| `legacy/src/lifter.js:buildCFG` | handler offsets are leaders but **zero** exception edges; no jump-table successors | `cfg.mjs` |
| `legacy/src/relooper.js:_findMergeBlock` | "the lowest-numbered block reachable from both branches", which is not an immediate post-dominator | `dominators.mjs`'s `ipdom` |

Nothing version-specific is written down. Opcode values, operand types and
widths, prefixes, the jump family, the switch family and the register encoding
all come from `profiles/<tag>/*.json` through `src/profile` and `src/disasm`.
The only names in `src/ir/` are **opcode names**, in the declared tables of
`opcode_effects.mjs`, and `tools/ir/selftest.mjs` check **A** greps
`src/ir/*.mjs` for hex literals, for decimal literals of three digits or more,
and for numeric comparisons against an opcode value, and fails if it finds any.

---

## 1. Running it

```
node src/cli/dump-ir.mjs <file.jsc> [--function <id>] [--profile <tag>]
                         [--dot] [--json [out.json]] [--list] [--verify]
                         [--brute-force] [--exception-model instruction|block]
                         [--no-scope-infos] [--quiet]

node tools/ir/selftest.mjs                      # 56 checks, no engine, no .jsc
node tools/ir/corpus_scan.mjs --jobs 2          # all 1039 .jsc, forked per file
node tools/ir/corpus_scan.mjs --max-files 20    # a quick pass
```

With no `--profile`, the CLI tries every profile under `profiles/` and keeps
the one whose `versionHash` the cache header agrees with, so a 14.4 corpus file
and a 14.6 mint both work without being told which is which.

`--dot` emits Graphviz: edge colour is the edge kind, switch edges are labelled
with the case value, exception edges are dashed and labelled with the catch
prediction, and back edges get `constraint=false` so the loop body still lays
out top to bottom.

---

## 2. The data structures

§8.4 asked for this:

```js
{
  blocks: [{ id, startOffset, instructions, preds, succs,
             kind: 'normal'|'loopHeader'|'handler'|'switchDispatch',
             exceptionSuccs }],
  entry, dominators, idom, domFrontier, postDominators, ipdom,
  loops: [{ header, latches, body, exits }],
  values: Map<ssaId, Value>,
  effects: [ssaId, ...],
  defUse: Map<ssaId, ssaId[]>
}
```

All of it is there, with these additions (§8 says the field names are the
contract, so nothing was renamed — only added):

| field | why |
|---|---|
| `edges[]` | `{id, from, to, kind, …}`. Phi operand *j* belongs to `preds[j]` which belongs to `inEdges[j]`, so two edges from the same block get two operands. Without an explicit edge list that correspondence is not expressible. |
| `block.kinds[]` | a block can be a loop header **and** a handler **and** a switch dispatcher at once. §8.4's single `kind` is resolved by priority (handler > switchDispatch > loopHeader > normal); `kinds` has all of them. |
| `block.normalSuccs` / `normalPreds` | `succs`/`preds` include exception edges, because dominance and SSA are wrong without them. Structuring (T8) wants the graph without them. Both are provided. |
| `block.effects` | the per-block effect order. §8.4's `effects: [ssaId,…]` is described as "the total order inside each block" but typed as one flat array; both exist — `ir.effects` is the whole function in reverse postorder, `block.effects` is per block. |
| `exit`, `postDominators.exitPreds`, `virtualExitEdges` | the virtual exit node, see §4 |
| `values` as an **array** | §8.4 says `Map<ssaId, Value>`; an array indexed by `ssaId` is the same mapping with dense integer keys, and the corpus allocates 10.9M of them. `defUse` is a real `Map` because it is sparse. |
| `loopInfo`, `contextChain`, `effectGraph`, `liveIn/liveOut`, `blockEntryVersion/blockExitVersion` | the working data T7 and T8 would otherwise recompute |

### Value kinds

§8.4 lists `Const | Param | Phi | Op | ContextSlot | CaughtException`. The
implementation has those plus three more, each because something real needed
it:

| kind | what it is |
|---|---|
| `Param` | a parameter, `index` 0 being the receiver |
| `FrameEntry` | the definition every other frame slot has on entry: the incoming context, the register file (which `InterpreterEntryTrampoline` fills with `undefined` before the first bytecode runs), the incoming new.target / generator register, and the read-only header registers (`<closure>`, the feedback vector, the argument count). §8.4 has `Param` but nothing for these, and without them "every use has exactly one reaching definition" is false for any function that reads a register it never wrote. |
| `Phi` | `{var, block, operands[]}`, one operand per predecessor, in predecessor order |
| `CaughtException` | the accumulator at a handler entry, see §5 |
| `Op` | one instruction. Carries `hasEffect`, `allocatesIdentity`, the full `effect` row, `inputs`, `inputVars`, `defs`, `contextIn` and, for a context-slot op, `contextSlot` |
| `Proj` | an instruction's second and later outputs. `ForInPrepare` writes a `kRegOutTriple`, `CallRuntimeForPair` a pair, `ResumeGenerator` a whole register list; they cannot all be the same SSA definition. The `Op` value is the definition of its *primary* output and each remaining output is a `Proj{of, slot, var}`. |
| `ContextSlot` | a **location**, one per (context frame, local index), with `name`, `mode`, `loads[]` and `stores[]`. §8.4 lists it as a `Value`, which it is, but it is not a dataflow definition — the load `Op` is. |
| `EffectPhi`, `EffectEntry` | the memory-SSA merge, see §7 |

`Const` is not a separate kind: `LdaSmi` / `LdaConstant` / `LdaZero` are `Op`
values with `hasEffect: false`, `allocatesIdentity: false` and an operand
carrying the pool entry, so T7 reads the literal off the operand rather than
off a duplicate node.

### Primary output selection

An instruction can write several frame slots. Which one the `Op` value itself
defines is decided in this order, and the order matters:

1. a **real** accumulator write (`kWriteAccumulator` / `kReadWriteAccumulator`);
2. the **context register**, when the opcode implicitly writes it — so
   `PushContext`, `PopContext` and `SwitchOnGeneratorState` have the new
   context as their value, which is what `context.mjs` follows;
3. the first register output;
4. a *clobbered* accumulator (`kClobberAccumulator` /
   `kReadAndClobberAccumulator`), last, because its value is garbage.

So `ForInPrepare`'s value is `cache_type` and not the dead accumulator, and
`PushContext`'s value is the context it installs while its register operand
(the context it saved) is a `Proj`.

---

## 3. The CFG

### Leaders

```
entry
every jump target
every jump-table target                            (11 208 tables in the corpus)
the instruction after a jump, a return or a throw
the instruction after a switch (its fall-through)
every handler entry offset
every handler range boundary, start and end
the instruction after a potentially-throwing instruction inside a range
```

### Terminators

Which opcodes end a block without falling through is **derived** where it can
be and declared where it cannot:

* an unconditional jump is a jump that neither reads the accumulator nor takes
  a register operand. In both profiles that selects exactly `Jump`,
  `JumpConstant` and `JumpLoop`, cross-checked against those three names in
  both directions at profile load, which throws rather than mis-decode;
* `Return`, `Throw`, `ReThrow`, `Abort` and **`SuspendGenerator`** are the only
  non-jump opcodes whose interpreter handler does not end in `Dispatch()`, and
  they are listed by name in `cfg.mjs` with that reason.

`SuspendGenerator` being a terminator is not a detail:

```
// SuspendGenerator <generator> <first input register> <register count>
//     <suspend_id>
//
// Stores the parameters and the register file in the generator. Also stores
// the current context, |suspend_id|, and the current bytecode offset
// ... Then, returns the value in the accumulator.
```

and its handler ends in `Return(GetAccumulator())`.
`BytecodeGenerator::BuildSuspendPoint` emits no `Return` after it for exactly
that reason, so the instruction *immediately following* a `SuspendGenerator` is
the matching `ResumeGenerator`. Treating the suspend as falling through invents
an edge from the suspend straight into the resume, and that edge then looks
like a second entry into whatever loop the `await` sits in. Over the first
twelve corpus files that one wrong edge alone accounted for **five of eight**
"irreducible" findings. This is measured in §9.

### Edge kinds

| kind | from |
|---|---|
| `unconditional` | `Jump` / `JumpConstant` / `JumpLoop` |
| `true` / `false` | a conditional jump. `true` is the **jump target**: the edge taken when the predicate the opcode *names* holds. So `JumpIfFalse`'s `true` edge is its target, because its predicate is "the accumulator is false". `edge.predicate` carries the predicate name so nothing rests on reading the label. |
| `fallthrough` | the next instruction, and a switch's out-of-range path |
| `switch` | one per `jumpTable[]` entry, with `caseValue` and `generatorResume` |
| `exception` | a throwing site inside a protected range → that range's handler |

Both switches have a fall-through: `SwitchOnSmiNoFeedback` when the Smi is
outside `[base, base+len)`, and `SwitchOnGeneratorState` when the generator
register is `undefined`, which is the first call into a generator or an async
function.

### Generator dispatcher vs `switch` statement

Both carry a jump table, and ARCHITECTURE.md §9.2 counts 10 068 of the former
against 1 140 of the latter, so the statistics are meaningless unless they are
told apart. They are distinguished by **derivation, not by name**: the resume
dispatcher is the one switch opcode whose handler also installs a context
(`SetContext(generator.context)`), and `cfgFacts` asserts there is exactly one
such opcode. `block.isGeneratorDispatch` and `edge.generatorResume` carry it.

---

## 4. Dominators, frontiers and post-dominators

**Algorithm.** Keith D. Cooper, Timothy J. Harvey and Ken Kennedy, *A Simple,
Fast Dominance Algorithm*, Rice University TR-06-33870 (2001): iterate
`idom(b) = ⋂ processed predecessors` in reverse postorder until nothing
changes, with `intersect` as the two-finger walk up the partially built tree
comparing postorder numbers. Chosen over Lengauer–Tarjan for the reason the
paper gives: on real control-flow graphs it is as fast or faster, and it is
short enough to be obviously right. Dominance frontiers are the same paper's
formulation (equivalently Cytron et al. 1991 §5.1): for each join point, walk
each predecessor up to `idom` of the join, adding the join.

Dominance queries are O(1) via Euler in/out numbers on the dominator tree.
Every reverse-postorder walk is an iterative DFS with an explicit successor
cursor, so a function with thousands of blocks cannot overflow the JS stack.

**Post-dominators** are the same algorithm on the reverse graph rooted at a
virtual exit. This is what replaces `legacy/src/relooper.js:_findMergeBlock`.

The virtual exit needs two rules, not one:

* every block with no successors gets an edge to `EXIT`;
* while some block cannot reach `EXIT`, the one with the **highest reverse
  postorder number** among them gets an edge to `EXIT`, and reachability is
  recomputed.

The second rule is for `while (true) {}` with no `break`: without it,
post-dominance is not a tree. It terminates (each round connects at least one
block), is deterministic, and on a single endless loop it picks the **latch**,
which is the block an emitter would have to break out of — so the tree it
produces is the one a structuring pass wants. The count of edges it had to
invent is reported per function as `virtualExitEdges`.

**The oracle.** `bruteForceDominators` and `bruteForcePostDominators` are
straight off the definition: `a` dominates `b` iff deleting `a` makes `b`
unreachable from the entry; `p` post-dominates `n` iff deleting `p` makes
`EXIT` unreachable from `n`. O(V·(V+E)) and O(V²·(V+E)), run on small functions
only, as the cross-check for the fast version. `verifyIR(ir, {bruteForce:true})`
turns it on; the corpus scan runs it on a budget of small functions per file
(see §9); the self-test runs it on every hand-built graph and every assembled
function.

---

## 5. Exception edges, and why §4.2's model is wrong

### V8's lookup, reproduced

```cpp
// Lookup handler in a table based on ranges. The {pc_offset} is an offset to
// the start of the potentially throwing instruction (using return addresses
// for this value would be invalid).
int LookupHandlerIndexForRange(int pc_offset) const;
                              -- src/codegen/handler-table.h (14.4.258.16)
```

The body walks the table in order, breaks once `pc < range_start`, skips while
`pc >= range_end`, and keeps the last match. The table is emitted sorted by
range start and the ranges are well nested, so the last match is the
**innermost** one. Ranges are half-open: `[start, end)`.

`lookupHandlerIndexForRange()` in `cfg.mjs` is that function. Two consequences
are asserted per function:

* every instruction of a block must resolve to the same innermost handler —
  range boundaries are leaders, so no block can straddle a range edge, and a
  violation (`blockStraddlesHandlerRange`) means a leader was missed;
* the table must be sorted by range start, because V8's own scan `break`s and
  would itself miss handlers otherwise.

(ARCHITECTURE.md's task text calls the method `LookupRange`. That was its name
before the 2023 rename; the pinned 14.4.258.16 header declares
`LookupHandlerIndexForRange`, and the same header is where the
`[range_start, range_end, handler_bits, handler_data]` layout and the
prediction / was_used / offset bitfields come from.)

### Only the innermost handler gets an edge

Exactly as the machine does. That is sound for an **outer** handler because an
inner range's handler block lies inside the outer range, so a rethrow out of
the inner handler reaches the outer one through an ordinary exception edge from
the inner handler's own block. That is a condition, not a hope, so it is
checked per function and counted corpus-wide as
`handlerNotInsideEnclosingRange`.

### Where the state on an exception edge comes from

ARCHITECTURE.md §4.2 says:

> 异常边的入口状态：V8 在进 try 之前会把需要跨越的值显式 spill 到寄存器，
> 所以 handler 入口取「protected range 内所有块状态的 phi」是保守且正确的。

That is not conservative, it is wrong, in both directions. With one coarse
block per try body:

```js
try { f(); v = 2; g(); } catch { use(v) }
```

the try body is one basic block (no branches). Its exit state has `v = 2`. If
`f()` throws, the handler sees `2` and the machine saw the old value. Turn it
round —

```js
try { v = 2; g(); f(); } catch { use(v) }
```

— and taking the block's *entry* state instead reports the old value where the
machine saw `2`. Neither direction is conservative; both are simply a different
program. The justification does not hold either: V8 spills values that are live
*across* the try, but a variable assigned inside the try and read in the catch
is neither spilled beforehand nor constant through the body.

What `src/ir` does instead is LLVM's `invoke`: **inside a protected range,
every potentially-throwing instruction ends its block**, so an exception edge
leaves a block whose only throw point is its own terminator, and carries the
ordinary exit state. Cytron's placement then needs no special case at all — the
handler's phis fall out of the fact that its predecessors are every throwing
site in its range. Worked through on the first example: the body splits into
`[f()]` and `[LdaSmi 2, Star v, g()]`, both get an exception edge, the first
carries `v = v₀` and the second `v = 2`, and `v`'s definition is in the second
block whose dominance frontier contains the handler — so a phi is placed and
has two distinct operands. `tools/ir/selftest.mjs` check **D** asserts exactly
that.

"Potentially throwing" is read off `opcode_effects.mjs`: the handler can raise
(`effect.throws`) or it can enter user code which can raise
(`effect.callsUserCode`). Nothing is decided by name.

The one residual imprecision is LLVM's as well: the throwing terminator's own
register outputs are modelled as written on the exception edge too, when the
machine would not have performed them. It is counted per function as
`liveInWrittenByThrowingTerminator` rather than assumed away. Over the whole
corpus it is **11** occurrences across 441 578 exception edges — i.e. 11 places
where a handler reads a register that the throwing instruction it came from
also writes. Closing it would mean splitting the terminator's output off onto
the normal edge only; it is left open, measured and documented because 11 is
small enough that T7 can treat those registers as unknown rather than wrong.

`--exception-model block` builds §4.2's coarse version instead, so the two can
be compared on the same input. Over the same twelve corpus files (1 969
functions, 463 handler ranges):

| | instruction (default) | block (§4.2) |
|---|---:|---:|
| basic blocks | 16 610 | 9 256 |
| edges | 24 385 | 12 676 |
| exception edges | 7 957 | 3 602 |
| phi nodes | 2 132 | 2 215 |
| max phi arity | 114 | 48 |
| SSA values | 128 107 | 128 151 |
| **handler live-ins written by a throwing block in the same range** | **0** | **34** |

The precise model costs 79% more blocks and 92% more edges. It does **not**
cost more phis — it has slightly fewer, because finer blocks make the liveness
pruning sharper. And the last row is the point: under §4.2's model, 34 handler
live-ins come from a block that writes them somewhere in the middle, so the
handler is handed a value the machine may never have produced. Under the
precise model that number is 0 on this subset and 11 over the whole corpus,
where the 11 are the terminator's own outputs and nothing else.

A range with no potentially-throwing instruction at all would leave its handler
block unreachable. Rather than drop the handler, an edge is added from the
range's first block and the range is counted in
`rangesWithoutThrowingInstruction`.

### The accumulator at a handler entry

The interpreter writes the pending exception into the accumulator before
dispatching to the handler offset, so the incoming accumulator is dead there.
It is modelled as its own `CaughtException` definition, carrying the handler
indices and their catch predictions — not as a phi over the predecessors. If
the accumulator were ever live-in at a handler the model would be wrong, so the
count is reported as `accumulatorLiveInAtHandler` and expected to be 0. It is
**0 of 25 189 handlers** over the whole corpus.

Why the prediction is on the value: ARCHITECTURE.md §9.1 found that 13 713 of
25 189 ranges are `ASYNC_AWAIT`, i.e. the `await` desugaring and not a source
`try`. T7 has to consume those in the async pattern and T8 must not emit a
`try` for them, so the discriminator is attached where the decision is made.

---

## 6. SSA

**Variables** = the accumulator ∪ the context register ∪ every parameter ∪ every
register-file slot. The frame-header registers (`<closure>`, the bytecode
array, the bytecode offset, the feedback vector, the argument count) are never
assigned, so they become `FrameEntry` values with exactly one definition and
need no phi.

`incomingNewTargetOrGeneratorRegister` is a register-file slot and nothing
else — `docs/DISASM.md` §9 is explicit that it is not a register kind of its
own. It gets an entry definition like any other local, which is what makes
`SuspendGenerator <gen>` and `ResumeGenerator <gen>` name the same thing;
treating it as a separate kind is what would stop the two references unifying.
The self-test asserts both references resolve to the same definition.

**Phi placement** is Cytron et al. figure 11 (the iterated dominance frontier of
the assignment set), **pruned**: a phi is placed only where the variable is
also live-in (Choi, Cytron and Ferrante, POPL 1991). That is not a refinement
here, it is necessary — the variable set is the whole register file, functions
in the corpus reach 320 simultaneously live registers, and unpruned SSA would
put a phi for every register at every join. Liveness is a backward bitset
fixpoint in which exception edges are ordinary successors, which is what makes
a handler's live-in propagate back into every throwing site of its range.

**Renaming** is figure 12 — a stack per variable, walked over the dominator
tree — made iterative with an explicit undo trail so a deep dominator tree
cannot overflow the JS stack.

> A note for whoever writes the next bitset fixpoint in this repo: every merged
> word is forced back to unsigned with `>>> 0`. JS bitwise operators produce a
> **signed** int32 while a `Uint32Array` element reads back unsigned, so for any
> variable set that uses bit 31 of a word, `merged !== set[w]` is true forever
> and the fixpoint never terminates. It bites at 32 variables, which is one
> small function with a dozen registers, and it presented as a hang on one
> function out of 1 334 rather than as a wrong answer.

### `SwitchOnGeneratorState` resume points

Ordinary multi-predecessor joins, and §9.2 says 10 068 of the corpus's 11 208
jump tables are these, so this is the main path rather than an edge case. The
dispatcher's jump-table edge is a normal CFG edge, so a resume block gets phis
exactly when a variable is live there and reaches it from more than one place.
The self-test builds `BuildSuspendPoint`'s shape twice over and asserts the
resume targets are `ResumeGenerator` leaders, that the suspends terminate their
blocks, and that the shared continuation has a phi.

---

## 7. The effect graph

Membership is decided by `opcode_effects.mjs`, never by a name test: an op
joins the chain when it writes an effect kind, can throw, can enter user code,
or **reads** an effect kind. That covers what §4.2 lists — property load and
store, call, construct, throw, context store, generator suspend, `delete`,
`in`, and the conversions that can trigger `ToPrimitive` — plus two it does not
mention and which matter:

* **context loads.** A mutable context slot read must not be hoisted across a
  store to the same context. §8.4 has one boolean, `hasEffect`, which cannot
  say "pure but order-sensitive", so a load has `hasEffect: false` and still
  appears in the chain with its read kind on `effect.reads`. The `Immutable*`
  loads are genuinely pure and stay out — which is exactly §4.3's "immutable
  context slot read may be duplicated" exception, made mechanical.
* **`SetPendingMessage`.** The `finally` desugaring saves and restores the
  isolate's pending message around the cleanup block. Reordering it silently
  changes which exception propagates.

The cross-block merge is **memory SSA**: one "effect" variable, phis placed by
the same dominance-frontier algorithm the value SSA uses (unpruned, because the
effect state is live everywhere). So `effectExit(b)` is one value id rather
than a set, which keeps the structure O(blocks) instead of O(blocks²) on a
function with thousands of blocks, and gives T7 an O(1) "what is the effect
state at this point" query. `EffectEntry` stands for everything that happened
before the call.

`interferingEffects(defId, useId, {kinds})` answers §4.3's inlining question
directly: the chain members that could run after the definition and before the
use, by block reachability, so a path that cannot actually be taken is still
counted. Conservative in the safe direction.

### Effect kinds

A location class; two ops interfere if one writes a kind the other reads or
writes. There is no alias analysis, so `heap` is one undifferentiated class.

| kind | what |
|---|---|
| `heap` | any JS object property, element or prototype |
| `global` | the global object / script context, via `Lda*Global` |
| `context` | a `Context` slot |
| `module` | a module import/export cell |
| `message` | the isolate's pending message |
| `generator` | a `JSGeneratorObject`'s state, continuation and spilled frame |
| `coverage` | block coverage counters |
| `debugger` | anything the debugger can observe or change |

### The two flags §8.4 requires

```
hasEffect          = effect.writes.length > 0 || effect.throws || effect.callsUserCode
allocatesIdentity  = effect.allocation ∈ {definite, maybe}
```

`allocatesIdentity` means "copying this definition to a second use site could
produce two objects where the program had one". `allocationKind` refines it:

| `allocationKind` | meaning | examples |
|---|---|---|
| `definite` | always a fresh object | the literal and context constructors, `Construct*` |
| `maybe` | may be a fresh object; we cannot tell | every call, every property load (a getter can return anything), `ToObject` |
| `cached` | one object, guaranteed, so duplication is safe | `GetTemplateObject` |
| `none` | no object identity | arithmetic, comparisons, moves, constants |

**The allocation table, in full.** Every row has a one-line reason in
`opcode_effects.mjs`; this is the list §8.4's last paragraph asks for.

| opcode | kind | what it allocates |
|---|---|---|
| `CreateObjectLiteral` | definite | a fresh `JSObject` from an `ObjectBoilerplateDescription` |
| `CreateEmptyObjectLiteral` | definite | a fresh `{}` |
| `CreateArrayLiteral` | definite | a fresh `JSArray` from an `ArrayBoilerplateDescription` |
| `CreateEmptyArrayLiteral` | definite | a fresh `[]` |
| `CreateRegExpLiteral` | definite | a fresh `JSRegExp`; `lastIndex` is mutable, so identity is observable |
| `CreateClosure` | definite | a fresh `JSFunction` capturing the current context |
| `CreateMappedArguments` | definite | a fresh sloppy `arguments` aliasing the parameters |
| `CreateUnmappedArguments` | definite | a fresh strict `arguments` |
| `CreateRestParameter` | definite | a fresh `JSArray` of the trailing arguments |
| `CreateBlockContext` | definite | a fresh block `Context` |
| `CreateCatchContext` | definite | a fresh catch `Context` holding the caught value |
| `CreateFunctionContext` | definite | a fresh function `Context` |
| `CreateFunctionContextWithCells` | definite | the same, with `ContextCell` slots |
| `CreateEvalContext` | definite | a fresh `Context` for a direct `eval` |
| `CreateWithContext` | definite | a fresh `with` `Context` |
| `Construct`, `ConstructWithSpread`, `ConstructForwardAllArgs` | definite | `new` always yields a new identity |
| `ForInPrepare` | definite | the `cache_type` / `cache_array` / `cache_length` triple |
| `ForInEnumerate` | definite | the enumerable-key array or map |
| `CloneObject` | maybe | object spread copies into a fresh object, running getters |
| `CreateArrayFromIterable` | maybe | array spread drains an iterator into a fresh `JSArray` |
| `ToObject` | maybe | wraps a primitive in a fresh wrapper |
| every `Call*`, `Construct*`, `CallRuntime*`, `InvokeIntrinsic`, `GetIterator`, `ForOfNext`, `ForInNext`, every property load, `FindNonDefaultConstructorOrConstruct`, `Debugger`, `DebugBreak*` | maybe | the callee or the accessor may return a fresh object; duplicating the op duplicates both the effect and the identity |
| `GetTemplateObject` | cached | the template object is cached per call site; the spec requires the same object every evaluation, so duplicating the op is safe but it is not an allocation either |
| everything else | none | |

`tools/ir/selftest.mjs` check **B** asserts the table is **total** over every
profile (no opcode falls through to the conservative `UNCLASSIFIED` row), that
it names no opcode a profile does not have, that `hasEffect` and
`allocatesIdentity` agree with their row, and that a named set of opcodes lands
in the right class in both directions — `Ldar`/`Star`/`Mov`/`LdaSmi`/
`TestEqualStrict`/`ToBoolean`/`TypeOf`/`ForInStep`/`LdaImmutable*ContextSlot`
pure, the property and call opcodes effectful, the constructors allocating, and
the mutable context loads pure-but-in-the-chain.

### The implicit register tables

Three statements that no generated table carries, because they are about what
the interpreter handler does to a frame register no operand names:

`IMPLICIT_CONTEXT_WRITE` — the handler calls `SetContext()`:

| opcode | |
|---|---|
| `PushContext` | installs the accumulator as the current context |
| `PopContext` | reinstalls the context held in its register operand |
| `SwitchOnGeneratorState` | installs the resumed generator's own context |

`IMPLICIT_CONTEXT_READ` — the handler consumes the current context as a
*value*: `PushContext` (it saves it), the six `*CurrentContextSlot` forms (they
address slots in it), the six `Create*Context` forms and `CreateClosure` (they
capture it), `SuspendGenerator` (it spills it), and `Lda/StaModuleVariable`
(they walk to the module context).

Every bytecode technically reads the frame's context — that is how the
interpreter reaches the native context for an IC. Recording that everywhere
would make the context register an input of 10.9M instructions and say nothing,
so it is recorded only where the context value is semantically consumed, which
is what the context-chain analysis needs.

---

## 8. Context slots

An `Lda/StaContextSlot` names a slot by `(context, index, depth)`. Depth counts
`PREVIOUS_INDEX` hops up from the context the instruction starts at, which for
the `Current*` forms is whatever the frame's context register holds **at that
instruction** — not the function's own scope.

### Two analyses, because the question has two forms

* a **value** lattice, for `LdaContextSlot <context> …`, whose base is a
  register holding a context. Each SSA value maps to a context frame or to
  "not statically one context";
* a per-**instruction** frame, for the `Current*` forms, by a forward dataflow
  over the CFG. A value lattice alone cannot answer this one, because
  `SwitchOnGeneratorState` installs a context on its *resume* edges and leaves
  it alone on its fall-through edge, so the single SSA value it defines means
  different things on different edges.

### Depth 0 is `unit.scope.outer`, not `unit.scope`

```cpp
Scope* Scope::GetOuterScopeWithContext() {
  Scope* s = outer_scope_;
  while (s != nullptr && !s->NeedsContext()) s = s->outer_scope_;
  return s;
}                                                    -- src/ast/scopes.cc
```

`ScopeInfo::Create` stores exactly that scope's `ScopeInfo` in
`outer_scope_info`, and `Scope::ContextChainLength` counts only scopes that
need a context, so the depth operand walks the same chain, one link per
context-allocating scope. A function's **own** context, when it has one, is not
the entry context: the prologue builds it with `CreateFunctionContext` and
installs it with `PushContext`, and only from there is depth 0 the function's
own scope.

Two measurements from a real listing of
`corpus/features/disasm/closures_context.js` settle it:

```
outer()  @0  CreateFunctionContext [0:ScopeInfo FUNCTION_SCOPE], [3]
         @3  PushContext r1
         @7  StaCurrentContextSlotNoCell [2]       <- first local at slot 2
inner()  no CreateFunctionContext at all, and
         @43 LdaImmutableCurrentContextSlot [2]  -> "f", the `let f` of the
              enclosing block: depth 0 is already the OUTER context
```

Treating `unit.scope` as depth 0 names every slot one scope too deep for a
function that allocates no context of its own, and reads a *plausible wrong
name* rather than failing — the worst possible failure mode. The whole of
`closures_context.js` round-trips: `inner` resolves `a`, `b`, `c` at depth 2,
`d`, `e` at depth 1 and `f` at depth 0, which is what the listing says.

### Suspend / resume pairing

```cpp
builder()->SuspendGenerator(generator_object(), registers, suspend_id);
builder()->Bind(generator_jump_table_, suspend_id);
builder()->ResumeGenerator(generator_object(), registers);
                           -- BytecodeGenerator::BuildSuspendPoint
```

So the `ResumeGenerator` for suspend id *j* is the instruction immediately after
the `SuspendGenerator` carrying that id, with the same register list, and the
jump-table entry for case *j* targets it. Two things follow and both are needed:

* the context the generator resumes with is the context that was current at
  that suspend, because `SuspendGenerator` spilled it there. The dispatcher's
  resume edge therefore carries that frame rather than the dispatcher's own
  outgoing context;
* `ResumeGenerator`'s register outputs hold the values `SuspendGenerator`'s
  register inputs held, so a context parked in a register survives the round
  trip and can be followed through it.

The dispatcher's own SSA value is the meet of the incoming context and every
matching suspend's context, which is also what breaks the circularity — the
incoming context is known from the start. Getting this wrong is not academic:
before it was modelled, 12.6% of all context-slot operations in one corpus file
came back `contextValueNotReached`, all of them in async functions.

### Resolving the index

```cpp
int ScopeInfo::ContextHeaderLength() const {
  return HasContextExtensionSlot() ? Context::MIN_CONTEXT_EXTENDED_SLOTS
                                   : Context::MIN_CONTEXT_SLOTS;
}                                        -- src/objects/scope-info.h
```

so `localIndex = slot − ContextHeaderLength(scope)` and the name is
`scope.contextLocalNames[localIndex]`.

**ARCHITECTURE.md §8.1 is wrong about this.** It says the subtrahend is
`kVariablePartIndex`. That is an index into the `ScopeInfo`'s own field list —

```cpp
enum Fields { kFlags, kParameterCount, kContextLocalCount,
              kPositionInfoStart, kPositionInfoEnd, kVariablePartIndex };
```

— so it is 5, and it has nothing to do with the `Context`. Using it shifts
every name by three or two.

`MIN_CONTEXT_SLOTS` is read from the profile when the profile has it. Today it
does not: `profiles/*/layouts.json` records `enums.ContextSlot.members` as
`{ MIN_CONTEXT_SLOTS: 0 }`, because profilegen's Torque enum reader skips
members whose type is `Slot<Context, T>` and then numbers what is left from
zero. **That is a fifth silent profilegen gap on top of the four in
ARCHITECTURE.md §9.6**, and it is reported in the CLI output and in the corpus
report rather than patched around.

The fall-back hardcodes no number either: it counts the slots every `Context`
has, which `src/objects/contexts.tq` declares as the only two
`Slot<Context, …>` members of the `ContextSlot` enum before the
`NativeContext`-only ones begin —

```
enum ContextSlot extends intptr constexpr 'Context::Field' {
  SCOPE_INFO_INDEX: Slot<Context, ScopeInfo>,
  PREVIOUS_INDEX: Slot<Context, Context|Zero|Undefined>,
  AGGREGATE_ERROR_FUNCTION_INDEX: Slot<NativeContext, JSFunction>,
  ...
```

— plus one for the extension slot when `ScopeFlags.has_context_extension_slot`
is set. The result is then checked against the data on every function: a slot
operand must land inside `[0, contextLocalCount)` of the scope the chain says
it belongs to, and the corpus rate is reported. An off-by-one here would take
that rate to roughly zero; it is 99%+ (§9).

### The one thing §8.1 does not carry

A context the function builds itself names its `ScopeInfo` through a
constant-pool operand, and §8.1 renders that entry as
`{t:'scopeInfo', scopeInfoId}` — an object id with no names attached. The
function's *own* activation context is covered, because its id matches
`unit.scope.scopeInfoId`; a block, catch or `with` context is not.
`tools/ir/units.mjs` therefore decodes every `ScopeInfo` in the deserialized
graph with `src/heap`'s own decoder and hands it over as
`scopeInfoById`. `src/ir` treats the map as optional and reports
`createdContextScopeInfoNotDecoded` when it is absent, so nothing is invented
either way. This belongs on `buildUnits`'s result eventually; it lives in
`tools/` because `src/heap` is T4's and is not to be modified.

---

## 9. Acceptance

The full numbers, the invariant table, the reducibility measurement and the
corpus shape distributions are in
**[`scratch/t6/IR_CORPUS.md`](../scratch/t6/IR_CORPUS.md)** (and
`IR_CORPUS.json`), produced by `tools/ir/corpus_scan.mjs`; the self-test table
is in **[`scratch/t6/SELFTEST.md`](../scratch/t6/SELFTEST.md)**.

### Totals, all 1039 files

| metric | value |
|---|---:|
| files read | 1039 / 1039 |
| functions | 239 979 |
| instructions | 10 883 604 |
| **functions whose IR failed to build** | **0** |
| basic blocks | 1 577 930 |
| blocks reachable from the entry | 1 577 930 (100.0000%) |
| **unreachable blocks** | **0** |
| edges | 2 107 268 |
| SSA values | 14 373 569 |
| phi nodes | 241 477 (max arity 896) |
| projections | 149 378 |
| `CaughtException` definitions | 25 189 |
| effect-chain ops / effect phis | 3 589 606 / 259 753 |
| ops with `hasEffect` / `allocatesIdentity` | 3 464 196 / 2 608 950 |
| loops / back edges | 18 201 / 18 201 |
| handler ranges / handler blocks / exception edges | 25 189 / 25 189 / 441 578 |
| jump tables: generator dispatchers / `SwitchOnSmiNoFeedback` | 10 068 / 1 140 |
| switch successor edges | 23 242 |
| context slot ops **resolved to a name** | **968 489 / 980 989 = 98.726%** |
| functions the brute-force oracles ran on | 2 958 (25 715 blocks) |
| wall time | 1 674 s, two forked jobs, 1 400 MB child heap (2 670 s of child CPU) |

The function and instruction counts match `docs/DISASM.md`'s corpus scan
exactly (239 979 and 10 883 604), and the jump-table, handler-range and
jump-table-entry counts match its 11 208 / 25 189 / 23 242 — which is the
cheapest confirmation that the IR is built over the whole of what the
disassembler decoded and not a subset.

### All 17 invariants, 0 violations

Every one of the invariants in the list below holds on every function of every
file: 0 violations out of 14 373 569 SSA values, 2 107 268 edges, 241 477 phis,
1 577 930 blocks, 18 201 back edges, 25 189 handler ranges and 23 242 jump
table entries. `idom` and `ipdom` agree with the brute-force oracles on all
2 958 functions they were run on.

Three things were reported rather than relaxed:

* **`handlerRangeEmpty` × 5** — five handler ranges in the corpus have
  `rangeEnd <= rangeStart`. They are warned about and otherwise behave as
  degenerate ranges.
* **`rangesWithoutThrowingInstruction` × 51** — 51 ranges contain nothing that
  can raise, so their handler would be unreachable; an edge is added from the
  range's first block and the range is counted.
* **`liveInWrittenByThrowingTerminator` × 11** — the residual imprecision of
  the `invoke` model, out of 441 578 exception edges. See §5.

And three model assumptions came out exactly as the model requires: 0
handlers with a live-in accumulator, 0 uses of a clobbered accumulator, and 0
inner handlers not covered by their enclosing range (which is what makes
innermost-only exception edges sound).

### How the corpus scan runs

One **child process per file**. The host has 4 GB and about two cores, and a
file's IR is several times the size of its disassembly, so a single long-lived
process accumulates fragmentation it never gives back; a forked worker gives
the memory back on exit, lets a pathological file be killed on a timeout
instead of taking the run with it, and uses the second core. Each child gets
its own `--max-old-space-size`. The run is **resumable**: each file's result is
a JSON file under `--work`, a file whose result exists is skipped, and
`--force` re-does everything. Output goes to files, never through a pipe.
Nothing from the corpus is executed.

### The invariants

Asserted on **every function of every file**, by `src/ir/verify.mjs`, which the
CLI, the self-test and the corpus scan all share so they assert the same thing:

1. every block is reachable from the entry
2. every edge's endpoints exist, and the adjacency lists agree with the edge list
3. every SSA use is dominated by its definition
4. every phi operand is available at the matching predecessor's exit
5. phi arity equals the predecessor count, in predecessor order
6. every variable use has exactly one reaching definition, for the right variable
7. every back edge's target dominates its source
8. the loop nesting forest is a forest, and every header dominates its body
9. `ipdom` is a tree rooted at the virtual exit
10. every jump-table target is a block leader
11. every protected range has a handler block and at least one exception edge
12. every back edge comes from the backward branch opcode
13. every reachable `JumpLoop` produces exactly one classified edge
14. switch successor count equals the decoded jump-table entry count
15. the accumulator is dead at every handler entry
16. `idom` agrees with the brute-force dominator oracle *(budgeted)*
17. `ipdom` agrees with the brute-force post-dominator oracle *(budgeted)*

### Reducibility: §0's claim is false, and it is the dispatcher's fault

ARCHITECTURE.md §0 asserts:

> **控制流必然 reducible**（图是从结构化 JS 直接发射的），
> 不需要处理一般意义上的 irreducible CFG。

Measured rather than argued. A small number of functions **are** irreducible,
all of them `async`, and the shape is always the same: the entry
`SwitchOnGeneratorState` jumps straight into the middle of a loop body, which
is a second entry into the cycle. From a real listing of an `async function`
with an `await` inside a `for`:

```
@0   SwitchOnGeneratorState r0, [0:53], [1] { 0: @53 }
@22  <loop header>
@48  SuspendGenerator r0, r0-r4, [0]
@53  ResumeGenerator r0, r0-r4            <- the table target, inside the loop
@82  JumpLoop [60] (@22)
```

The loop header `@22` does not dominate the latch `@82`, because `@82` is
reachable from the dispatcher without passing through `@22`.

So the scan measures it **twice**: once on the CFG as built, and once with the
dispatcher's resume edges removed — which is precisely what
ARCHITECTURE.md §4.4.6 tells T8 to do ("删掉分派器").

| measurement | value |
|---|---:|
| retreating edges | 18 364 |
| of those, back edges (target dominates source) | 18 201 |
| **irreducible retreating edges** | **163** |
| **functions containing one** | **121** of 239 979 = **0.0504%** |
| of those, `async` | 80 |
| of those, generator | 42 |
| of those, neither | **0** |
| **functions still irreducible once the resume edges are removed** | **0** |
| edges still irreducible once the resume edges are removed | **0** |

(80 + 42 = 122 against 121 functions because one is an async generator and is
counted in both rows.)

So §0's *reasoning* is right and its *claim* is wrong. Every irreducible
function in the corpus is irreducible because of the resume dispatcher, and
nothing else; no function that is neither `async` nor a generator is
irreducible. The consequence for T8 is a single ordering constraint, not a new
algorithm:

> **Delete the `SwitchOnGeneratorState` dispatcher before structuring loops,
> not after.** Do that and every CFG in the corpus is reducible, so §4.4's
> plan needs the `goto` fall-back only as insurance against an input the corpus
> does not contain.

The opcodes the irreducible edges leave from are spread across 17 different
terminators (75 `JumpLoop`, 27 `Jump`, 12 `JumpConstant`, 11
`JumpIfToBooleanFalse`, 8 `PopContext`, 7 `JumpIfFalse`, 5 `Ldar`, …), which is
the other reason not to try to recognise the shape by opcode: it is a property
of the dispatcher's edges, not of the edge that happens to close the cycle.

Note that "163 irreducible retreating edges" and "130 `JumpLoop` edges in an
irreducible region" (below) count two different things and neither is wrong.
*Which* retreating edge a depth-first numbering picks out of an irreducible
region is a property of the traversal; whether a cyclic edge's target dominates
its source is a property of the graph. The classification below uses the
second, so it does not depend on the DFS order.

### The `JumpLoop` cross-check, restated

"CFG back edges must equal the `JumpLoop` count per function" is the obvious
cross-check against the disassembler, and it is **false**. `JumpLoop` is V8's
only backward branch, so every reachable one points backwards in *offset*
space — but that is not the same as pointing backwards in the CFG. In an async
function whose `await` is inside the loop, the body ends in `SuspendGenerator`,
which **returns**, so the body has no path back to the header: one invocation's
CFG is acyclic and the loop closes only by re-entering the function through the
resume dispatcher. The `JumpLoop` edge is then an ordinary forward edge.

What is asserted instead:

* **back edges ⊆ `JumpLoop` edges** — nothing else can produce a back edge;
* every reachable `JumpLoop` produces exactly one edge, classified as a back
  edge, an edge in an irreducible region (cyclic, target does not dominate), or
  a forward edge whose cycle is broken by a suspend.

Both hold with 0 violations. The classification over the corpus:

| what a reachable `JumpLoop` turned into | count | share |
|---|---:|---:|
| a back edge (target dominates source) | 18 201 | 97.91% |
| in an irreducible region | 130 | 0.70% |
| a forward edge, cycle broken by a suspend | 259 | 1.39% |
| unclassified (would be a real failure) | **0** | 0% |
| total reachable `JumpLoop` instructions | 18 590 | |

243 functions are in the third shape. For those, "find the loop" is not a CFG
question at all — the loop exists only across invocations, and T8 has to
reconstruct it from the suspend/resume pairing, which is why
`ir.contextChain.suspendByIdIns` and `suspendOfResume` are exposed.

### The shape of the corpus, for T7 and T8

| metric | value |
|---|---|
| mean blocks per function | 6.58 |
| mean instructions per block | 6.90 |
| mean edges per block | 1.34 |
| mean phis per function | 1.01 |
| mean SSA values per function | 59.9 |
| functions with at least one loop | 12 844 (5.35%) |
| functions with exception edges | 18 245 (7.60%) |
| functions with a generator dispatcher | 10 068 (4.20%) |
| functions with a `SwitchOnSmiNoFeedback` table | 842 (0.35%) |

| distribution | shape |
|---|---|
| blocks per function | **55.1% are a single block.** 3–8: 28.5%. 9–32: 12.1%. 33–128: 4.0%. Over 128: 0.24%, with 4 functions over 1024. |
| edges per block | 0: 20.2% (every block that returns or throws), 1: 26.8%, 2: 52.7%. Over 2: 0.26%, max 129–256. |
| instructions per block | 1–2: 46.1%, 3–8: 37.9%, 9–32: 13.3%, over 32: 2.6%. |
| loop nesting depth | depth 0: 86.8%, 1: 11.1%, 2: 1.7%, 3: 0.35%, 4: 0.02%. **Max nesting is 5 levels.** |
| phis per function | **66.3% have none.** 1–2: 24.7%. 3–8: 7.0%. 9–32: 1.8%. Over 32: 0.15%. |
| phi arity | 2: 79.2%, 3–8: 14.4%, 9–32: 4.6%, over 32: 1.9%, max **896**. The long tail is entirely handler phis. |
| predecessors per block | 1: 65.8%, 2: 14.8%, 0: 15.2% (entries and unreachable-by-normal-flow handler blocks have only exception predecessors), over 2: 4.2%. |
| exception predecessors per handler | 3: 16.0%, 9–16: 21.1%, 17–32: 19.8%, 33–64: 11.1%. **Half of all handlers have 9 or more throwing sites in their range.** |
| SSA values per function | 17–64: 47.1%, 65–256: 19.6%, over 256: 2.9%. |
| max context depth per function | 0: 82.7%, 1: 11.6%, 2: 4.4%, 3: 1.2%, 4+: 0.25%, max 7. |
| edges by kind | fallthrough 32.3%, **exception 21.0%**, true 19.0%, false 19.0%, unconditional 7.6%, switch 1.1%. |

Four of these change what T7 and T8 should expect:

* **Exception edges are a fifth of the whole graph.** 441 578 of 2 107 268.
  Any pass that walks `succs` without knowing about them will be wrong on 7.6%
  of functions, and any pass that treats them as ordinary control flow will
  produce nonsense. Use `normalSuccs` for structuring.
* **Handler phi arity is the long tail.** Half of all handlers merge 9 or more
  throwing sites, the worst merges 896. A structuring pass that materialises
  one temporary per phi operand will explode on those; it needs to recognise
  that a handler's phis are a *spill merge*, not a source-level join.
* **Loops are rare and shallow** — 5.35% of functions, 86.8% of loops at
  nesting depth 0, never deeper than 5. The loop work T8 has to do is small.
* **Half the corpus is a single basic block**, and two thirds of functions need
  no phi at all. The expensive machinery only engages on a minority.

### The self-test

`tools/ir/selftest.mjs` — **56 checks, 56 pass**, two profiles, no engine and
no `.jsc`.

| group | what |
|---|---|
| **A** | the hygiene grep: no hex literal, no 3+-digit decimal, no numeric opcode comparison anywhere in `src/ir/` |
| **B** | the effect/allocation table is total over every profile and consistent with its own rows; the register read/write roles come from the operand-type lists; the context header length is derived and the profilegen gap is reported |
| **C** | hand-built CFGs — diamond, nested loop, loop with multiple exits, irreducible (two entries into a cycle), switch fan-out, endless loop — with `idom`, `ipdom`, the dominance frontiers and the loop forest asserted against both the expected answer and the brute-force oracles |
| **D** | assembled bytecode through the whole of `buildIR`: diamond phi, loop phi + latch, nested `try` with innermost-first lookup, exception edges leaving the throwing instruction (with the counterexample from §5), switch fan-out, the generator dispatcher, the `finally` token dispatch, the effect order, the incoming generator register, and context slots through `PushContext`/`PopContext` |
| **E** | every assembled shape through all 17 invariants with the brute-force oracles on, plus a check that the assembler and `src/disasm` agree on every jump target |

`tools/ir/asm.mjs` is a profile-driven assembler with labels, jump tables and a
handler table, so the hand-built cases contain no hardcoded byte: the opcode
values, operand widths and register encoding come from the profile, and the
jump deltas are computed by the same rule the decoder reads them back with —
relative to the opcode byte, negated for the one backward jump. A mistake in
either direction shows up as a disagreement between the assembler and
`src/disasm` rather than as a passing test.

---

## 10. What §8.4 got wrong or left out

| § | what it says | what is true |
|---|---|---|
| §8.1 | `contextLocalNames` is indexed by `context slot − kVariablePartIndex` | the subtrahend is `ScopeInfo::ContextHeaderLength()`, 2 or 3. `kVariablePartIndex` is 5 and indexes the `ScopeInfo`'s own fields. |
| §4.2 | a handler's register state is "the phi of all blocks in the protected range", and that is conservative because V8 spills live values before a `try` | wrong in both directions; §5 has the counterexample. The fix is to end a block at every throwing instruction inside a range. |
| §4.2 | the task text cites `HandlerTable::LookupRange` | the pinned 14.4.258.16 header declares `LookupHandlerIndexForRange` |
| §4.2 | the effect set is "property read/write, call, construct, throw, context write, generator suspend, `delete`, `in`" | context **loads** must be in the order too, and so must `SetPendingMessage`, or the `finally` desugaring can be reordered |
| §8.4 | `Op` needs `hasEffect` and `allocatesIdentity` | two booleans cannot express "pure but order-sensitive" (a mutable context load) or "cached, so duplication is safe" (`GetTemplateObject`). `effect.{reads,writes,throws,callsUserCode}` and `allocationKind` are added; the two required booleans are derived from them. |
| §8.4 | `blocks[].kind` is one of four | a block is regularly several at once. `kinds[]` added, `kind` resolved by priority. |
| §8.4 | `preds`/`succs` plus `exceptionSuccs` | it does not say whether `succs` includes the exception edges. It must, or dominance and SSA are wrong; `normalSuccs`/`normalPreds` added for structuring. |
| §8.4 | no explicit edge list | phi operand order is "in predecessor order", which is only well defined with one entry per *edge*: two edges from the same block need two operands. `edges[]` added and `preds[j] === edges[inEdges[j]].from` is asserted. |
| §8.4 | `values: Map<ssaId, Value>` with kinds `Const\|Param\|Phi\|Op\|ContextSlot\|CaughtException` | multi-output instructions need `Proj`; entry state needs `FrameEntry`; the effect merge needs `EffectPhi`/`EffectEntry`. And `ContextSlot` is a location, not a dataflow definition. |
| §8.4 | nothing about the exit | post-dominance needs a virtual exit, and a function with an endless loop needs invented edges to it. `exit`, `exitPreds` and `virtualExitEdges` added, the invented count reported. |
| §0 | the CFG is always reducible | false for `async` functions that `await` inside a loop; see §9. The claim's *reasoning* is sound — the generator dispatcher is not a control-flow rewrite the `BytecodeGenerator` performs for a source construct, it is the desugaring of resumability. |
| §9.6 | four silent profilegen gaps | a fifth: `enums.ContextSlot` is `{MIN_CONTEXT_SLOTS: 0}` |

And one thing neither §4.1 nor §8.2 mentions, repeated here because the whole
exception and loop model rests on it: **`SuspendGenerator` returns.** It is a
terminator. `docs/DISASM.md` does not say so because the disassembler does not
care; the IR does, and getting it wrong invents 5 of 8 irreducible functions
and breaks the `JumpLoop` cross-check on every async loop.

---

## 11. Known gaps

Everything here is reported by the tooling, never papered over.

| gap | effect | owner |
|---|---|---|
| `enums.ContextSlot` in `layouts.json` is `{MIN_CONTEXT_SLOTS: 0}` | the context header length falls back to a derivation from the two universal `Slot<Context,…>` members of `contexts.tq`; reported in the CLI output and the corpus report, and verified against 980 989 real slot operands | profilegen (T1), see §9.6 |
| §8.1's constant pool renders a `ScopeInfo` as `{t:'scopeInfo', scopeInfoId}` with no names | a block/catch/`with` context's slot names need the `scopeInfoById` map `tools/ir/units.mjs` builds from the deserialized graph. Without it those slots come back `createdContextScopeInfoNotDecoded` | belongs on `buildUnits`'s result (T4) |
| `contextValueNotStaticallyKnown` on 12 119 of 980 989 slot operands (1.24%) | the context register holds different context objects on different paths into that instruction, so the slot has no single name. Reported per occurrence with the reason; nothing is guessed | inherent; T7 should emit the `/* ctx[d][i] */` marker §4.5 asks for |
| `slotOutsideContextLocals` × 303, `contextChainShorterThanDepth` × 78 | the chain resolved to a frame but the index or the depth does not fit it. These are the cases worth looking at next if the 98.7% is to go higher | `src/ir/context.mjs` |
| `liveInWrittenByThrowingTerminator` × 11 | the `invoke` model's residual imprecision, §5 | `src/ir/cfg.mjs` |
| `handlerRangeEmpty` × 5 | five handler ranges have `rangeEnd <= rangeStart`; warned about and treated as degenerate | the input, or `src/heap`'s handler table decoder |
| `rangesWithoutThrowingInstruction` × 51 | a range containing nothing that can raise; an edge from the range's first block keeps the handler reachable, and the range is counted | inherent |
| `CallRuntime` is one conservative effect row | `%ToFastProperties` is treated as able to do anything, which blocks inlining it would be safe to do. A per-runtime-function table would refine it; the current row is correct, just coarse | `src/ir/opcode_effects.mjs` |
| no alias analysis | `heap` is one effect kind, so any two property accesses interfere | by design for now |
| `Runtime::kNewScriptContext` and friends | a context created through `CallRuntime` rather than a `Create*Context` bytecode is not followed, so its slots do not resolve. Not observed to matter in the corpus (`contextValueNotStaticallyKnown` covers it) | `src/ir/context.mjs` |
