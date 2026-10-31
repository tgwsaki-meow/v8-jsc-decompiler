# `src/recover/` — Stage C: SSA IR → expressions, statements and names

T7 of wave W3. Input: the `IRFunction` of `docs/IR.md` (ARCHITECTURE.md §8.4,
extended by §10.4). Output: the `RecoveredFunction` of ARCHITECTURE.md §11.1.
**Straight-line code only** — every question about the shape of the graph
belongs to T8 (`src/structure/`), and the two are joined by T9 under §11.3.

```
src/recover/
  index.mjs      recover(ir, opts) -> RecoveredFunction
  names.mjs      the naming table (§4.5): ScopeInfo names, parameters,
                 the deterministic synthetic rule, the ctx[d][i] placeholder
  expr.mjs       the per-opcode transcription and the input map
  runtime.mjs    the closed set of Runtime::k* the generator can emit
  flags.mjs      the kFlag8 enums, with the pinned source they are checked against
  opnames.mjs    the ONLY file that writes down an opcode name
  dce.mjs        §4.3 step 1
  inline.mjs     §4.3 step 2 / §4.3.2 and the `duplicable` class
  verify.mjs     T7's own invariants, including metrics 6 and 7
  patterns/      the idiom engine, one file per family
```

Layering (§11.0): this directory imports `src/ir`, and `src/profile` only
through the IR. It imports nothing from `src/verify/` or `tools/`, holds no
version literal and no hex magic, and `tools/recover/selftest.mjs` group A
fails if any of that stops being true. Inputs are loaded through
`src/load/index.mjs` (`loadUnits(file, tagOrDir)`), which is also the only
source of `scopeInfoById`.

## 1. What is run, in what order, and why

`recover()` has a fixed order. It is not §4.3's order, and the difference
matters:

| | §4.3 | here | why |
|---|---|---|---|
| 1 | DCE | the name table | nothing names a context slot twice |
| 2 | constrained inlining | **the idiom engine** | a pattern decides which instructions have *no source form at all*; DCE and inlining have to see that before they decide anything |
| 3 | the idiom engine | reference discovery | §2.1 below |
| 4 | | DCE | |
| 5 | | the constrained inlining | |
| 6 | | statements, one pass per block in instruction order | instruction order inside a block *is* effect order |
| 7 | | `exprs`, hole counting, verification | |

Running the idioms first is the only change, and it is forced: a TDZ check
(`ThrowReferenceErrorIfHole`, 75 157 of them in the corpus) is an effectful op
with no result, so a DCE that ran first would keep it and the statement rule
would print 75 157 statements that were never in the source.

## 2. No value is ever evaluated twice (metrics 6 and 7)

This is the part of the layer that had to be designed rather than transcribed,
so it is written down in full. The baseline re-evaluated 12.93% of
side-effecting calls and destroyed the identity of 50.27% of allocations (one
object expression copied 22 times). §11.3 invariant 4 states the rule: an
`ssaId` may appear more than once in the output **iff** it is in
`recovered.duplicable`.

Three separate decisions, and keeping them separate is what makes the
invariant hold by construction.

**DUPLICABLE** (`inline.mjs::isDuplicable`) — may appear at more than one use
site. §4.3's "pure, cheap, identity-free" class, decided from `ir.sem` and
never from an opcode name:

```
allocationKind === 'none'      no identity to lose
&& !hasEffect                  nothing observable happens
&& effect.reads.length === 0   not order-sensitive, so a mutable context load
                               is excluded and an Immutable* one is not
&& the transcribed Expr is a leaf   lit / name / this / newTarget / importMeta
```

The last clause is the "cheap": a pure arithmetic tree over three calls is
identity-free, but duplicating it duplicates the calls, and the calls are what
the 12.93% measured. `GetTemplateObject` is `allocationKind:'cached'` and is
not duplicated either — its *value* is safe to name once and reuse, which is
what materialising does.

`recovered.duplicable` as published also contains every **materialised** value,
because `exprs` then holds `{e:'name'}` for it and the definition is emitted
exactly once, at its definition point. Reading a variable twice re-evaluates
nothing.

**INLINABLE** — may move from its definition point into its single use.
Exactly §4.3.2: one occurrence, the definition dominates the use, and nothing
interferes on the effect chain in between. Made precise: a definition that is
itself in the effect chain may only move forward over chain members that are
themselves being absorbed into the same use, in evaluation order. That is the
stack discipline the bytecode was emitted with — `VisitArguments` evaluates
arguments left to right into consecutive registers — and it is why `f(g(),h())`
comes back whole while `f(g(),x)` with an unrelated `k()` between them does not.

The chain the adjacency test walks is `block.effects` **with the instructions
an idiom consumed removed**. A consumed instruction emits no statement (the
statement pass skips it before it looks at any override), so it is not
something a definition can be reordered across. Leaving them in is what made

```
LdaCurrentContextSlot [2] ; ThrowReferenceErrorIfHole 'later' ; Return
```

print `let later$3 = later; return later$3`: the consumed TDZ check sat between
the load and the return and read as an intervening effect.

**MATERIALISED** — everything else. It gets a name from `names.mjs` and one
statement at its definition point. §4.3's "物化成命名临时变量".

### 2.1 Occurrences: references are discovered, not declared

A pattern's rewrite is a thunk, so the values it mentions are **not** in the
IR's input lists, and the instruction that used to mention them is in
`consumed`. Both directions of error were measured on the corpus:

* `{a: f()}` — the fold deletes the `DefineNamedOwnProperty` and re-mentions
  its accumulator operand inside the object literal. Counting IR inputs alone
  makes that operand look unused, so it is inlined and then printed once per
  fold. Measured: 7 values in 1940 functions, every one an `await` that
  appeared inside two object literals on two paths.
* `ResumeGenerator`'s eight register projections re-mention the registers
  `SuspendGenerator` spilled and stop mentioning the resume value itself
  (`BuildSuspendPoint:5977`). Counting the structural `Proj.of` link made every
  `await` look like a nine-use value, so `return await p` came out as
  `let t = await p; return t`.

So the references are **discovered**: every registered thunk is run once with
`pc.E` replaced by a recorder, before the real resolver has run, and the
recorded ids are that value's reference list (`rewriteRefs`). A thunk that
insists on a real expression throws; its partial trace is kept and its owner
falls back to *also* counting the IR inputs, which is the safe direction.
Nothing has to be declared per pattern, so a new idiom cannot forget to.

The occurrence table is then one worklist pass. Every value contributes its
references exactly once, which is sound given the rule the plan enforces — a
value reached more than once is materialised, so it is emitted once either way.
Two kinds contribute nothing: a move (canonicalisation already erased it) and
an instruction an idiom consumed, which contributes only once something
references its *value*. That second distinction is load-bearing in both
directions: a folded `DefineNamedOwnProperty` is consumed and unreferenced, so
counting its object operand would materialise every object literal, while a
consumed `ResumeGenerator` carrying `{e:'await', arg}` *is* referenced by
whatever reads the await.

### 2.2 The detector is exact, not heuristic

`verify.mjs` R1 does not compare expression structures. Resolution memoises one
expression **object** per SSA value, so "emitted twice" is "the same object was
reached twice while walking the statement trees". Several values can share one
object when a pattern aliases them deliberately ("this projection *is* that
spilled register"), so the map is object → every value that resolves to it, and
a node is a violation only if **none** of them may be duplicated. Keeping only
the first id reported a shared `{e:'lit', v:undefined}` as a re-evaluated
`ResumeGenerator`.

## 3. The pattern table

Each row is a `BytecodeGenerator::Visit*`/`Build*` method read backwards.
Line numbers are in `src/interpreter/bytecode-generator.cc` at the pinned tag
**14.4.258.16** (sha256
`2cfe5b32c722d2598bfd9bf60bf1b6349a0a7aca7b7169b70425eafca437163e`) unless
another file is named. `confidence` is what the claim carries: `exact` when the
recogniser matched the whole emitted shape, `shape` when it matched a necessary
but not sufficient part. **A row with no citation is `shape` by construction** —
`pc.claim()` downgrades any claim whose `cites` is empty, so an uncited guess
cannot present itself as exact.

| `kind` | family | generator method inverted | confidence |
|---|---|---|---|
| `logicalOr` | logical | `VisitLogicalOrSubExpression:8225` | exact |
| `logicalAnd` | logical | `VisitLogicalAndSubExpression:8243` | exact |
| `nullish` | logical | `VisitNullishSubExpression:8261` | exact |
| `ternary` | logical | `VisitConditional:4103` | exact |
| `optionalChain` | optional | `BuildOptionalChain:6704`, `VisitPropertyLoad:6404` | exact; shape when the chain has no member or call at its end |
| `objectLiteral` | literals | `VisitObjectLiteral:4190`, `BuildCreateObjectLiteral:4179` | exact |
| `arrayLiteral` | literals | `VisitArrayLiteral:4668`, `BuildCreateArrayLiteral:4508` | exact |
| `template` | literals | `VisitTemplateLiteral:8069` | exact |
| `taggedTemplate` | literals | `VisitGetTemplateObject:8061`, `VisitCall:6738` | exact; shape with no recognised tag call |
| `regexp` | literals | `VisitRegExpLiteral:4172` | exact |
| `accessor` | accessor | `VisitObjectLiteral:4190`, `VisitLiteralAccessor:8551`, `BuildLoadPropertyKey:8647` | exact when the target literal is visible |
| `forIn` | forin | `VisitForInStatement:3251` | exact |
| `forOf` / `forAwaitOf` | forof | `VisitForOfStatement:3344`, `BuildGetIterator:7911`, `BuildIteratorNext:7994` | exact; shape with no recognised `next()` call |
| `iteratorClose` | forof | `BuildIteratorClose:8033`, `BuildFinalizeIteration:5331` | shape |
| `destructure` | destructure, spread | `BuildDestructuringObjectAssignment:5638` | exact |
| `destructureDefault` | destructure | `BuildDestructuringArrayAssignment:5464`, `BuildDestructuringObjectAssignment:5638` | exact |
| `spread` | spread | `VisitSpread:7887` + `VisitCall:6738` / `VisitCallNew:7136`; `BuildCreateArrayLiteral:4508` + `BuildFillArrayWithIterator:4474` for `CreateArrayFromIterable`; `VisitSuperCallForwardArgs:7184` for `ConstructForwardAllArgs`; `VisitObjectLiteral:4190` for object spread | exact; shape when the spread target is not visible |
| `restParameter` | spread | `VisitRestArgumentsArray:8571` | exact |
| `class` | classes | `BuildClassLiteral:3534`, `VisitClassLiteral:3832`; `BuildGetAndCheckSuperConstructor:7105`, `VisitCallSuper:6961` for `super()` | shape for `%DefineClass`; exact for the `super()` dispatch |
| `privateField` | classes | `BuildClassLiteral:3534`, `BuildPrivateBrandInitialization:3994` | exact |
| `await` | asyncgen | `BuildAwait:6337`, `BuildSuspendPoint:5977`, `VisitAwait:6389` | exact when the resume-mode dispatch matched, shape otherwise |
| `yield` | asyncgen | `VisitYield:6001`, `BuildSuspendPoint:5977` | exact / shape as above |
| `yieldStar` | asyncgen | `VisitYieldStar:6161` | shape — only the async-from-sync wrapper; the delegation loop is T8's |
| `generatorPrologue` | asyncgen | `BuildGeneratorObjectVariableInitialization:8612` | exact |
| `generatorDispatcher` | asyncgen | `BuildGeneratorPrologue:2074` | exact |
| `asyncReturn` | asyncgen | `BuildAsyncReturn:4852` | exact |
| `asyncReject` | asyncgen | `GenerateAsyncFunctionBody:1893` | exact |
| `generatorClose` | asyncgen | `GenerateAsyncGeneratorFunctionBody:1956` | exact |
| `asyncAwaitHandlerRange` | asyncgen | `GenerateAsyncFunctionBody:1893`, `BuildTryCatch:2926` | exact |
| `typeof` | typeofetc | `VisitTypeOf:7242`; `VisitCompareOperation:7721` + `IsLiteralCompareTypeof:7671` for the `TestTypeOf` fold; `VisitForTypeOfValue:7230` for the inside-typeof loads | exact; shape when the `LiteralFlag` is out of range |
| `delete` | typeofetc | `VisitDelete:7301` | exact |
| `in`, `instanceof` | typeofetc | `VisitCompareOperation:7717` | exact |
| `compareNil` | typeofetc | `BuildLiteralCompareNil:7623` | exact |
| `update` | update | `VisitCountOperation:7390` | exact |
| `tdzCheck` | misc | `BuildThrowIfHole:4902` | exact |
| `tdzInit` | misc | `BuildVariableAssignment:4963`, `BuildThrowIfHole:4902`, `BuildHoleCheckForVariableAssignment:4925` | exact |
| `superGuard` | misc | `VisitCallSuper:6961`, `BuildHoleCheckForVariableAssignment:4925` | exact |
| `finallyMessage` | misc | `BuildTryFinally:2979` | exact |
| `contextPlumbing` | misc | `BuildNewLocalActivationContext:8470` | exact |
| `declarationPass` | misc | `VisitDeclarations:2305`, `VisitGlobalDeclarations:2281` | exact |
| `argumentsObject` | misc | `VisitArgumentsObject:8560` | exact |
| `iteratorGuard` | misc | `BuildIteratorNext:7994` | exact |
| `directEval` | misc | `VisitCall:6738` | shape — the `%ResolvePossiblyDirectEval` + `Call` pair; the call itself stays |

Two kinds in §11.1's list are **not** claimed: `staticBlock` (nothing in the
corpus sample distinguishes a static block from an ordinary member initialiser)
and `importMeta` / `importCall`, which are transcriptions rather than idioms
(`%GetImportMetaObject`, `%DynamicImportCall`).

### 3.1 Why a phi's idiom form is an *alternative*, not the canonical one

A phi is destructed the classic way: it gets a name, and each predecessor gets
a copy. For a phi an idiom recognises as `a || b` or `c ? t : e` the expression
form is produced too — but as `patterns[].expr` and `recovered.altExprs`, not
as `exprs[phi]`.

The reason is §11.1 against §11.3. §11.1 says `consumed` is "not T8's input",
and §11.3 invariant 1 makes T8 place every reachable block. If T7 put `a || b`
in `exprs` and T8 independently structured the same diamond, then whichever of
the two T9 dropped, the other would have to be dropped consistently — and if it
were not, `b` would be evaluated twice, which is exactly metric 6. Keeping the
destructed form canonical makes T7's output correct on its own and leaves the
collapse to T9, which can see both trees. The claim, its citation and its count
are all still reported.

### 3.2 Opcode names

`opnames.mjs` is the only file in `src/recover/` that writes an opcode name,
and names are used **only** for syntactic idiom matching — which is what an
idiom is, since a `Visit<Node>` method names bytecodes. No decision about
*semantics* is keyed on a name: those come from `ir.sem`
(`effect.{reads,writes,throws,callsUserCode,diverges}` and `allocationKind`).

`registry(profile)` checks every declared name against the loaded profile and
**throws**, naming the missing opcodes, so a V8 version that renames or drops
one fails loudly on the first function instead of silently never matching its
idiom. Names a profile may legitimately not have are listed in `OPTIONAL` and
are reported, not fatal.

### 3.3 Runtime calls

`runtime.mjs` is the closed set of runtime functions `BytecodeGenerator` can
emit: every `Runtime::k<Name>` mentioned anywhere in the pinned
`bytecode-generator.cc`, 63 of them, which the self-test re-derives from that
source and compares. A runtime id outside the set cannot have come from the
generator, so it becomes `hole('unmodelledRuntimeCall')` rather than being
given a plausible shape. `InvokeIntrinsic` and `CallRuntime` share the table:
the generator writes `Runtime::kInlineFoo` and the builder picks the bytecode,
so the same name arrives as an intrinsic id on one and a runtime id on the
other.

## 4. Naming (§4.5, §10.3)

Context-slot names are **read** off T6's resolution (`v.contextSlot.name`),
never recomputed: §10.3 corrected §8.1 on two counts (the subtrahend is
`ScopeInfo::ContextHeaderLength()`, and depth 0 is `unit.scope.outer`) and T6
implemented and measured that walk. One name per slot *location*, which is what
makes a load and a store of the same variable print the same identifier.

### 4.1 The deterministic synthetic rule, in full

O2's round-trip fixpoint depends on this being stable, so it is stated here as
well as in `names.mjs`:

1. Candidate names are allocated in **one** pass over the values that need a
   name, in **ascending SSA id** order. SSA ids are assigned by `src/ir` in a
   fixed order for a fixed input, so two runs agree.
2. Each value proposes a `base` from its defining instruction (`inferBase`,
   tabulated below). A value with no proposal uses the base for its kind: `v`
   for a phi, `e` for a caught exception, `t` for anything else.
3. `base` is sanitised to a JS identifier: every character outside
   `[A-Za-z0-9_$]` becomes `_`; a leading digit gets a `_` prefix; a reserved
   word and the single banned identifier `ctx` get a `_` suffix; a V8-internal
   name (`.generator_object`, `*ns*`) gets a `__` prefix.
4. The first value to claim a base gets it verbatim. The n-th gets `base$n`,
   n counting from 2. Already-taken names — every ScopeInfo name in the scope
   chain, every parameter, the function's own name — are seeded into the taken
   set before step 4, so a temp can never shadow a real name.

The bases `inferBase` proposes, which is §4.5's "infer from the use site, as
`x.length` → `len`":

| defining instruction | base | origin |
|---|---|---|
| a resolved context-slot load | the ScopeInfo name | `scopeInfo` |
| `GetNamedProperty`, `SetNamedProperty`, `DefineNamedOwnProperty`, `GetNamedPropertyFromSuper` | the property name | `inferredFromUse` |
| `LdaGlobal`, `LdaGlobalInsideTypeof` | the global's name | `inferredFromUse` |
| `CreateObjectLiteral`, `CreateEmptyObjectLiteral`, `CloneObject` | `obj` | `inferredFromUse` |
| `CreateArrayLiteral`, `CreateEmptyArrayLiteral`, `CreateArrayFromIterable` | `arr` | `inferredFromUse` |
| `CreateRegExpLiteral` | `re` | `inferredFromUse` |
| `CreateRestParameter` | `rest` | `inferredFromUse` |
| `CreateMappedArguments`, `CreateUnmappedArguments` | `args` | `inferredFromUse` |
| `CreateClosure` | the SFI's name, else `fn` | `inferredFromUse` / `synthetic` |
| `GetIterator` | `iter` | `inferredFromUse` |
| `ForInPrepare`, `ForInEnumerate` | `keys` | `inferredFromUse` |
| `ForInNext`, `GetEnumeratedKeyedProperty` | `key` | `inferredFromUse` |
| `Construct*` | the callee's name with a lower-cased initial, else `instance` | `inferredFromUse` / `synthetic` |
| `Call*` | the callee's name with a `get`/`read`/`load`/`fetch`/`create`/`make`/`to` prefix stripped, else `r` | `inferredFromUse` / `synthetic` |
| `GetTemplateObject` | `tmpl` | `inferredFromUse` |
| `LdaConstant` of a short identifier-shaped string | that string, else `k` | `inferredFromUse` / `synthetic` |
| a parameter | `this` for the receiver, else `p<i>` | `param` |
| the incoming generator / new.target / context frame entries | `__generator`, `__newTarget`, `__context` | `synthetic` |

### 4.2 `ctx` is unreachable

§11.3 invariant 5 forbids the identifier `ctx` in the output (baseline:
1 710 336 occurrences). It is in `BANNED`, so a ScopeInfo variable actually
called `ctx` comes out as `ctx_` and a synthetic one as `_ctx`. A slot whose
name cannot be recovered becomes `__ctx_d<d>_i<i>` carrying
`comment: 'ctx[d][i]'` — §4.5's "`/* ctx[d][i] */` comment plus an explicitly
declared placeholder" — one placeholder per `(depth, index)` pair, allocated on
first use, and **declared**, so nothing is ever free.

Two sources of unnamed slots, kept apart because they are different problems:
a slot whose frame resolved but whose `ScopeInfo` carries no name, and
`contextValueNotStaticallyKnown` (docs/IR.md §11: 12 119 of 980 989 operands,
1.24%, where the context register holds different context objects on different
paths so there is no single location to name). Both get the placeholder; the
reason is recorded on the declaration.

A named function expression's own name is a binding too
(`VisitThisFunctionVariable:8581` copies `<closure>` into `.this_function`).
It is declared lazily, on the first read of the closure register, because
otherwise all 239 979 functions would carry a declaration nothing references.
An *anonymous* function reading its own closure register has no honest
spelling, so it is `hole('closureRegisterOfAnAnonymousFunction')`.

## 5. Extensions to §11.1's closed sets

§11.1's `Expr` set has no way to spell three things T9 needs to reach
`@babel/types`, so `EXPR_TAGS` adds them:

| tag | Babel node | why |
|---|---|---|
| `super` | `Super` | `super.x` / `super[k]` — `GetNamedPropertyFromSuper` has an object that is not an expression in §11.1's set |
| `importCall` | `Import` | `import(x)` is a callee that is not a `name` |
| `templateObject` | — | the raw/cooked pair a tagged template's tag receives; `GetTemplateObject`'s value before the tag call folds it |

Two fields are added to the output object, both additive, both for T9's
mechanical check of invariant 11.3.4: `materialised`
(`Map<ssaId, {name, origin, kind}>`, i.e. which value a name stands for) and
`altExprs` / `alternatives` (§3.1). `tdzNames` reports the names TDZ checks
mentioned, which confirms a binding's declaration kind.

There are also *intermediate* tags: the shape a desugaring's runtime call has
before a pattern consumes it (`awaitOperand`, `iterResult`, `defineClass`,
`copyDataProperties`, …). They are **not** part of the contract — one that
survives to the output becomes a counted
`hole('unconsumedIntermediate:<tag>')` rather than being published, so an
unrecognised desugaring is visible instead of leaking a tag T9 cannot map.

## 6. Holes

`{e:'hole', why, detail, dump}` is the only way this layer says "I don't know"
(§7: never a plausible placeholder). Every hole is counted and carries a
`why`; `verify.mjs` R4 fails on one that does not.

Holes are reported in three buckets, because they are not equally serious:

* **in an emitted statement** — the output will contain a hole. This is the
  number that matters.
* **in an `exprs` entry T8 can name** — a `Test.value`, i.e. the condition of
  an `if` T8 will emit. §11.3 invariant 2 calls this a T7 gap.
* **in an `exprs` entry nothing reads** — `exprs` carries an entry for every
  live value so T9 can resolve any `values[]` reference it finds, and most of
  those entries are never read by anybody. A hole there costs nothing but is
  still tabulated rather than suppressed.

The `why` values and what each one means:

| `why` | meaning |
|---|---|
| `statementUsedAsValue` | the instruction transcribes to a statement (a store, a jump), so "the expression of this value" has no answer |
| `valueOfASkippedInstruction` | the instruction is desugaring plumbing with no source form (`runtime.mjs` role `skip`) |
| `frameHeaderRegisterReadAsValue` | a read of the frame header (the incoming context, the closure) as data |
| `closureRegisterOfAnAnonymousFunction` | `<closure>` read by a function with no SFI name (§4.2) |
| `multiOutputProjection` | one output of a multi-output op that no pattern claimed |
| `unconsumedIntermediate:<tag>` | a desugaring's intermediate shape survived (§5) |
| `unmodelledRuntimeCall` | a runtime id outside the 63 the generator can emit (§3.3) |
| `runtimeIdNotNamedByProfile` | the profile's runtime table has no name for the id |
| `unresolvedConstant:<reason>` | `src/heap` could not classify a constant-pool entry |
| `opcodeNotTranscribed` | the transcription table has no branch for this opcode |
| `contextSlotUnnamed` | a slot location with no entry in the name table |
| `phiWithoutName` | a live phi that was neither named nor rewritten |
| `effectValueReadAsData` | an effect-chain value read as data |
| `exprTooDeep`, `exprCycle` | the resolution guards (depth 64, and a cycle) |
| `noDefinition`, `noValue`, `nonExpr`, `frameEntry`, `valueKind`, `unknownExprTag:<tag>` | a shape the resolver cannot account for; each one is a bug report, not an expected case |

## 7. The corpus

The numbers below come from

```
node tools/recover/corpus_scan.mjs
```

which runs `src/recover` over all 1039 files of `extracted_jsc` with **one
forked child per file** and a capped child heap (the host has 4 GB and about
two cores), and writes `scratch/t7/RECOVER_CORPUS.md` plus the same data as
JSON. Nothing from the corpus is ever executed. The run is resumable — a file
whose result JSON exists is skipped, `--force` re-does everything, `--stride N`
takes every Nth file for a sample spread across the corpus rather than its
alphabetical head, which is all browser-extension service workers and is not
representative.

<!-- CORPUS -->

## 8. Known gaps

### 8.1 In this layer

* **`yield*` is only half recognised.** The claim covers
  `%CreateAsyncFromSyncIterator`, the async-from-sync wrapper; the delegation
  loop `VisitYieldStar:6161` builds around `BuildIteratorNext` is a loop, so it
  is T8's, and T7 contributes no `{e:'yield', delegate:true}` for it.
  Confidence `shape`; the count is reported.
* **`%DefineClass`'s member list is not decoded.** `BuildClassLiteral` passes a
  `ClassBoilerplate` constant that `src/heap` does not decode, so
  `{e:'class'}` carries `superClass` and the constructor SFI but
  `members: []` plus a `dynamicArguments` count. Confidence `shape`.
* **`staticBlock` is never claimed** (§11.1 lists it).
* **A `switch`'s compare chain is not folded.** §9.3 measured only 1140 real
  jump tables against a majority of compare chains; folding the chain into one
  `switch` is a shape question and therefore T8's. T7 supplies the
  per-comparison expressions only.
* **No alias analysis.** Inherited from the IR: `heap` is one effect kind, so
  any two property accesses interfere and a definition between them is
  materialised rather than inlined. Correct, sometimes uglier than necessary.
* **A cross-block effectful definition is never inlined.** The adjacency test
  is per block. `await p` in a resume block reaches its reader in the
  dispatch's fall-through block only because every instruction between them is
  consumed; a general cross-block rule needs post-dominance as well as
  dominance (the use must be *reached*, not merely dominated) and is not
  implemented.
* **`exprs` holds an entry per live value.** More than §11.3 invariant 2
  requires, and most entries are never read — which is the only reason the
  "holes in entries nothing reads" bucket exists. Narrowing it would cut work
  but would also make "no entry" ambiguous between "not an expression" and
  "nobody asked".
* **The duplication detector runs after the fact.** `verify.mjs` R1 is exact,
  but it *reports*; it does not repair. The occurrence table is what makes the
  count zero, and if a future idiom defeats the table the number moves instead
  of the output silently duplicating. That is the intended failure mode, but it
  does mean the guarantee is "measured zero", not "impossible by type".

### 8.2 In other layers, found while building this one

Reported, not fixed.

* **`src/profile` has `runtimeId(name)` but no `intrinsicId(name)`.** The
  intrinsic table is exposed id → name only (`intrinsicName`, `intrinsic`),
  although `intrinsics.json` carries `byName[name] -> id`. The self-test works
  around it by inverting the table — and that asymmetry is why the `await`
  check silently *skipped* for a while: `profile.intrinsicId` was `undefined`,
  so a guard meant to catch "this version has no such intrinsic" caught "this
  accessor does not exist" instead. A guard that cannot tell those apart is
  worse than no guard. `intrinsicId()` belongs next to `runtimeId()`.
* **The `kFlag8` enums are a sixth silent profilegen gap**, on top of §9.6's
  four and §10.7's fifth. `TestTypeOfFlags::LiteralFlag`,
  `JSGeneratorObject::ResumeMode` and `TryFinallyContinuationToken` are not in
  `profiles/<tag>/*.json` at all: `src/disasm` hands a `kFlag8` through as a
  raw number and `src/listing` prints it in hex, exactly as V8's own
  `BytecodeDecoder` does. They are declared in `flags.mjs` with their exact
  pinned-source origin, and `tools/recover/selftest.mjs` re-derives each from
  that source and fails on disagreement — which is how the next item was found.
  They belong in profilegen.
* **`ResumeMode` has four members, not three.** The pinned
  `src/objects/js-generator.h` declares
  `enum ResumeMode { kNext, kReturn, kThrow, kRethrow }`. Three is what
  `BuildAwait`'s comment implies, because it only ever compares against
  `kNext`.
* **`BuildLiteralCompareTypeof` does not exist at 14.4.258.16.** The fold is
  inline in `VisitCompareOperation:7721` via `IsLiteralCompareTypeof:7671`,
  which emits `CompareTypeOf:7729`. A citation naming a method that is not in
  the version it cites is worse than no citation; the row now cites the
  visitor.
* **`src/disasm`'s `stats.opcodeHistogram` is a `Map`.** Reading it with
  `h[op]` yields `undefined`, which is how an earlier trial reported 0
  `SuspendGenerator` against 223 `await` claims — an impossible pair, since the
  `await` recogniser is anchored on `SuspendGenerator`. Fixed in
  `tools/recover/corpus_worker.mjs`; worth a line in `docs/IR.md` because the
  same read is easy to get wrong anywhere.
* **A `SuspendGenerator` whose resume block is unreachable produces no
  `ResumeGenerator` value.** Correct, not a bug, but worth writing down because
  it is a trap for anyone hand-assembling a test: `BuildSuspendPoint:5977`
  binds the resume point into `generator_jump_table_`, so without the entry
  `SwitchOnGeneratorState` the resume block has no predecessor, gets no SSA
  value, and no `await` can match. A test that omits the prologue tests
  nothing.
