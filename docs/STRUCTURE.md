# `src/structure/` — CFG → a structured control tree

Stage D of [ARCHITECTURE.md §4.4](ARCHITECTURE.md). Input: the §8.4 IR from
`src/ir/` (see [IR.md](IR.md)). Output: the `StructuredFunction` of
ARCHITECTURE.md §11.2 — **the shape of the graph and no expressions at all**.

```js
import { structure } from './src/structure/index.mjs';
const sf = structure(ir);          // ir from src/ir/buildIR
```

A condition is `Test = { block, value: ssaId, negate, predicate, toBoolean }`
— "the SSA value the terminator of that block reads". T8 never says "the
condition is `a > b`". T7 maps SSA values to expressions independently and T9
joins the two, which is why the two tasks need no communication.

```
src/structure/
  index.mjs       the fixed stage order
  facts.mjs       every opcode name and branch predicate this layer matches
                  on, checked against the loaded profile once
  dispatcher.mjs  STAGE 1: delete the generator/async resume dispatcher
  graph.mjs       the structuring graph (normal edges only, dispatcher gone,
                  suspends spliced) + dominators / post-dominators / loops
  exceptions.mjs  handler ranges -> try; the await desugaring -> nothing
  loops.mjs       natural loops -> while / doWhile / for / forever
  switches.mjs    the jump table AND the compare chain
  regions.mjs     acyclic regions by follow node -> if/else; the tree
  conditions.mjs  Test and Target -- the whole of the T7/T8 split
  jumps.mjs       break / continue / labels
  fallback.mjs    the honest `unstructured` region
  verify.mjs      the invariants
tools/structure/
  selftest.mjs    63 checks, both profiles, no engine and no corpus
  corpus_scan.mjs one child process per file, capped heap, results to files
  corpus_worker.mjs
tests/t8/fixtures/
  24 minted `.jsc` files, one per source construct, real V8 14.4.258.16
  bytecode, checked in so the self-test never spawns an engine
```

---

## 1. The stage order, and why it is forced

```
1. remove the resume dispatcher and splice every suspend to its resume
2. classify handler ranges; remove the ones that are await desugaring
3. build the structuring graph: dominators, post-dominators, natural loops
4. plan the try regions  (a fixpoint -- see below)
5. plan loops and switches
6. build the region tree
7. verify, or fall back to one honest `unstructured` region
```

**1 before 3** is ARCHITECTURE.md §10.1, and it is the whole reason the
project does not need a goto-elimination framework. Measured over all 239 979
corpus functions: 121 functions contain 163 irreducible retreating edges, 80
of them `async` and 42 generators, **none of them neither**; with the resume
edges removed first, **0 functions are irreducible**. The dispatcher jumps
into the middle of a loop body and is the second entry that makes the graph
irreducible — nothing else in the corpus does.

The same stage has a second, independent job. `SuspendGenerator` *returns*
(IR.md §3), so when an `await` sits inside a loop the body ends in a
terminator and one invocation's CFG is **acyclic**: there is no back edge to
find. Over the corpus, 18 201 `JumpLoop` edges are back edges, 130 are in
irreducible regions and **259 are forward edges in 243 functions** for exactly
this reason. Splicing each suspend to its matching resume restores the cycle.
So "back-edge count equals `JumpLoop` count" is false, and the self-test's
`await inside a loop` case asserts the interesting direction: that function's
IR has **zero** back edges and still produces one `while` loop.

The pairing comes from T6's `ir.contextChain.suspendByIdIns` /
`suspendOfResume` (ARCHITECTURE.md §11.2 constraint 1), never from opcode
guessing, and each splice is checked against V8's own emission order —
`BuildSuspendPoint` binds the jump-table entry for suspend id *j* to the
instruction immediately after the suspend carrying *j*. A table entry that
points elsewhere is reported as `resumeEdgeNotAfterSuspend` and nothing is
spliced.

**Stage 4 is a fixpoint, not one pass.** A handler block has no normal
predecessor at all, so the only thing that makes it dominance-reachable is the
synthetic `rangeEntry -> handlerBlock` edge `graph.mjs` adds for each *planned*
range. A range whose own entry lies inside another range's handler region is
therefore unreachable while that outer range is unplanned, and gets skipped as
`rangeEntryUnreachable` — after which its handler block is neither placed nor
removed and silently vanishes from §11.3 invariant 1. `proxyWeChatRequest` in
`b_357background.jsc` is that case: handler 3's range starts inside handler
2's catch body, and three blocks went missing with no fall-back and no
warning. So the loop is: plan, add the edges, re-plan, until the plan set stops
growing. It only grows, so it converges; the round cap is there because a
budget is cheaper than a proof.

---

## 2. The structuring graph

`graph.mjs` builds the one view of the CFG that structuring may look at. It
differs from `ir`'s graph in four measured ways.

1. **No exception edges.** ARCHITECTURE.md §10.6: exception edges are **20.95%**
   of all 2 107 268 corpus edges. They belong in `succs` because dominance and
   SSA are wrong without them, and they are wrong for `if`/`else` shape — an
   exception edge is not a branch the program takes, it is a trap. The walk
   view is built from `normalSuccs`/`normalPreds` (§11.2 constraint 2).
2. **The resume dispatcher is gone and every suspend is spliced** to its
   resume (§1 above).
3. **One synthetic dominance edge per structured handler range**, from the
   range's entry block to the handler block, in the *dominance* view only. The
   walk view never offers it, so no chain can wander into a handler except
   through the `try` construct that owns it.
4. **Parallel edges are collapsed.** `if (c) goto L; else goto L;` is two IR
   edges and one successor; readiness counting is per predecessor *block*.

Dominators, post-dominators and natural loops are T6's
(`src/ir/dominators.mjs`, `src/ir/loops.mjs`) run over this view.
ARCHITECTURE.md §11.6 says not to re-implement them, and this is the one thing
T6 cannot supply ready-made, because `ir.idom` / `ir.loops` describe the graph
*including* exception and resume edges.

---

## 3. Algorithms, cited

* **Dominators, post-dominators, dominance frontiers** — Keith D. Cooper,
  Timothy J. Harvey, Ken Kennedy, *A Simple, Fast Dominance Algorithm*, Rice
  TR-06-33870 (2001), as implemented by T6 and run by `graph.mjs` over the
  structuring graph. Post-dominators are the same algorithm on the reverse
  graph rooted at a virtual exit (IR.md §4).
* **Natural loops and the nesting forest** — Aho, Lam, Sethi, Ullman,
  *Compilers* (2nd ed.) §9.6.6: a back edge `n -> h` with `h` dominating `n`,
  the loop body as the backward closure from the latches stopping at the
  header. T6's `findLoops`.
* **The follow node of a two-way conditional** — Cristina Cifuentes, *Reverse
  Compilation Techniques* (PhD, QUT 1994) ch. 6, `structConds`: the node the
  header immediately dominates that has two or more in-edges, earliest in the
  ordering. The immediate post-dominator is the cross-check and the fall-back.
  This is what replaces `src/relooper.js:_findMergeBlock`'s "lowest-numbered
  block reachable from both branches", which is neither.
* **Interval / structural analysis** in the general sense (Sharir 1980; Allen
  & Cocke 1976) is what "open the construct where it begins, recurse into its
  body, continue at its follow" is an instance of.
* **Loop form from the position of the test** — ARCHITECTURE.md §4.4.1, V8's
  own `LoopBuilder` shape.

Deliberately **not** used: a goto-elimination framework (Yakdan et al.,
*DREAM*, NDSS 2015; Erosa & Hendren, *Taming Control Flow*). IR.md §9 measures
the corpus as fully reducible once the resume dispatcher is removed, so
natural loops plus post-dominator regions are sufficient and §4.4.7's
`unstructured` fall-back is insurance rather than the main path.

One ordering choice differs from the literature and it is deliberate:
**everything that needs "earliest" uses bytecode offset, not reverse
postorder.** `BytecodeGenerator` is a single pass over the AST that never
reorders, so the bytes between two points are exactly the source text between
them. A depth-first numbering depends on which branch the walk took first, and
picks the wrong join when a `switch` has fall-through between cases.

---

## 4. Loop form

The test is **not** always in the header block. `LoopBuilder` puts the
condition at the top of the loop, but IR.md §3's leader rule ends a block after
every potentially-throwing instruction inside a protected handler range
(ARCHITECTURE.md §10.2, LLVM's `invoke` model). A comparison can call
`valueOf`, so inside an `async` function — whose whole body is one ASYNC_AWAIT
range — `while (i < n)` comes out as

```
B3  Ldar r0 / TestLessThan r1          (the block ends here)
B4  JumpIfFalse -> exit
```

with the comparison in the header and the branch in the block after it.
Requiring the two-way terminator to be in the header classified that as
`forever` with no test at all.

So the test is looked for along the **test chain**: the header plus the run of
blocks after it that form one straight line with it, up to the first two-way
terminator. A block joins only when its predecessor is its *only* predecessor
and the edge is not a back edge, which makes the chain single-entry
single-exit — dominated by the header and post-dominating it by construction,
with no post-dominator query needed.

| form | when |
|---|---|
| `while` | the test chain ends in a two-way with exactly one successor inside the loop body, and every value the chain defines feeds the test with exactly one use |
| `for` | the same, and the single latch is a *dedicated continue target*: two or more in-body predecessors and its only in-body successor is the header. V8 gives a `for` loop a separate continue target, so structuring it as `while (test) { body; update }` would turn `continue` into a jump into the middle of the body |
| `doWhile` | the chain carries statements the test does not consume, and everything between the test and the back edge is statement-free. V8 emits no backward conditional jump — every loop closes with `JumpLoop` — so a `do/while` puts the body *and* the test ahead of the back edge and leaves the latch holding only the jump |
| `forever` | anything else |

`init` is always `null`: V8 puts the initialiser in the block before the
header, which also carries whatever preceded the loop, and a `{r:'block'}`
leaf cannot be split.

**The test chain has to be accounted for.** `while (test) body` emits no
statement for the chain's blocks, because the test is an SSA value whose whole
dependency cone T7 inlines into the expression. That is only sound when every
value the chain defines either feeds the test with exactly one use (§4.3's
inlining condition, evaluated with T6's `defUse` and `hasEffect`, never an
opcode name) or is dead and pure. When it does not hold the form degrades, as
the table says, and the degradation is counted. The chain's blocks travel in
`removed.loopTestBlocks` so §11.3 invariant 1 stays checkable.

**The follow block.** For `while`/`for`/`doWhile` it is the test's
out-of-body successor. For `forever` it is the earliest exit target that lies
*after* the whole loop body in bytecode order. Picking the earliest exit by
reverse postorder — which is what this replaces — picks the `ReThrow` of an
`await` desugaring sitting at an offset inside the body, and then the loop's
own body ends up after its follow. On `async-await-in-loop` the exit set is
`{B13, B17}`: B13 is that `ReThrow` at offset 80, inside the body's span, and
B17 at 97 is the real exit.

`for-in` and `for-of` are **annotations, not region kinds** — see Known gaps.

---

## 5. `try` / `catch` / `finally`

The hard constraint first (ARCHITECTURE.md §9.1 / §11.2 constraint 3). Of
25 189 corpus handler ranges:

| prediction | count | share | meaning |
|---|---:|---:|---|
| ASYNC_AWAIT | 13 713 | 54.4% | the `await` desugaring — **not** a source `try` |
| CAUGHT | 5 821 | 23.1% | a real `catch` |
| UNCAUGHT | 5 655 | 22.5% | `finally` only |

Two thirds of all handler ranges correspond to no source-level `try`.
Emitting one per range would invent 13 713 of them. The ASYNC_AWAIT and
UNCAUGHT_ASYNC_AWAIT ranges go into `removed.asyncHandlerRanges` for T7's
`await` pattern, and so do the blocks only their handler can reach — the
implicit promise rejection tail, which the `async` keyword itself implies.
Those blocks have no normal predecessor, so if they were neither placed nor
removed they would simply vanish from the coverage invariant.

The region arithmetic for a range `h`:

```
tryBlocks     = { b : h.rangeStart <= b.startOffset < h.rangeEnd }
                u the normal-completion tail (below)
handlerBlocks = reach(handlerBlock, stopping at tryBlocks)
                minus everything tryBlocks reaches without the handler
                minus everything at or past the end of the range the
                      handler itself sits in
exits         = successors of tryBlocks u handlerBlocks in neither
```

Three parts of that were wrong in the first implementation and each failed
differently:

* **The normal-completion tail.** V8 ends a protected range *before* the code
  that runs when the body completes normally. For `for (const x of xs) {}` the
  range covers the loop and the iterator-close-on-normal-exit sits between the
  range end and the handler. That block belongs to the `try` block lexically —
  it runs on the normal path and not after the handler — so with the range as
  the region bound the body chain walked straight out of its own region.
  Taking the tail in makes the join after the construct the single exit, which
  is what the follow must be. Only blocks that **cannot raise** are taken in:
  `facts.canThrow` is exactly `src/ir/cfg.mjs`'s own test for where an
  exception edge leaves from, so "no exception edge *and* cannot throw" is one
  statement rather than two halves. A block that could throw would be caught
  by this `try` if it were moved inside it, and that is a different program.
* **The subtraction has to start from the range's own blocks, not from the
  function entry.** When the body cannot fall through at all — `try { throw
  new Error() }` — nothing is reachable from the entry past the throw, the
  subtraction removes nothing, and the handler region swallows the rest of the
  function. That is `try-nested`, four `try`s deep, where the innermost
  handler's region came out as 20 of the function's 27 blocks.
* **Reachability from the handler must stop at the range.** A `try` inside a
  loop has a path handler → … → loop header → back into the range, so plain
  reachability from the handler covers the whole loop and rejects every tail
  candidate. Measured on `b_357background.jsc` #11994, where it left both of
  the function's loops unstructured.

### `finally`

ARCHITECTURE.md §4.4.5 says `finally` is "a token register plus a trailing
`SwitchOnSmiNoFeedback` dispatch". That is half true, and the half it misses is
the common one:

```cpp
if (deferred_.size() == 1) {
  builder()->LoadLiteral(Smi::FromInt(entry.token))
            .CompareReference(token_register_)
            .JumpIfFalse(ToBooleanMode::kAlreadyBoolean, &fall_through);
} else {
  BytecodeJumpTable* jump_table = builder()->AllocateJumpTable(deferred_.size(), 0);
  builder()->LoadAccumulatorWithRegister(token_register_)
            .SwitchOnSmiNoFeedback(jump_table).Jump(&fall_through);
}
        // BytecodeGenerator::ControlScope::DeferredCommands::ApplyDeferredCommands
```

With exactly one deferred command — a single `return` inside the `try`, which
is the ordinary case — there is no jump table at all, only
`TestReferenceEqual` on the token register. Both forms are recognised; the
corpus distribution is in §8.

What is done with the recognition is deliberately conservative: the range is
still emitted as a `try` whose handler is the token-setting region, which is
literally what the bytecode does and is correct JavaScript, and the recognised
shape travels as `finallyShape` so T9 can render a real `finally`. See Known
gaps.

---

## 6. `switch`

ARCHITECTURE.md §9.3, measured: the corpus has 11 208 jump tables and only
**1 140** of them belong to a `switch` statement — the other 10 068 are
generator resume dispatchers. 0.35% of functions have a real table. V8 emits
one only for a dense-enough run of Smi cases; everything else becomes a chain
of `TestEqualStrict`. **The compare chain is the main form**, so §4.4.4's "also
recognise the if-else chain" is the wrong way round.

The two are told apart by *derivation, not by name*: the resume dispatcher is
the one switch opcode whose interpreter handler also installs a context
(`SetContext(generator.context)`), and `cfgFacts` asserts there is exactly one
such opcode (IR.md §3).

The compare chain, from a real listing of
`switch (x) { case 1: …; case 1000: …; case 1000000: … }`:

```
B0  LdaSmi [1]        TestEqualStrict r_a0, [0]   Mov r_a0, r0   JumpIfTrue -> B4
B1  LdaSmi [1000]     TestEqualStrict r0, [0]                    JumpIfTrue -> B5
B2  LdaSmi [1000000]  TestEqualStrict r0, [0]                    JumpIfTrue -> B6
B3  Jump -> default
```

Two things that listing settles. The case value is in the **accumulator** and
the discriminant is the **register** operand, not the other way round. And the
discriminant is not the same SSA value in every link — link 0 tests the
parameter and links 1..n test a `Mov` of it — so links are matched on the
discriminant *up to pure register copies*.

That is also what tells a `switch` apart from an `if`/`else if` chain on the
same variable, which is otherwise indistinguishable:

```
switch:  JumpIfTrue -> the case body,  fall through to the next test
if-else: JumpIfFalse -> the next test, fall through into the body
```

In a `switch` every comparison is emitted before every body. The detector
requires the `JumpIfTrue` direction, so an `if` chain stays an `if` chain.

V8 guards a jump table with a run of `if`s — `typeof x === 'number'`,
`x >= min`, `x <= max` — every one of which branches to the default path.
They come out as ordinary `if` regions wrapped around the `switch`, which is
correct and redundant; `guardBlocks` names them so T9 can drop them.

---

## 7. `break`, `continue`, labels, and the one thing `Test` cannot say

An edge that leaves the region being built is one of five things, tried
innermost-first so the minimal correct statement comes out:

| the edge goes to | the statement |
|---|---|
| the chain's own fall-out | nothing: control gets there by falling off the end |
| an enclosing loop's continue target | `continue`, labelled when it is not the innermost loop |
| an enclosing breakable's break target | `break`, labelled when it is not the innermost loop or `switch` |
| an enclosing chain's fall-out | `break <label>`, with that chain wrapped in `{r:'labeled'}` |
| **a join an enclosing chain has not reached yet** | `break <label>`, with everything from the current statement up to that join wrapped in `{r:'labeled'}` |

The last row is the short-circuit condition, and it was the single most common
shape in the corpus that the first four rules cannot express. From a real
listing (`b_346background.jsc` #231):

```
B2  ... JumpIfToBooleanFalse -> B4     // if (!y) goto B4
B3  ... JumpIfToBooleanFalse -> B5     // if (!z) goto B5, else B4
B4  ... Jump -> B6
B5  ...                                // falls into B6
B6  Return
```

i.e. `if (y && !z) { B5 } else { B4 }`. B4 is the `else` body *and* an
immediate-dominator child of B2 with two in-edges, so it satisfies Cifuentes'
follow rule and is picked as the follow — after which the B5 side has to reach
B6, which lies past that follow. No nesting of `if`/`else` expresses this
without either a compound condition, which §11.2's `Test` cannot carry because
it is one SSA value, or emitting a block twice, which §11.3 invariant 1
forbids. A labelled block expresses it exactly, and both halves are already in
§11.2's vocabulary:

```js
L: { B2; if (y && !z) { B5; break L; } B4; }
B6
```

Over four corpus files this one rule took the fall-back rate from **4.44% of
functions to 0.45%**, and with the two refinements below to 0.00%.

Three things keep it honest:

* **One owner per join.** Picking the innermost eligible chain independently
  on every jump gives two chains a request for the same block when the frame
  stacks differ, and only one of them can wrap it. The first claim is binding:
  a later jump either reuses that label or declines, and any other chain that
  arrives at a claimed join breaks to the same label instead of emitting the
  block.
* **A chain may only claim a join it can reach.** A chain stops at its
  fall-out, and emission order is source order, so "ends before it" is
  `offset(target) >= offset(fallOut)`. Without this the innermost chain claims
  a target it is about to walk away from.
* **A chain does not end while it owes a join.** When every path into the join
  left through its `break`, control reaches the join by falling off the end of
  the labelled block, so the chain resumes *at* the join — which is also what
  makes the label end in exactly the right place. A request that is still
  unsatisfied when the chain really ends fails the function into the fall-back
  (`labelledJoinNeverReached`) rather than emitting a `break` to a label that
  ends somewhere else.

Labels live in their own namespace in JavaScript, so a label can never collide
with a variable; the name is derived from block ids so it is stable across
runs, which O2 (the round-trip fixpoint) requires.

### Why every block is emitted exactly once

One counter per block: `pending[b]` is how many of its structuring-graph
predecessors have not been emitted yet, back edges excluded (a loop header's
latch edge belongs to the loop construct, so counting it would stop the header
from ever becoming ready). A block is emitted only when its counter reaches
zero; arriving at a block whose counter is still positive ends the current
chain and hands the block to the ancestor that owns it, which is exactly the
follow relation. So a block can neither be emitted twice — the first emission
sets a flag and the invariant check would catch a second — nor be skipped: if
it is reachable, all its predecessors are eventually emitted and it becomes
ready.

One correction to that, found by measurement: the body of a `forever` loop
begins at the header, which is also the loop's own continue target, so the
first step of the body chain resolved it as `continue` and the body came out
as that single statement with every block of the loop unplaced. The body chain
is therefore marked "this chain exists in order to emit its start", per chain
and never inherited — a nested `if (x) continue;` inside the same body still
has to resolve to `continue`.

---

## 8. Corpus measurements

See **[`scratch/t8/STRUCTURE_CORPUS.md`](../scratch/t8/STRUCTURE_CORPUS.md)**
for the full report, and `scratch/t8/SELFTEST.md` for the self-test table.

**The scan over all 1 039 files is not finished.** The host is 4 GB and two
cores, and T7's own corpus scan was running at the same time; with both jobs
on the machine there was 128 MB of physical memory free and throughput fell to
about one file every 100 seconds. The run is resumable — a file whose result
JSON exists is skipped — so it can be finished with

```
node tools/structure/corpus_scan.mjs --jobs 2 --work scratch/t8/corpus \
     --out scratch/t8/STRUCTURE_CORPUS.md
node tools/structure/corpus_scan.mjs --merge-only --work scratch/t8/corpus \
     --out scratch/t8/STRUCTURE_CORPUS.md     # report what exists so far
```

Two measurements are reported below instead of one. The first is the scan as
far as it got; the second is the five largest and most complex corpus files,
chosen because every fall-back pattern found so far came from them, so it is
the adversarial sample rather than the average one.

### Scan, 82 of 1 039 files

| metric | expected (full corpus) | measured |
|---|---:|---:|
| files | 1039 | **82** |
| functions (SFI with bytecode) | 239 979 | 15 755 |
| functions structured, none threw | all | 15 755 (100%) |
| **§11.3 invariant 1 — coverage violations** | **0** | **0** |
| violations of any invariant in `verify.mjs` | 0 | 0 |
| **metric 1 — T6 back edges whose target is a loop region header** | 100% | 619 / 638 = **97.02%** |
| reachable `JumpLoop` edges that became a loop statement | | 635 / 658 = 96.50% |
| **metric 2 — CAUGHT + UNCAUGHT ranges that became a `try`** | 100% | 749 / 767 = **97.65%** |
| **ASYNC_AWAIT ranges that became a `try`** | **0** | **0** of 1 000 |
| async ranges found in `tryPlans` (independent check) | 0 | 0 |
| `SwitchOnGeneratorState` dispatchers | 10 068 | 705 |
| **dispatcher blocks removed** | all | 705 (100%) |
| dispatcher blocks kept (reported, not silent) | 0 | 0 |
| resume edges that could not be spliced | 0 | 0 |
| **irreducible edges after removal** | **0** | **0** |
| **functions irreducible after removal** | **0** | **0** |
| real `SwitchOnSmiNoFeedback` jump tables structured | 1 140 | 96 |
| compare-chain switches found | | 193 |
| **single-block functions emitted as one `{r:'block'}`** | 100% | 9 270 / 9 270 = **100%** |
| single-block share of the sample | 55.13% | 58.84% |
| **`unstructured` regions** | report | **17** |
| functions that fell back | report | 17 = **0.108%** |
| child CPU | | 2 888 s |

| distribution | measured |
|---|---|
| loop regions by form | `for` 278 (43.8%), `while` 187 (29.4%), `forever` 180 (28.3%), `doWhile` 12 (1.9%) |
| where the loop test sits | header 541, **below the header on the test chain 10** (39 blocks on a multi-block chain), chain rejected → `forever` 5, header holds a statement → `doWhile`/`forever` 69 |
| follow taken as the first exit after the body span | 198, all of them multi-exit loops |
| handler ranges by prediction | ASYNC_AWAIT 1 000 (56.6%), CAUGHT 523 (29.6%), UNCAUGHT 244 (13.8%) |
| `finally` token dispatch shapes | `referenceEqual` 101, `switch` 33 — §4.4.5 describes only the second |
| `switch` regions by form | compareChain 192, jumpTable 92 |
| **fall-backs by `why`** | `stepIntoEmittedBlock` 12, `labelledJoinNeverReached` 5 |

### The five largest files, 33 550 functions

`b_544background.jsc`, `b_86background.jsc`, `b_background_ex.jsc`,
`b_nodeXpluginbackground.jsc`, `b_background.jsc`.

| metric | measured |
|---|---:|
| functions structured, none threw | 33 550 (100%) |
| metric 1 — back edges that became a loop statement | 2 153 / 2 208 = **97.51%** |
| metric 2 — CAUGHT + UNCAUGHT ranges that became a `try` | 2 785 / 2 855 = **97.55%** |
| ASYNC_AWAIT ranges that became a `try` | **0** of 3 209 |
| dispatchers removed | 2 216 / 2 216 |
| irreducible edges before → after removal | **39 → 0** |
| single-block functions emitted as one `{r:'block'}` | 17 775 / 17 775 = 100% |
| functions that fell back | 53 = **0.158%** |
| fall-backs by `why` | `stepIntoEmittedBlock` 35, `labelledJoinNeverReached` 17, `stepOutsideRegion` 1 |

### What the fall-back rate was, in order

Each number is the share of functions that took the whole-function
`unstructured` fall-back, on the four-file sample the work was debugged
against, and then on the hardest five.

| after | four files (1 554 functions) | hardest five (33 550) |
|---|---:|---:|
| the session's starting state | 4.44% | — |
| the labelled-join rule (§7) | 0.45% | — |
| one owner per join, and the multi-exit loop exit | 0.26% | — |
| the `try` fixpoint (§1) | 0.06% | — |
| reachability from the handler stopping at the range (§5) | **0.00%** | 0.36% |
| the `finally` token jump table planned rather than declined | — | 0.16% |
| a chain that falls out while owing a join | — | **0.158%** |

The residual is two shapes, both reported and counted:
`stepIntoEmittedBlock` (a jump to a block some sibling region has already
emitted, which needs either duplication or a goto) and
`labelledJoinNeverReached` (a labelled-join claim whose owner chain never
reached the join, so the label would end in the wrong place and the function
falls back instead).

### Metric 2's denominator

ARCHITECTURE.md §9.1 warns that the baseline's `0 / 667` counts **exception
opcodes**, not handler ranges. Both numbers are in the report: the range count
by prediction, and the `try` count by prediction. The ASYNC_AWAIT row is the
one that has to be zero, and it is asserted twice — once by
`src/structure/verify.mjs` and once in the corpus worker against
`sf.tryPlans`, so the corpus number does not come from the same code path that
is supposed to guarantee it.


### How the corpus scan runs

One **child process per file**. The host has 4 GB and about two cores: a
long-lived process accumulates fragmentation it never gives back, a forked
child returns its memory on exit, and a pathological file can be killed on a
timeout instead of taking the whole run with it. Results go to one JSON per
file, so the run is resumable and nothing goes through a pipe. Nothing from the
corpus is executed.

```
node tools/structure/corpus_scan.mjs --jobs 2
node tools/structure/selftest.mjs
```

---

## 9. Known gaps

Everything here is reported by the tooling, never papered over.

1. **`for-in` and `for-of` are annotations, not region kinds.** §11.2 has
   `{r:'forIn'}` and `{r:'forOf'}`; this layer does not emit them. Their head
   instructions (`ForInEnumerate`/`ForInPrepare`/`ForInNext`/`ForInStep`, or
   `GetIterator` plus the `next`/`done` protocol) straddle block boundaries
   that a `{r:'block'}` leaf cannot split, so emitting `{r:'forIn'}` would
   drop whatever else lives in those blocks. The loop is emitted as an
   ordinary loop, every block is still placed exactly once, and `loop.idiom`
   carries the recognition for T7/T9. The `for-of` recognition is labelled
   `confidence: 'shape'` — T7's `forOf` pattern is authoritative and nothing
   structural depends on T8's guess.
2. **`finalizer` is always `null`.** The `finally` body lives *inside* blocks
   that also carry the token stores and the `return` value computation, and a
   `{r:'block'}` leaf cannot be split, so emitting `finalizer` directly would
   drop those stores. The range is emitted as a `try` whose handler is the
   token-setting region — what the bytecode literally does — with
   `finallyShape` alongside it for T9. A `finally` whose token dispatch is
   *not* recognised still comes out correct, just as a `catch`-shaped region.
3. **`init` is always `null`** on a `for` region, for the same
   can't-split-a-block reason (§4).
4. **The fall-back is whole-function, not per-region.** A partial tree with an
   `unstructured` tail would need `__pc` live across the boundary between
   structured and unstructured code. Covering the whole function keeps `__pc`
   local to the dispatch and keeps invariant 1 trivially checkable. It costs
   structure on a function that fails; the measured cost is in §8.
5. **A block kept out of the coverage invariant is kept out by name.**
   `removed` carries three kinds — `generatorDispatchers` (the block holds
   exactly the dispatch instruction, or it is kept and reported),
   `asyncHandlerBlocks` (the implicit promise rejection tail) and
   `loopTestBlocks` (gated on §4.3's inlining condition). Each is a claim that
   T7 produces no statement for that block, and T9 is the place that can check
   it: §11.3 invariant 3.
6. **Guard blocks in front of a jump table are emitted as `if`s.** Correct and
   redundant; `guardBlocks` names them and T9 may drop them.
7. **A compare-chain `switch` whose links hold side effects** is still read as
   a `switch`, with `pure: false` recorded on the plan. V8 only emits the
   chain for a source-level `switch`, so the shape is not ambiguous, but the
   link blocks' statements are then dropped by the `switch` region the same
   way a loop test chain's are — unlike the loop case this is **not** gated,
   and the count of impure chains is reported as `compareChainImpure`.
8. **No region is ever duplicated to avoid a label.** Where a decompiler could
   emit a block twice to get a prettier nesting, this layer emits a labelled
   block instead. That is a deliberate trade against §11.3 invariant 1, and it
   means output can contain labels a human would not have written.
9. **`stepIntoEmittedBlock` — the residual fall-back, 0.10% of functions.** A
   jump whose target a sibling region has already emitted. In a reducible
   graph that is a jump backwards into another branch's text, and expressing
   it needs either the block twice or a `goto`; neither is available, so the
   function takes the fall-back and is counted. This is now the largest single
   fall-back cause and the obvious next piece of work.
10. **`labelledJoinNeverReached` — 0.05% of functions.** The labelled-join
    rule claimed a join on a chain that then never reached it. Three
    refinements (§7) each cut this; what is left is claims whose owner is
    chosen correctly by offset but whose chain still exits through a construct
    that swallows the path to the join. Failing into the fall-back is the
    honest outcome: emitting the `break` anyway would put the label's end in
    the wrong place, which is silently wrong.
11. **An empty handler range still carries an exception edge** — a finding for
    `src/ir/`, not a gap here. In `b_86background.jsc` #58726 `setHtmlIcon`,
    handler 1 decodes as `[166,166) -> @168`, prediction CAUGHT.
    `src/ir/cfg.mjs` warns `handlerRangeEmpty` for it and its own
    `lookupHandlerIndexForRange` cannot match a range whose start equals its
    end (`pc >= rangeEnd` skips it), yet the block at offset 166 carries an
    exception edge to that handler's block — so the catch body is reachable
    by the IR's own reckoning while no `try` construct can own it. Either the
    edge or the decoded `rangeEnd` is wrong. T8 cannot place those blocks and
    takes the whole-function fall-back with `why: 'blocksNotPlaced'` rather
    than dropping them.
