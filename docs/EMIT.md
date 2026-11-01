# `src/emit/` — Stage E: the control tree and the expressions become JavaScript

T9 of wave W3, and the first stage whose output is text. Inputs: the
`RecoveredFunction` of [ARCHITECTURE.md §11.1](ARCHITECTURE.md) (T7,
[RECOVER.md](RECOVER.md)) and the `StructuredFunction` of §11.2 (T8,
[STRUCTURE.md](STRUCTURE.md)). Output: §11.4, which is what the three oracles
and the metrics dashboard already consume.

```js
import { emit } from './src/emit/index.mjs';
import { decompile } from './src/emit/decompile.mjs';

emit(recovered, structured, opts);   // the two arrays for one .jsc, same order
decompile('extracted_jsc/x.jsc');    // -> { code, map, ast, perFunction, report }
```

```
src/emit/
  index.mjs      emit() -- the unit tree, the per-function context, the report
  decompile.mjs  the §11.4 entry point: load -> ir -> recover -> structure -> emit
  expr.mjs       T7's Expr  -> @babel/types, and Test -> a condition
  stmt.mjs       T7's Stmt  -> @babel/types, and the source position
  region.mjs     T8's Region -> @babel/types, and the join of the two
  names.mjs      SSA destruction with naming: declarations, scoping, collisions
  scopes.mjs     which function owns each context frame, so a closure variable
                 is declared once and shared -- and refused when it cannot be
  fallback.mjs   §4.4.7's `while (true) switch (__pc)`
  holes.mjs      how a hole is rendered, and counted
  sourcemap.mjs  source positions -> a source map, and §3.5's monotonicity check
  verify.mjs     §11.3's six invariants, asserted per function
tools/emit/
  selftest.mjs      73 checks, both profiles, no engine and no corpus
  corpus_scan.mjs   one forked child per file, capped heap, results to files
  corpus_worker.mjs
```

Layering (§11.0): this directory imports `src/ir`, `src/structure`,
`src/recover` and `src/load`, plus `@babel/types` and `@babel/generator`. It
imports nothing from `src/verify/` or `tools/`, and it holds **no version
literal** — every version-specific decision was already made upstream, which
is what makes the emitter version-independent rather than accidentally
compatible. `tools/emit/selftest.mjs` group A fails if any of that stops being
true, and `.github/workflows/selftest.yml` greps for the same thing on every
push.

The output is a real `@babel/types` AST printed by `@babel/generator`; nothing
in `src/emit/` concatenates a string of JavaScript. ARCHITECTURE.md §5 retired
output parseability as a *progress* metric — it was 100% while the output was
nonsense — so parseability here is a precondition, checked because nothing else
can be measured without it, and not reported as an achievement.

---

## 1. The join, in one page

T8 says *which block* and *which SSA value*; T7 says *what that value is*.
`region.mjs` is the only place the two meet.

| T8 says | T9 does | T7 supplies |
|---|---|---|
| `{r:'block', id}` | emit `recovered.stmts.get(id)`, in order, exactly once | the statements |
| `Test` on an `if`/`loop`/`switch` | `expr.mjs::testExpr` resolves `Test.value` through `recovered.exprs` and reads `predicate` and `toBoolean` | the expression |
| `Target` on a `try` param | `recovered.exprs` as a binding pattern | the name |
| `label` on a region | a `LabeledStatement`, name sanitised | — |
| `{r:'unstructured'}` | `fallback.mjs` | the statements of each block |

Three things about `Test` are load-bearing and were not in §11.2's three
fields.

**`predicate` is not decoration.** `JumpIfUndefinedOrNull` branches on
`value == null`, not on `value`; `JumpIfJSReceiver` branches on "is an object
or a function". Rendering `if (value)` for either inverts the condition on
every nullish value, which is the silent-wrongness §7 forbids. T8's table
(`src/structure/facts.mjs`) is asserted total over every conditional jump of
every profile, so `testExpr` has one branch per kind and the self-test checks
that the set is covered rather than assumed.

**`toBoolean` only matters in a value position.** In a condition JavaScript
applies ToBoolean itself, so `JumpIfToBooleanFalse` with `negate` is `!x` and
without it is plain `x`. `testValueExpr` is the one that adds `!!`.

**A predicate that reads no accumulator carries `values`, not `value`.**
`ForInContinue index, cacheLength` is the only such case (`onValue: false`),
and it renders as `index === cacheLength`.

### Evaluating nothing twice (§11.3 invariant 4) is checked on the output

T7 memoises one `Expr` **object** per SSA value (RECOVER.md §2.2). `expr.mjs`
counts every T7 object it reaches, so "the same object reached twice" is
exactly "that value was emitted twice". Because a pattern can deliberately
alias several values onto one object, a second visit is a violation only when
*none* of the values mapping to it is in `recovered.duplicable`. That is T7's
own detector, re-run on what T9 actually emitted rather than taken on trust.

One construct needs its operand three times: `JumpIfJSReceiver`. The operand
goes into a declared scratch variable first —
`(__t$0 = v, typeof __t$0 === 'object' && __t$0 !== null || typeof __t$0 === 'function')`
— so the value is evaluated once and the repetition is on a name, which
re-evaluates nothing. The self-test asserts exactly two `typeof` occurrences
for that shape.

---

## 2. Functions are emitted nested, and that is a correctness decision

Each unit becomes one function, placed inside the unit that encloses it, and
`{e:'fn', sfiId}` emits a reference to that nested declaration's name.

The flat alternative — every unit a top-level function — is simpler and wrong.
`LdaContextSlot depth 1` is a read of the **enclosing** function's variable,
and T7 resolves it to that variable's real ScopeInfo name. Emitted flat, the
name is free, so every closure variable becomes an undeclared global; emitted
nested, the enclosing function's declaration is in scope and the closure is
intact. `names.mjs` rule 3 is the other half of the same decision.

**The top-level unit is the exception**: its body is the *file's* top level,
not a function. A `.jsc` top-level unit **is** the script, so wrapping it would
add a frame V8 never compiled, and O1 compares our text's script function
against the original's. A `{s:'return'}` at that level is a `SyntaxError`, so
it becomes the expression on its own line, marked and counted
(`topLevelReturns`) — V8 compiles a script to a function returning the
completion value, so the expression statement compiles back to the same
`Return`.

### Where the nesting comes from, and why `parentSfiId` is not enough

`src/heap` fills in `unit.parentSfiId` from the **constant pool**: a
`{t:'sfi'}` entry is a `CreateClosure` target. Measured: that does not cover a
top-level function *declaration*. `tests/t8/fixtures/loop-while.jsc`'s script
unit has constants `[array, string, string, string, string]` and no `sfi`
entry at all, because V8 hoists declarations through `DeclareGlobals`, whose
operand is a FixedArray of (name, slot, SFI) triples that `src/heap` renders as
one `{t:'array'}`. All three units of that file arrive with
`parentSfiId: null` and `children: []`.

So the tree is built by **source-range containment** —
`[startPosition, endPosition)` comes from the parser, and a function literal's
range is strictly inside its enclosing literal's — and `parentSfiId` is used
to confirm it. A unit with no usable range (an assembled test unit is `0..0`)
stays a root rather than being guessed into someone's body. The report carries
`unitTree.{byRange, byParentSfiId, disagreed}`.

Two units are emitted **inline** rather than as a sibling declaration, because
`super` is only legal there: the constructor a `{e:'class'}` names, and an
object literal's accessor or method. `claimed` keeps them from also being
emitted as a sibling. Anything still unemitted at the end — a broken parent
link — goes to the top level with an `ORPHAN` marker, so §11.5's "every
function enters the output" cannot be lost to a tree edge.

Arrows are emitted as `var name = (params) => { ... }` in the parent's
prologue: a declaration cannot be an arrow, and a `function` would rebind
`this`. Hoisting the literal is safe (creating an arrow has no effect) and is
marked.

---

## 3. Naming and SSA destruction (§4.5)

T7 already decided every *name* (RECOVER.md §4): one per context-slot
location, one per materialised value, one per phi, parameters from the
ScopeInfo, and `__ctx_d<d>_i<i>` with its `ctx[d][i]` comment for a slot it
could not resolve. What is left for this layer is **where each name is
declared** and **which names must be renamed** so that two storage locations
do not end up spelled the same way in one function.

The one thing T7 does *not* decide, and the one this layer got wrong for a
whole measurement cycle, is that a context slot is not a name at all: it is
**storage belonging to a particular scope**, shared by every function nested
inside that scope. Rule 3 below is where that lives.

### Rule 1 — every local is declared once, at the top of the function body

T7's `declarations[]` carries `scope: blockId|'function'`, where a block id is
the block the value is defined in. Declaring there is wrong for a phi:
`loop-while.jsc` #15 `f` gives phi 8 `scope: 1` (the loop header) while its
predecessor copies are emitted in blocks 0 and 2, so a declaration in block 1
is both after the first write and inside a narrower block than the reads. One
`let` list at the top of the body is the only placement that dominates every
copy — which is what SSA destruction needs. `{s:'decl'}` therefore emits the
**initialiser as an assignment** and not a second declaration; the declaration
moves, the initialiser does not.

There is one exception, and it is the opposite move: a **context binding**
whose single store is proved to dominate and lexically enclose every read is
declared *at that store*, with the initialiser, because that is the only shape
V8 compiles back to an immutable slot read. The proof, the seven clauses it
rests on and the residue by reason are §9.11; `src/emit/declsite.mjs` is where
it lives. Rule 1's own subject — a register-allocated local — is unaffected:
its declaration still hoists.

The list over-declares rather than leave a name free: every non-global,
non-parameter, **non-slot** spelling a statement mentions gets a declaration
even when T7's `declarations[]` has no row for it. An unused `let` is ugly; an
undeclared read is §11.3 invariant 5.

"Local" here means a register-allocated value — a temp, a phi, a caught
exception, a hole, a scratch variable. A **context slot is not a local**, and
putting it in this list is the defect O1.md §6.5 measured; rule 3 owns it.

### Rule 2 — a temp whose spelling another storage class owns is renamed

Measured on `loop-while.jsc` unit 0. T7's `inferBase` names the result of
`LdaGlobal 'T'` after the global it loaded (RECOVER.md §4.1), and the statement
it emits is

```js
{s:'decl', id: name T (temp), init: name T (global)}
```

which prints as `let T = T` — a TDZ `ReferenceError` as `let`, and an
assignment of `undefined` to itself as `var`. Nothing in T7 is wrong: its
taken set seeds ScopeInfo names and parameters, not the globals a function
reads. The two storage classes can only be told apart here, where both `ref.k`
values are visible on the same name.

Priority is **param > contextSlot > global > temp**: a real source name keeps
its spelling, a global cannot be renamed at all, and the synthetic copy is
suffixed `$t`. A declaration's class comes from T7's own row (`contextSlot`
present, or `origin: 'scopeInfo'`) — classifying every row as a temp made the
`__ctx_d0_i2` placeholder look like a temp *and* a slot and renamed it against
itself.

The one case where a **parameter** is renamed instead of a temp: a parameter
may not shadow a context binding an enclosing function declares, because the
body may read that binding. T7 spells parameters `p0..pN`, so this only fires
when a ScopeInfo variable is literally called `p0`; the parameter is positional
and its name is ours to choose, so it is the one that moves. Counted as
`paramsRenamedForABinding`.

### Rule 3 — a context slot is storage belonging to a scope, not a name

`src/emit/scopes.mjs`, and the correctness decision §2's nesting exists for:

> A context slot is declared **exactly once**, in the emitted function that
> owns the context frame it lives in, and every other function that reads or
> writes it resolves to that one binding through lexical scope.

#### What the rule used to say, and why it was wrong

It asked `depth > 0` — the bytecode operand — and declared the slot locally
otherwise. That is the wrong question. The operand counts `PREVIOUS_INDEX`
hops from whatever the frame's context register holds, and a function that
allocates no context of its own never pushes one, so for such a function
`LdaImmutableCurrentContextSlot [8]` at depth **0** is already a read of the
*enclosing* function's variable. ARCHITECTURE.md §10.3 states exactly this and
calls it the worst failure mode; `src/ir/context.mjs` measured it on a real
listing. So the ordinary capture is depth 0, rule 3 never fired for it, and
every inner function declared its own `undefined` copy of the variable it was
supposed to capture. That is O1.md §6.5: 0 context operations in the output
against the original's 4 `CreateFunctionContext`, 10 `PushContext`, 64
`StaCurrentContextSlotNoCell` and 299 immutable slot loads, and 594
`LdaUndefined` against 38.

`outerSlotDeclaredLocally` therefore counted the rare deep read (367 over 465
files) and not the common one. Measured over 61 corpus files, 8 882 units and
27 891 slot references: **13 556 `incoming` + 2 592 `outerScope` references
belong to an enclosing function**, against 11 249 the reading function owns.

#### The question that is actually asked

Does *this* function's prologue create the frame? `ir.contextChain.frames`
answers it per frame, as a fact rather than an inference:

| `frame.kind` | meaning | owner |
|---|---|---|
| `created` | this function built it — `Create{Function,Block,Catch,Eval,With,FunctionWithCells}Context` | this function |
| `incoming` | the context the closure was entered with, `unit.scope.outer` | an enclosing function |
| `outerScope` | one or more `PREVIOUS_INDEX` hops above that | an enclosing function |

For the two enclosing kinds the owner is the function whose `created` frame
carries the same `scopeInfoId`. A ScopeInfo is a heap object and `src/heap`
gives it one id per cache graph, so that id is the frame's file-wide identity —
the same number on the creating side (a constant-pool operand of the
`Create*Context`) and on the reading side (`unit.scope.outer.scopeInfoId`).
Measured: **16 148 of 16 148** enclosing-frame references resolve to an emitted
ancestor this way, 0 of 1 805 `created` frames lacked a `scopeInfoId`, and no
two functions claimed one frame.

The owner declares every binding its descendants read, including ones its own
body never mentions — a catch context's slot is written by the
context-creating instruction and so has no store op in the owner at all — which
is why the plan is computed for the whole file before any body is built.

#### Spellings come from the binding, not from T7

T7 names every slot per function off its own `taken` set, so two functions can
spell one slot differently — measured, 9 bindings over the 61 files — and a
closure that resolves `x` in one function and `x$2` in another is not a
closure. The owner allocates the spelling once and every reader reads it from
the table. The allocation avoids, file-wide, every parameter name, every global
any function reads, every emitted function name and this layer's own internal
names, and on the current path every binding an ancestor already declared;
collisions take a `$s<n>` suffix.

This used to say that none of it is visible to O1, because a context slot is
an index in the bytecode and renaming a binding therefore cannot change one
instruction. **That is false**, and §9.11's measurement is what showed it:
`ThrowReferenceErrorIfHole` carries the variable's name as a constant-pool
operand, so every TDZ-guarded read prints the spelling this layer chose, and a
`$s<n>` suffix shows up as a `constant-value` divergence (`K("e")` vs
`K("e$s2")`, 47 hunks on a 16-file set). The slot index is invisible; the name
is not, wherever a hole check can reach the binding.

The declaration keyword is read off the ScopeInfo rather than chosen: a `kVar`
binding is declared `var`, everything else `let`. It matters because V8
initialises a context-allocated `let` and does not initialise a `var` — `let
x;` costs `LdaTheHole; StaCurrentContextSlot` at scope entry plus
`LdaUndefined; StaCurrentContextSlot` for the declaration, and `var x;` costs
nothing. At the file's top level `var` is not available (a top-level `var` is a
property of the global object, not a context slot), so the script unit declares
everything `let`. A `kConst` binding is declared **`const`** when §9.11's proof
holds — the declaration then moves to the binding's single store and carries
the initialiser, which is the only text shape V8 reads back as
`maybe_assigned == kNotAssigned` — and falls back to `let` when it does not,
where it is still **counted** (`constBindingsEmittedAsLet`) because `const x;`
with a separate store is a `SyntaxError` and the fall-back costs the immutable
slot read. The residue is tabulated by reason in §9.11.

#### A binding that cannot be placed refuses the function

The project's standing instruction is that compiler engineering is
deterministic, that every heuristic implementation is to be removed, and that
an error must be thrown explicitly rather than papered over. So there is no
fall-back: a slot this function neither owns nor inherits is **not** declared
locally and **not** left free. The function is refused, with the slot, the
frame, the depth and the reason named — `scopes.mjs::SCOPE_REFUSAL_WHY` has
seven reasons — and the body becomes a counted
`HOLE contextBindingUnplaceable` throw. The prologue still carries the bindings
that function *owns*, so a refusal costs that function and not its
descendants, and §11.5's "every function enters the output" still holds.

Measured cost on the 61 files: **494 of 27 891 references (1.77%) and 51 of
8 882 functions (0.57%)**, all of them T7's frameless `ctx[d][i]` placeholder —
`contextValueNotStaticallyKnown`, where the context register holds different
context objects on different paths into the instruction (IR.md §11), so there
is no single frame and therefore no storage location to place. §4.5's
`/* ctx[d][i] */` placeholder is still emitted for the other case, a slot whose
**frame** is known and whose **name** is not: that binding is real and shared,
so it is declared by its owner under a synthetic name carrying the marker.

### `ctx` (§11.3 invariant 5)

Banned outright. T7 cannot emit it (`BANNED` in RECOVER.md §4.2) and
`names.mjs::sanitise` is the second line of defence, applied to every name
that reaches an `Identifier` node. The invariant is then checked **on the AST**
— every `Identifier` named `ctx` is counted — rather than taken from T7's
measurement of its own output. §4.5 *requires* the `/* ctx[d][i] */` comment on
the placeholder, so the ban is on the identifier and not on the three letters:
the self-test strips comments before looking.

---

## 4. The four constructs §11.2 promises and T8 never emits

STRUCTURE.md §9 lists them with a measured reason for each. Three are rendered
as what the bytecode literally does, with the recognition kept visible and
counted; one had to be rebuilt, because the lowered form is not merely ugly.

### 4.1 `{r:'forIn'}` / `{r:'forOf'}` — rebuilt for `for-in`, lowered for `for-of`

A for-in/for-of arrives as an ordinary `{r:'loop'}` with `idiom` /
`idiomDetail`. For **for-of** the lowered form is complete and correct: on
`loop-for-of.jsc` T8 produces a `forever` loop whose body is the iterator
protocol with `if (done) break`, which terminates and reads correctly. It is
emitted as-is and the annotation is counted.

For **for-in** it is not. Measured on `loop-for-in.jsc` #15 `f`:

```
loopPlan { form:'for', testBlock:2, testValue:NULL, testChain:[2],
           updateBlock:5, idiom:'forIn' }
```

`testValue` is null because the loop's exit test is `ForInContinue`, whose
predicate reads no accumulator, so T8 builds a `for` region with `test: null`.
Block 2, which holds the `ForInNext` that produces the key, is in
`removed.loopTestBlocks`, and T7 emits no statement for it either because its
`forIn` pattern consumed those instructions expecting a `{r:'forIn'}` region to
put them back. The lowered emission is therefore

```js
for (;; v = t$2) { if (key !== undefined) { arr.push(key); } }
```

— an infinite loop over a key nothing assigns. Correct-but-ugly is acceptable;
non-terminating is not. Everything needed is in the annotation T8 attached,
which is why it carries one: `idiomDetail.subject` is the enumerated object and
`idiomDetail.key` is the SSA value of the key, which T7 has materialised under
a name. So the head is rebuilt as `for (key in subject)`, marked, and counted
as `forInRebuilt`; an annotation that cannot be rebuilt (no name for the key,
or no `exprs` entry for the subject) is counted as `forInNotRebuilt` and falls
back to the lowered loop.

V8's own `key !== undefined` filter stays in the body — redundant in a real
`for-in`, and dropping an emitted region is not this layer's call. The update
region stays too, at the end of the body: its `ForInStep` bookkeeping is dead
once the head is real, but §11.3 invariant 3 says a placed block's statements
are emitted exactly once and "dead" is not a licence to drop them.

### 4.2 `finalizer` is always `null`

A `finally` arrives as `{r:'try', form:'finallyToken', finallyShape}` whose
handler **is** the token-setting region. It is emitted as that `try`/`catch` —
what the bytecode does, and correct JavaScript — with the recognition as a
comment and a count:

```js
/* finally: token dispatch referenceEqual, finalizer enters at block 14,
   1 deferred command(s); emitted as the catch the bytecode builds */
try { ... } catch (e$3) { ... }
```

`report.finallyShapes` and `finallyShapeKinds` carry the counts. Lifting the
finalizer out of the handler would drop the token stores and the return-value
computation that live in the same blocks (STRUCTURE.md §9.2), and re-splitting
those blocks is T8's job, not this layer's.

### 4.3 `init` is always `null`

V8 puts the initialiser in the block before the header, which also carries
whatever preceded the loop. That block is emitted as an ordinary leaf before
the loop, which is where it belongs; the `for` is emitted with an empty init
and the count is `loopsWithoutAnInit`.

### 4.4 `{r:'continue'}` is essentially never produced

The branch exists and is correct; its count is reported so "never" stays a
measurement. `label-continue.jsc` shows why: `continue loop` comes back as the
*merge* of the two paths inside the loop body, with the update in the `for`
clause, because V8 gives the loop a dedicated continue target that both paths
fall into. The emitted text has no `continue` keyword and is right.

---

## 5. The hole and the fall-back (§7)

An expression hole is a **declared** placeholder, not `undefined`:

```js
let __hole;
...
/* HOLE unmodelledRuntimeCall @143 CallRuntime */__hole
```

`undefined` is a known global, so a hole spelled that way would make metric 5
(free identifiers that are real globals) read *better* for a hole than for a
recovered name. A hole must also be assignable, because a hole can land in an
assignment target. `__hole` is declared once per function that needs one, so
§11.3 invariant 5's "nothing is free" is kept.

Every hole comment starts with `HOLE `, and every `{r:'unstructured'}` marker
with `UNSTRUCTURED `. Invariant 6 then compares the markers **in the AST**
against the report's own total, so a hole that was counted but not rendered
fails as loudly as one rendered but not counted. (That check found a real bug
in this layer: the `for` update region was emitted, classified as "not an
expression", and emitted again, counting every statement and hole inside it
twice.)

`{r:'unstructured'}` renders §4.4.7's form:

```js
/* UNSTRUCTURED stepIntoEmittedBlock (14 blocks) */
__pc0 = 0;
__region0: while (true) switch (__pc0) {
  case 0: ...; __pc0 = 3; break;
  case 3: ...; __pc0 = cond ? 5 : 7; break;
  ...
  default: break __region0;
}
```

The dispatch value comes from the CFG, not from a guess: one normal successor
is `__pc = s`, a two-way terminator is `__pc = test ? taken : notTaken` with
the test built by T8's own predicate table, and a jump table becomes a nested
`switch`. A block ending in `Return`/`Throw` needs no assignment — its own
statements end it.

---

## 6. §11.3, asserted per function

`src/emit/verify.mjs` runs on every function. Four of the six are statements
about the two input trees; **two are statements about the output**, and the
difference is the point: T7 measured "0 values emitted twice" and "0
occurrences of `ctx`" on what *T7 produced*, so invariants 4 and 5 are checked
on the Babel AST this layer built, where a bug in this layer can still show up.

| | what |
|---|---|
| 1 | every reachable, non-`removed` block appears exactly once. All **five** kinds of `removed` are accounted for: the three naming blocks (`generatorDispatchers`, `asyncHandlerBlocks`, `loopTestBlocks`) are subtracted; `asyncHandlerRanges` must own no `try` (1b); a `skippedHandlerRange`'s handler block must still be covered (1c) — the exact failure STRUCTURE.md §1 describes, where `rangeEntryUnreachable` made three blocks vanish silently |
| 2 | every `Test.value` / `Target.value` has an `exprs` entry; a miss becomes a counted `HOLE joinUnresolved`, never silence |
| 3 | a placed block's statements are emitted exactly once, counted against `recovered.stmts.get(b).length`; **3b** a `removed` block contributed no statement that was *dropped* — the half of invariant 3 only T9 can check (STRUCTURE.md §9.5) |
| 4 | an `ssaId` appears more than once iff it is in `duplicable`, measured on the T7 `Expr` objects this layer reached |
| 5 | no `Identifier` named `ctx` anywhere in the emitted AST |
| 6 | every hole is counted *and* visible: markers in the AST vs the report's total |

Plus one measurement that is **not** one of the six and is reported separately
so it cannot be confused with a number §11.5 says must be zero:

**3c — a local name read without ever being written.** This is how a definition
lost upstream becomes visible. The name is declared, so invariant 5 still
holds and nothing is free, but it reads `undefined` for the rest of the
function. It is the most useful honesty number this layer produces and it is
not zero; §8 has the count and the causes.

---

## 7. The source map

Every `Stmt` carries `pos.sourcePosition` and the unit carries
`startPosition`/`endPosition` — all **character offsets** into the original
source (§8.1, from V8's SourcePositionTable). The source *text* is not
available: a code cache stores a source hash and a length, never the source,
so no offset can be turned into a (line, column) pair.

So the map is emitted in the one coordinate space the input supports: original
line 1, original column = the character offset, `sourcesContent: [null]`, and
`x_v8d_sourcePositionsAreCharacterOffsets: true` so a consumer cannot mistake
column 4821 for a real column. Inventing line numbers by guessing where the
newlines were would be the kind of plausible placeholder §7 forbids.

§3.5(c)'s monotonicity check is run per function over the statements T7 marked
`isStatement`: the emitted order must agree with the source order, and an
inversion means two statements were reordered. It is reported, never used to
reject anything.

---

## 8. The numbers

### 8.1 `tools/emit/selftest.mjs` — engine-free, both profiles

```
node tools/emit/selftest.mjs      ->  76 passed, 0 failed
npm test                          ->  the `emit` slot runs the same 76
```

Groups: 5 layering, 6 closed-set, 10 per profile × 2 profiles = 20 assembled
shapes, 25 fixtures (one named check per source construct, plus the closure
check below), 20 invariant and rendering checks. Over the 24 minted fixtures in
`tests/t8/fixtures/`:

| | |
|---|---:|
| files / functions emitted | 24 / 80 |
| **§11.3 invariant violations (the six)** | **0** |
| **`ctx` as a variable** | **0** |
| holes | 0 |
| parse failures (a precondition) | 0 |
| names declared | 297 |
| names read but never written (check 3c, reported) | 61 |

Three of those checks are about rule 3, and the first is the one that would
have caught §6.5's defect:

* **`loop-for-of-break`: a captured variable is declared once, by the function
  that owns its frame.** The fixture closes over the iterator helper's `i` and
  the outer `closed`, which an inner function assigns. The check counts
  `VariableDeclarator` nodes per name over the whole file and requires exactly
  one for each, requires the inner function's write to be there, and requires
  `contextBindingsInherited ≥ 2`. Before rule 3 was rewritten each inner
  function declared its own copy, so each name had two declarators and the
  write went to a fresh `undefined`.
* **Every context slot of every fixture was placed in a real scope** — 6 slot
  locations owned by the reading function, 2 by an enclosing one, 0
  unplaceable, 0 functions refused.
* **A context slot whose frame has no identity refuses the function instead of
  shadowing it** (per profile). An assembled unit carries no ScopeInfo, so
  nothing can say who owns the frame; the check requires the refusal, the
  named reason, the counted `HOLE contextBindingUnplaceable`, no `__ctx_`
  declaration and `ctx` still absent.

The negative controls matter as much as the zeros: the suite removes an id from
`duplicable` and requires invariant 4 to fire, deletes an `exprs` entry and
requires invariant 2 to fire and a `HOLE joinUnresolved` to appear, injects an
`{e:'hole'}` and an `{s:'hole'}` and requires the marker, the declaration and
the count, and replaces a root with an `{r:'unstructured'}` region and requires
`while (true) switch (__pc` plus the `UNSTRUCTURED` comment. A detector that
always said zero would fail all five.

### 8.2 The oracles

```
V8D_PIPELINE=src/emit/decompile.mjs node src/verify/run_oracles.mjs --selfcheck
->  SELF-CHECK: ALL CHECKS PASSED
```

minter Electron 40 (V8 14.4.258.16), engine `d8` 14.4.258.17, 269 corpus
entries, self-check on 6. O1 identity PASS (6/6 exact), O1 discrimination PASS,
O2 mechanism control PASS, O3 identity PASS (6/6), O3 discrimination PASS, O3
execution policy PASS.

One caveat about the harness, measured twice: under load the O3 trace budget
(8 s) and O1's pipeline budget (90 s) both expire, and the self-check then
reports failures that have nothing to do with the pipeline — O3 identity traces
the same corpus file twice and never calls the decompiler at all. Both runs
above were on an otherwise idle machine. **Nothing else may run while the
oracles do.**

### 8.3 The metrics dashboard

```
V8D_PIPELINE=src/emit/decompile.mjs node tools/metrics/run.mjs --quick --outputs fresh
```

works and writes `docs/METRICS.md`. Three things about what it measures.

**`--outputs fresh` is required for metrics 1, 2, 3 and 10.** The default
(`stored`) reads `decompiled_js/`, which is the retired emitter's archive.
Metrics 5, 7 and 8 have **no** such flag: `tools/metrics/samples.mjs` samples
`decompiled_js/*.js` directly, so those three rows describe the archive no
matter which pipeline is wired in.

**Metric 2's numerator is mis-keyed in the collector.**
`tools/metrics/collect/control_flow.mjs` counts `try` statements into
`ast.tryS` and then reads `sumAst('try')`, which is `undefined`, so metric 2
reports `0 / 356` for any pipeline. The same file's `emitted.try` field reads
the right key. One word; not changed here, because changing the instrument in
the same session that is being measured by it is not a measurement.

**Metric 6's numerator is pinned to the retired emitter's naming.**
`tools/metrics/collect/liveness.mjs` counts distinct matches of
`/\bfunction\s*\*?\s+(main|func_\d+)\b/`, which is how the old emitter named
every function. This emitter uses the SFI's real name, so that regex reads 0
for it. The generic equivalents — `splitFunctions`'s top-level count, and this
layer's own `functionsEmitted / compiledUnits` — are reported in §8.4 instead.

**And a trap worth writing down.** `decompileInChild()` reuses
`<base>.result.json` and `<base>.out.js` and does not delete them before
spawning, so a child that dies leaves the *previous* run's row and text in
place and the collector reads them as current. Measured: a liveness run came
back with rows tagged `pipeline: src/decompiler.js` and output containing
`function func_1`. Clear `scratch/t3/work/metrics-*` before measuring.

Measured on 20 size-stratified `.jsc` with `--outputs fresh`, 16 of which
paired (4 exceeded the 90 s per-file budget):

| metric | baseline | this emitter |
|---|---|---|
| 1 — loop statements per `JumpLoop` back edge | 0 / 167 | **30 / 167 = 17.96%** |
| 2 — `try` per handler range | 0 / 667 exception opcodes | **26 / 356 = 7.30%** (the collector prints `0 / 356`; see above) |
| 3 — `switch` per switch-dispatch opcode | 0 / 160 | **4 / 160 = 2.50%** — the denominator counts generator dispatchers, which T8 correctly removes (§9.3) |
| 10 — regions marked UNSTRUCTURED | marker did not exist | **2** found in the fresh output |
| 5 — free identifiers that are real globals | ~30% | not measurable: the collector samples `decompiled_js/` |
| 7 / 8 — duplicated calls / allocations | 12.93% / 50.27% | same; §8.4 reports this layer's own count |
| 9 — unresolved read-only refs | 0 | 0 (independent of the emitter) |

The emitted side of that sample also carries 20 `while`, 6 `for`, 4 `for-in`,
26 `try`/`catch`, 4 `switch`, 155 `break`, 80 labelled statements and 1145
`if` — against a baseline of 0 loops, 0 `try` and 0 `switch`.

### 8.4 `tools/emit/corpus_scan.mjs`

```
node tools/emit/corpus_scan.mjs --jobs 2 --stride 2 --max-bytes 180000
```

Full report: **[`scratch/t9/EMIT_CORPUS.md`](../scratch/t9/EMIT_CORPUS.md)**
(plus the same data as JSON). One forked child per file, capped heap, one JSON
per file, resumable; nothing from the corpus is ever executed.

**The sample, stated rather than implied.** 465 of the 1039 corpus files: every
second file of at most 176 KB, which excluded the 109 files above that cap. The
cap is not a convenience — on this host (4 GB, about two cores) the multi-MB
bundles cost minutes each and three of them hit the 300 s per-file budget with
no result at all, so excluding them covers far more of the corpus per hour. A
sample with the expensive inputs removed is a different sample, which is why
the generated report prints the cap and the exclusion count. The full 1039-file
number needs the sharded cloud run
(`.github/workflows/corpus-scan.yml` + `tools/ci/shard_corpus.mjs`).

| metric | baseline | measured over 465 files |
|---|---|---:|
| files with a result | — | 465 / 465, 0 threw or were killed |
| input / emitted JavaScript | — | 15.7 MB / 22.5 MB |
| compiled functions (SFI with bytecode) | — | 41 044 |
| **functions emitted** (metric 6) | 38.76% | **41 056 = 100.03%** |
| **§11.3 invariant violations** | 0 required | **171**, all of check 3b (below) |
| **the identifier `ctx` as a variable** (invariant 5) | 1 710 336 | **0** |
| `ctx` as a *property* name (recovered source) | — | 50 |
| **values emitted twice outside `duplicable`** (invariant 4, metric 7) | 12.93% | **0** |
| Test/Target values with no `exprs` entry (invariant 2) | — | **0** |
| holes | — | 612 |
| **`unstructured` regions** (metric 10) | marker did not exist | **92** over 3 241 blocks |
| 1 — loop statements per back edge | 0 / 167 | **1 325 / 1 392 = 95.19%** |
| 2 — `try` per handler range | 0 / 667 opcodes | **1 456 / 4 171 = 34.91%** |
| 3 — `switch` per switch-dispatch opcode | 0 / 160 | **232 / 2 144 = 10.82%** |
| 9 — unresolved constant-pool entries | 0 | **0** |
| 11 — throughput | 4 – 5 975 ms per input KB | 1 376 s child CPU, **3.0 s/file, 83 ms per input KB** |

`try` by prediction: 796 CAUGHT and 414 UNCAUGHT ranges became a `try`, out of
800 CAUGHT, 442 UNCAUGHT and 2 452 ASYNC_AWAIT — **0 ASYNC_AWAIT ranges became
a `try`** (§11.2 constraint 3, asserted here as invariant 1b as well as by T8).

What the join decided, over the same 465 files:

| | |
|---|---:|
| loop regions by form | `forever` 673, `for` 217, `while` 195, `doWhile` 3 (of the 1 325 total; the rest are in files beyond this table's snapshot) |
| `for-in` heads rebuilt from `loop.idiomDetail` (§4.1) | **82**, 0 that could not be rebuilt |
| `try` regions carrying a recognised `finally` token dispatch | 230 (`referenceEqual` 209, `switch` 21) |
| `switch` regions by form | `compareChain` 111, `jumpTable` 42 |
| loops whose test chain carried statements T8 claimed were absent | 37 (80 statements), all emitted inside the loop |
| `catch` bindings reconstructed from an unstored context slot | **198** (319 ambiguous, left alone) |
| statements of a `removed` block with nowhere to go | **683** in 146 blocks: `asyncHandlerBlocks` 644, `loopTestBlocks` 3 |
| script `return` turned into the completion value | 465 |
| locals renamed away from a global/param/slot spelling (§3 rule 2) | 6 999 |
| outer context slots declared locally — the §6.5 defect, before rule 3 was rewritten | 367 (the counter saw only the rare deep read; §3 rule 3) |
| declarations emitted | 290 883 |
| **names read but never written** (check 3c) | **112 266 of 350 607 declared = 32.0%** |
| unresolved context-slot placeholders used | 1 823 |
| statement order monotone with the source position (§3.5) | 38 386 / 41 044 functions, 3 943 inversions |
| unit tree: parent links from the source range / confirmed by `parentSfiId` / disagreeing | 35 359 / 35 488 / **0** |

Holes by reason: `unitNotRecovered` 423, `unstructured:stepIntoEmittedBlock`
87, `frameHeaderRegisterReadAsValue` 35, `arrayBoilerplateElementsNotDecoded`
24, `superOutsideAMethod` 13, `classMembersNotDecoded` 12,
`unstructured:labelledJoinNeverReached` 4, `namedPropertyKeyNotAString` 6,
`namedStoreKeyNotAString` 6, `unstructured:functionChainFellOut` 1,
`runtimeIdNotNamedByProfile` 1.

**The 171 violations are all check 3b**, and 644 of the 683 dropped statements
are `asyncHandlerBlocks` — the implicit promise-rejection tail T8 removes
because the `async` keyword itself implies it, for which T7 nonetheless
produces statements. Each one is rendered as a counted
`DROPPED <n> statement(s) of removed block(s) ...` note at the end of the
function. Checks 1, 1b, 1c, 2, 3, 4 and 5 are **0** over all 465 files. §9 and
§6 have the reasoning; this is the single largest piece of unfinished business.

### 8.5 Rule 3, measured

A separate, smaller sample — **130 files, every 8th, no size cap**, so it is
*not* comparable to §8.4's 465 — run after rule 3 was rewritten:

```
node tools/emit/corpus_scan.mjs --jobs 1 --child-heap 5000 --timeout 600 --stride 8
```

| | |
|---|---:|
| compiled functions / **functions emitted** | 24 318 / **24 318 = 100.00%** (metric 6) |
| **the identifier `ctx` as a variable** | **0** |
| **values emitted twice outside `duplicable`** | **0** |
| §11.3 invariant violations | 94 — 93 of check 3b, 1 of check 1 |
| holes | 349 |
| slot locations the reading function owns | 15 590 |
| **slot locations owned by an enclosing function** | **26 785** |
| slot locations that could not be placed | **0** |
| distinct bindings | 15 813 (15 804 named from the ScopeInfo, 9 as a declared `ctx[*][i]` placeholder) |
| bindings whose spelling moved for a collision | 14 175 |
| `const` bindings emitted as `let` (§9 gap 11) | 4 641 |
| context-creating frames / without a ScopeInfo id / claimed by two functions | 4 589 / 0 / 0 |
| parameters renamed off a binding's spelling (§3 rule 2) | 0 |
| **functions refused because a binding could not be placed** | **157 = 0.65%**, 1 588 slot uses, all `contextFrameNotStaticallyKnown` |
| unresolved context-slot placeholders still used | 17 (was 1 823: those functions are now refused) |
| names read but never written (check 3c) | 38 529 of 183 584 declared = 21.0% (was 32.0% on §8.4's sample) |
| **functions declared but never referenced** | **5 772 of 24 318 = 23.7%** — §9 gap 13 |

**26 785 slot locations are now one shared binding instead of a shadowing
local**, which is the whole of the §6.5 defect. The one invariant-1 violation is
not from this layer: check 1 is computed from T8's region tree against the IR's
blocks and never reads a name or a plan — it is in a file §8.4's size cap
excluded.

The 14 175 renamed spellings are not a smell: minified bundles reuse `e`, `t`,
`n` at every nesting level, and a block context flattened to its function's top
(rule 1) *must* be suffixed or it would shadow the function context's variable
of the same name for the whole body. The spelling is invisible to O1.

---

## 9. Known gaps

Everything here is counted by the tooling and appears in `report`.

1. **`super` outside a class method.** T7's `{e:'class'}` carries
   `members: []` (RECOVER.md §8.1: the `ClassBoilerplate` constant is not
   decoded), so a class's *methods* are not reachable from the class
   expression — they are separate units emitted as sibling function
   declarations, and `super` is a `SyntaxError` there. The reference becomes a
   declared `__super` placeholder with a `HOLE superOutsideAMethod` marker. A
   constructor reached through `{e:'class', sfiId}` *is* emitted as a
   `ClassMethod`, so `super()` in a constructor is fine; everything else is
   not. Fixing this needs the member list, which is a `src/heap` gap.
2. **A class body is empty.** Same cause. `{e:'class'}` emits
   `class X extends Y { constructor(...) {...} }` with a
   `HOLE classMembersNotDecoded <n> dynamic argument(s)` marker, and the
   methods appear as sibling functions instead of members. Correct-but-wrong-
   shaped, counted.
3. **`names read but never written`** (check 3c). The residual is dominated by
   values whose defining instruction an idiom consumed while nothing
   re-materialised it — the same class of gap as §4.1's for-in key, in the
   `forOf`, `await` and `finally` desugarings. The names are declared, so the
   output is legal and nothing is free, but those reads are `undefined`. The
   count and samples are in `report.unwrittenSamples`.
4. **Statements of a `removed` block with nowhere to go** (check 3b). T8's
   `removed` is a claim that T7 produces no statement for that block. Where
   the claim fails for `loopTestBlocks` this layer emits the chain inside the
   loop (§4.1 and below); where it fails for `asyncHandlerBlocks` the
   statements belong to the `async` desugaring and there is no slot in the
   tree for them, so they are dropped with a visible
   `DROPPED <n> statement(s) of removed block(s) ...` note at the end of the
   function and a count by `removed` kind and by statement tag. Not silent,
   but not emitted either.
5. **A materialised loop test degrades the loop form.** When
   `removed.loopTestBlocks` carries statements, `while (c) body` is emitted as
   `for (;;) { chain; if (!c) break; body }` and `for (;c;u) body` as
   `for (;;u) { chain; if (!c) break; body }`. The second keeps `continue`
   targeting the update, which is the whole reason T8 distinguishes the `for`
   form. Counted as `loopTestChainsMaterialised`.
6. **The `catch` binding is reconstructed, not derived.** V8 compiles
   `catch (e)` as a catch *context*: `CreateCatchContext` allocates a context
   whose slot holds the exception, and the body reads it with
   `LdaImmutableCurrentContextSlot`. The IR shows the gap exactly — on
   `try-catch.jsc` #15 `f`, `ContextSlot 36` has `loads:[29]` and `stores:[]`,
   because the store is performed *by* the context-creating instruction and so
   has no store op to attribute it to. Emitted as-is that reads
   `undefined.message`, so when a handler loads a depth-0 slot that nothing
   stores, `<slot> = <catch param>` is emitted with a marker. The condition
   comes from T6's own `ContextSlot.stores`, never from an opcode name, and
   when more than one slot qualifies nothing is emitted and the ambiguity is
   counted (`catchContextBindingsAmbiguous`) — guessing which of two unstored
   slots holds the exception would be a plausible placeholder.
7. **Jump-table guard blocks are emitted as `if`s.** T8 says T9 may drop them
   (`guardBlocks`). They are not dropped: they are placed blocks, and dropping
   a placed region would break invariant 1. Correct and redundant; the count
   is `switchGuardBlocks`.
8. **`perFunction[].code` is `null`.** §11.4 lists it. Generating each
   function's text separately costs a `@babel/generator` pass per unit, and
   the only consumer — `src/verify/pipeline.mjs` — recomputes `perFunction`
   from the emitted text with its own `splitFunctions`, so the field would be
   paid for and then ignored. Everything else §11.4 asks for is there.
9. **Module syntax is never emitted.** `import`/`export` do not appear: V8
   compiles a module's top level to a script-shaped function and
   `{e:'importCall'}` / `{e:'importMeta'}` are the only module forms T7 can
   produce. O3 already runs the decompiled output as a script for this reason.
10. **No prettifying pass.** `prettier` is a dependency of the project and is
    not used here: `@babel/generator`'s output is deterministic, which O2's
    round-trip fixpoint needs, and a second formatter is one more thing that
    could change the text between two runs.
11. **A context binding is declared AT ITS STORE, with an initialiser,
    whenever that is provable over the IR — so `const` is expressible and the
    reads come back immutable.** `src/emit/declsite.mjs`. *Closed; the residue
    is tabulated below.*

    This gap used to state a defect. What it said was that rule 1 declares
    every binding with no initialiser and assigns at the store site
    separately, so `const x;` is a `SyntaxError` and a `kConst` binding came
    out `let`. The keyword was never the point. The point is the opcode:
    `AstNodeFactory::NewAssignment` marks a `VariableProxy` assigned for every
    operator except `Token::kInit`, `ScopeInfo::Create` stores that bit as
    `maybe_assigned_flag`, and `BytecodeGenerator::BuildVariableLoad:4756`
    reads it back —

    ```cpp
    BytecodeArrayBuilder::ContextSlotMutability immutable =
        (variable->maybe_assigned() == kNotAssigned)
            ? BytecodeArrayBuilder::kImmutableSlot
            : BytecodeArrayBuilder::kMutableSlot;
    ```

    — so a declaration plus a separate store made **every** binding we emit
    `maybe_assigned`, and every read of it the mutable opcode. docs/O1.md §6.8
    measured the consequence: family `load-form` 132 → 12 383 functions, whose
    top shape — `LdaImmutableCurrentContextSlot →
    LdaCurrentContextSlotNoCell`, 8 983 functions, 11 633 hunks — was the
    largest single divergence in the whole comparison.

    The fix is one statement instead of two, `const x = <value>` at the store,
    and the whole of the work is the proof that it is legal: moving a
    declaration later in a function can make a name invisible (`let` and
    `const` are block-scoped), can turn a read of `undefined` into a TDZ
    `ReferenceError`, and can claim single assignment for a binding the
    original does not consider singly assigned.

    #### The condition, as seven clauses over the IR

    Each clause is an IR fact, each failure is named, and a binding that fails
    any clause keeps the prologue shape and is counted under the clause that
    refused it (`declsite.mjs::DECL_SITE_WHY`). No path through the file
    declares at a store "probably".

    1. **The original says so.** Every `ContextSlot` location of the binding
       carries `maybeAssigned`, read out of the ScopeInfo's own
       `maybe_assigned_flag` (`src/heap/objects.mjs`, `VariableProperties`),
       and every one has to say `false`.
    2. **One program store, file-wide.** Stores are counted over every
       function, and V8's TDZ initialisation is not one of them:
       `VisitVariableDeclaration:2158` emits `LoadTheHole().StoreContextSlot`
       for a lexical binding that `binding_needs_init()`, which T7 already
       recognises as `{s:'decl', tdzInitialisation:true}`
       (`src/recover/patterns/misc.mjs`) and which emits no text.
    3. **The store is in the owner**, not in a descendant.
    4. **The store dominates every read in the owner.** `ir.dominators` is the
       Cooper–Harvey–Kennedy tree; a read in the store's own block has to come
       after the store's instruction. Reads in descendants need no dominance —
       a closure body does not run where the closure is created, and the
       original's answer for a cross-closure read of a TDZ binding is the hole
       check V8 emits for it.
    5. **The store is not inside a loop** (`ir.blocks[b].loopDepth`), where a
       `let`/`const` declaration is a fresh binding per iteration and V8
       allocates a per-iteration context.
    6. **The stored value does not read the binding.** `const x = x + 1` is
       what a compound assignment lowers to, and it is a TDZ self-reference.
    7. **The store is an outermost statement of the body.** Dominance is
       necessary and not sufficient: a declaration inside an `if` is invisible
       after the `if` even though the `if` dominates what follows. The region
       tree answers this before emission — the store's block must be a
       `{r:'block'}` leaf reached from `sf.root` through `{r:'seq'}` nodes only
       — and `index.mjs::verifyDeclarationSites` then VERIFIES it on the
       emitted array by node identity, reverting the statement to an
       assignment if the model was wrong.

    #### Clause 1 is load-bearing, and it is not redundant

    Clauses 2–7 prove something about OUR text: that the binding is written
    once, at a place that encloses and precedes every read. They prove nothing
    about the original. A source `let x; … x = f()` has exactly one program
    store in our IR, it dominates every read, and the original reads it with
    the MUTABLE opcode — because in the original the store is not a
    declaration's initialiser either. Declaring that binding at its store
    would emit `LdaImmutableCurrentContextSlot` where the original has
    `LdaCurrentContextSlotNoCell`: the same diff, mirrored, in the same
    family. Measured, clause 1 refuses **18** bindings of 281 that clauses 2–7
    would admit, and **0** of the 18 bindings the original reads mutably were
    declared at a store.

    Clause 1 also covers a hole in clause 2 that nothing else could. Clause 2
    counts the stores T6 found in the functions this file RECOVERED; a
    descendant that failed to recover contributes no store. V8 computed
    `maybe_assigned` over the whole original program including that
    descendant, so a binding a lost function assigns is refused by clause 1
    whatever clause 2 can see.

    #### The placement is asked twice, on purpose

    Clause 7 asks the region tree before emission, which is what attributes
    the residue; `verifyDeclarationSites` asks the emitted array afterwards by
    node identity and reverts the statement if the answer differs, which is
    what makes it a proof rather than a model. The two have **not** disagreed
    yet: `declarationSitesRevertedAfterEmission` is 0 over 360 functions, and
    the check stays because a disagreement is a silent scoping bug.

    #### What it costs and what it buys

    `tools/emit/declsite_probe.mjs`, 5 corpus files, 360 functions,
    281 context bindings:

    | | bindings |
    |---|---:|
    | declared at their store site | **252 = 89.7%** |
    | of the 263 the original reads immutably | **252 = 95.8%** |
    | of the 18 the original reads mutably | **0** — clause 1 |
    | refused: `scopeInfoSaysMaybeAssigned` | 18 |
    | refused: `storeIsNotInAnOutermostBlock` | 7 |
    | refused: `noProgramStore` | 4 |
    | reverted after emission | 0 |
    | §11.3 invariant violations | 0 |

    Keyword at the store site: `const` 91, `let` 7, `var` 154.
    `constBindingsEmittedAsLet` falls to 2. Stores per binding: 260 bindings
    have exactly one, 17 have two or more, 4 have none.

    O1 over 16 corpus files chosen from `scratch/o1both/results/` for carrying
    the family, the same files before and after, 7 408 paired functions on
    both sides and **no change in the paired count** — so none of this was
    bought by emitting less:

    | | before | after |
    |---|---:|---:|
    | exactly equal | 895 = 12.08% | **1 222 = 16.50%** |
    | mean opcode similarity | 0.6897 | **0.7850** |
    | functions in family `load-form` | 2 567 | **227 = 91.2% fewer** |

    #### What it exposed: a binding's NAME is visible in the bytecode

    Rule 3 and `scopes.mjs` both claimed that renaming a context binding
    cannot change one instruction, because a context slot is an index. That is
    false, and this measurement is what showed it:
    `ThrowReferenceErrorIfHole` takes the variable's **name** as a
    constant-pool operand. Declaring at the store makes TDZ-guarded reads
    appear where our text previously had none, and with them the collision
    suffix this layer allocates:

    ```
    constant-value / ThrowReferenceErrorIfHole K("e") vs K("e$s2")   47 hunks
    reordered-block / ThrowReferenceErrorIfHole+Star                 34 hunks
    ```

    Both were 0 before. So `$s<n>` is not free after all, and the next item on
    this list is to prefer the ScopeInfo's own spelling over a suffix wherever
    a TDZ check can reach the binding. Recorded here rather than fixed because
    it is a naming change and this gap was an opcode change.

    #### The two relaxations that are available and were not taken

    Both are for `var` only, and both are stated rather than taken because
    each trades a clause of the proof for coverage:

    * **Clause 7 does not apply to a `var`.** A `var` declaration is hoisted
      to the closure scope, so `var x = <value>` inside an `if` or a `switch`
      case still declares `x` for the whole body, and a `var` has no TDZ —
      `binding_needs_init()` is false, so a read before the store gives
      `undefined` exactly as it does today. The reason this is not taken is
      the emitter, not soundness: a store in a loop's UPDATE region has to be
      an expression (`region.mjs::asSequence`), and a declaration there turns
      `for (;c;u)` into a counted `HOLE forUpdateNotAnExpression` with the
      update appended to the body. That is a worse output than the diff it
      would close, and modelling which placements are expression positions is
      a second model to be wrong about.
    * **Clause 5 does not apply to a `var` either**, for the same reason: no
      per-iteration binding, and `maybe_assigned` is static, so one
      `Token::kInit` assignment inside a loop is still `kNotAssigned`.

    The residue they would recover is `storeIsNotInAnOutermostBlock` +
    `storeIsInsideALoop` restricted to `kVar`.
12. **A temp of an enclosing function can still shadow a descendant's global
    read.** Rule 2 renames a temp whose spelling is also a global *in the same
    function*, which is where the two storage classes are both visible. It
    does not look at descendants: if an outer function has a temp T7 named
    `x` — `inferBase` names the result of `GetNamedProperty 'x'` after the
    property — and an inner function reads the real global `x`, the inner read
    resolves to the outer temp. The nesting that makes rule 3 work is what
    makes this reachable. It is the same defect shape as §6.5's, one storage
    class out, and the cheap fix (reserve every global the *file* reads
    against every temp) would rename thousands of temps and so belongs in its
    own measurement rather than in rule 3's.
13. **A function this file declares but nothing references is not compiled
    back.** `5 772 of 24 318` over §8.5's sample, counted as
    `unreferencedClosures` and marked in the text as
    `/* unreferenced closure (sfi N) */`. V8's scope analysis does not allocate
    the variable of an unreferenced inner declaration, so no `CreateClosure` is
    emitted, the SFI is unreachable from the parent's constant pool, and the
    function is absent from the recompiled cache — O1's self-test F measured 2
    of 102 carried in exactly this situation. That is what O1's **A-side
    unpaired 26.27%** is, and `docs/O1.md` §6.5 step 5 attributed it to this
    layer's scoping instead: the rule-3 rewrite collapsed the other four steps
    of that chain and moved A-side unpaired by 38 functions out of 12 750.
    Checked directly on five of the scanned files — of 19 A-side-unpaired
    functions named by the oracle, 17 sit immediately after that marker in our
    own text and 2 are not declared at all. The cause is upstream: T7 produced
    no `{e:'fn', sfiId}` reference reachable from an emitted statement, which
    the ranked shapes corroborate (`CreateClosure -> Ldar` 2 699 functions,
    `GetNamedProperty -> CreateClosure` 2 231,
    `CreateClosure -> LdaUndefined` 1 260,
    `missing-allocation CreateClosure` 1 174). O2's 0/257 is downstream of it.

### Found in other layers while building this one

Reported, not fixed.

* **`unit.parentSfiId` does not cover a top-level function declaration**
  (§2). `src/heap` derives it from `{t:'sfi'}` constant-pool entries, and
  `DeclareGlobals` hides its SFIs inside a FixedArray that is rendered as one
  `{t:'array'}`. Decoding that array in `src/heap` would give the tree
  directly; this layer works around it with source-range containment.
* **A catch context's slot has no store** (gap 6). Either
  `CreateCatchContext` should carry a `contextSlot` annotation with
  `isStore: true`, or `src/ir/context.mjs` should record the store, so that
  "read but never written" stays a real signal instead of a known exception.
* **`removed.loopTestBlocks` is not always statement-free** (gap 4/5).
  T8 gates the claim on §4.3's inlining condition, and on
  `async-await-in-loop.jsc` #15 `f` block 3 the gate passed while T7 had
  materialised the test (`let t$16 = v$3 < p0`) *and* emitted a phi copy
  (`v$11 = v`) in the same block. Either the gate needs T7's materialisation
  decision, which T8 cannot see, or the claim should be weakened to "T9 must
  emit these inside the loop" — which is what this layer does.
* **`src/ir/` gives an empty handler range an exception edge**
  (STRUCTURE.md §9.11, `b_86background.jsc` #58726 `setHtmlIcon`, handler 1
  `[166,166) -> @168`). T8 takes a whole-function fall-back with
  `why: 'blocksNotPlaced'`; this layer renders and counts those as
  `{r:'unstructured'}` and does not try to repair the IR.
