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
| `class` | classes | `BuildClassLiteral:3534`, `VisitClassLiteral:3832`; `BuildGetAndCheckSuperConstructor:7105`, `BuildSuperCallOptimization:7123`, `VisitCallSuper:6961` for `super()` | shape for `%DefineClass`; exact for the `super()` dispatch and for `super(args)` |
| `propertyCall` | calls | `VisitCall:6738` (`:6782`, `:6854`), `VisitPropertyLoadForRegister:6638`, `VisitNamedSuperPropertyLoad:6646` | exact |
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
| `ownPropertyDefinitionNotFoldedIntoItsLiteral` | a `DefineNamedOwnProperty` / `DefineKeyedOwnProperty` / `DefineKeyedOwnPropertyInLiteral` that no literal fold claimed. The generator emits these only inside an object literal (`VisitObjectLiteral:4281`, `:4285`, `:4406`) or a class body (`BuildClassProperty:3908`, `:3930`), so the only source form is the literal — and `o.x = v` is **not** it: `Set*Property` walks the prototype chain and calls a setter, `Define*OwnProperty` creates an own data property and does not |
| `arrayLiteralElementStoreNotFoldedIntoItsLiteral` | the same, for `StaInArrayLiteral` (`BuildCreateArrayLiteral:4605`/`:4643`, `BuildFillArrayWithIterator:4500`, `BuildDestructuringArrayAssignment:5596`) |
| `classFieldOutsideItsClassBody` | a `Define*OwnProperty` **on the receiver**, which only `BuildClassProperty:3908`/`:3930` emits and only from `VisitInitializeClassMembersStatement:3935` / `VisitInitializeClassStaticElementsStatement:3942`. The unit is therefore a class-members initialiser (its SFI's `FunctionKind` says so) and the store is a class field; a class field has no spelling outside a class body |
| `superConstructorDispatchFlagIsARuntimeValue` | `FindNonDefaultConstructorOrConstruct`'s `out[0]` (`BuildSuperCallOptimization:7123`): true iff V8 already built the instance by walking past default constructors. It was transcribed as `{e:'lit', v:true}`, which made the `super()` call dead code and silently deleted the derived-constructor protocol |
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
* **`%DefineClass`'s member list is decoded; two template shapes are not.**
  Was: `src/heap` did not decode the `ClassBoilerplate` at all, so
  `{e:'class'}` carried `superClass` and the constructor SFI and nothing else.
  It does now (docs/FRONTEND.md §4.2a), and `{e:'class'}` carries
  `members: [{kind, key, computed, static, value}]` in declaration order plus
  `membersDecoded` and a `membersNotPlaced` list. Measured over the 29-file
  sample (`node tools/probes/probe_class.mjs members`): 82 `{e:'class'}`
  nodes, **82 with a decoded member list**, **648 members** carried —
  531 methods, 107 getters, 4 setters, 6 static methods — **0 refused**, and
  the claim is `confidence:'exact'`.

  What is still refused, each by name and each counted as a hole by
  `src/emit`:
  * a properties or elements template that is a `NameDictionary`,
    `SwissNameDictionary` or `NumberDictionary` rather than a
    `DescriptorArray` — `ObjectDescriptor::HasDictionaryProperties:471` picks
    that shape for a class with a computed-name member or more than
    `kMaxNumberOfDescriptors` properties, and for a member whose key is an
    array index. 0 of 82 in the sample, so the corpus-wide count is the number
    to watch rather than a known quantity;
  * `kAutoAccessor` (`accessor x`), which has no `{kind}` `src/emit` can spell.
    A named accessor pair is additionally *indistinguishable* from
    `accessor x` in the boilerplate: `SetAccessorPlaceholderIndices:41` sets
    `getter = i, setter = i + 1` in one call for an auto-accessor, which is
    exactly what adjacent `get x` / `set x` declarations produce. Only a
    computed-name auto-accessor carries its own `ValueKind` and is therefore
    identifiable. 0 in the sample.
* **A derived constructor's `super()` is recovered but its dispatch diamond is
  not collapsed.** `BuildSuperCallOptimization:7123` branches on a runtime
  flag, so T8 structures the two paths as an `if` and T7 contributes
  `super(args)` inside it plus a hole for the flag. The source is one
  statement; the output is `if (<hole>) { instance = super(args) }` and a phi
  for `this`. Collapsing it needs T8/T9, because the dispatch is control flow.
* **A class field is still not placed in its class body, and the
  `ClassBoilerplate` decode cannot help.** T7 knows which unit is the
  class-members initialiser (the SFI's `FunctionKind` is
  `kClassMembersInitializerFunction`) and `VisitClassLiteral:3800` ties it to
  its class with `StoreClassFieldsInitializer`, so the link is recoverable —
  but emitting one unit's statements as another unit's class members is
  `src/emit/index.mjs::resolveClass`'s decision, not this layer's. Until then
  each field is a counted `classFieldOutsideItsClassBody` hole.

  What is now settled is that the boilerplate is not the way in.
  `ClassBoilerplate::New:769` `continue`s on `ClassLiteral::Property::FIELD`
  before any `desc.Add*`, so a field appears in no template — it is absent, not
  undecoded. The only trace it leaves is one dynamic argument when its name is
  computed, which `{e:'class'}.boilerplateArgumentsUnclaimed` reports and
  `src/emit` sums as `classArgumentsNoTemplateDescribes`. Over the 29-file
  sample that number is **0**, so every dynamic argument of every
  `%DefineClass` in it is accounted for by a member.
* **`{e:'class'}` used to sit on a value nothing reads.** Recorded because it
  was invisible for a long time: `Runtime::kDefineClass` installs the
  prototype and the members **onto the constructor JSFunction** and returns
  the prototype in the accumulator, and `BuildClassLiteral:3645-3662` moves
  the constructor closure into `args[1]` before the call, so the register that
  held the closure holds the class afterwards (`VisitClassLiteral:3829` reads
  it back). With `{e:'class'}` on the `%DefineClass` value instead, every use
  of a class resolved to `{e:'fn', sfiId}`: measured on `r_55201.jsc`, 8 of 8
  `%DefineClass` sites produced an `{e:'class'}` that reached no statement and
  the emitted text contained no `class` at all. `classes.mjs` now puts the
  class expression on the constructor's value and `<class>.prototype` on the
  call's.
* **A property call whose callee crosses a suspend point still comes back as
  `callee.call(receiver, …)`.** `patterns/calls.mjs` claims a call whose
  callee register was loaded out of its receiver register, which is every
  property call `VisitCall:6738` can emit — but after a `SuspendGenerator` the
  callee arrives as a `ResumeGenerator` projection of the spilled register
  (§2.1), a different SSA value, so the identity test cannot see it. Measured
  residue: 1 of 374 property calls in `r_19252.jsc` + `r_89889.jsc`. The
  `.call` form is counted (`stats.notes.propertyCallReceiverMismatch`) and is
  **not** bytecode-equal: it loads `"call"` off the callee and depends on
  `Function.prototype.call`.
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

* **`src/emit/index.mjs` emits a closure in an argument position as a hoisted
  function declaration plus a name, which changes evaluation order.**
  `resolveFn(ctx, e, 'expression')` returns `t.identifier(n)` and the unit is
  emitted as a sibling `function` declaration, so its `CreateClosure` moves to
  the top of the enclosing body. `VisitCall:6738` evaluates the callee in its
  `switch` and only then calls `VisitArguments`, so a callee and a closure
  argument swap order. The minimal case, `p_preload_ex.jsc` sfi 4126
  (`return qe(this, function () { … })`):

  ```diff
  - LdaImmutableContextSlot <context> [137] [2]   ; the callee, first
  + CreateClosure K(<SharedFunctionInfo #*>) FB[*] #2   ; the argument, first
    Star R0
  - CreateClosure K(<SharedFunctionInfo #*>) FB[*] #2
  + LdaUndefined
    Star R1
  - CallUndefinedReceiver2 R0 <this> R1 FB[*]
  + CallUndefinedReceiver2 R1 <this> R0 FB[*]
  ```

  This is the whole of O1's `operand-order` family. T7's output is already
  right — `{e:'call', callee:<the context slot>, args:[{e:'this'}, {e:'fn'}]}`
  — so the fix is to emit a `FunctionExpression` in the argument position when
  the closure has one reference, which is `src/emit/index.mjs`'s call.
* **Emitting a class member needs one unit's statements inside another unit.**
  `resolveClass` builds `members` from `{e:'class'}.members`, which is now
  populated, so a method, getter, setter or static member is placed. A class
  field (which lives in its own `kClassMembersInitializerFunction` SFI) and a
  static block still cannot be, because neither is in the `ClassBoilerplate`
  at all. See §8.1.

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

---

## 9. Every function must enter the output

§11.5 says every function the input contains appears in the output. O1 measures
the other end of that promise and finds it broken on a third of the corpus:
**65 013 of 184 672 functions, 35.20%**, are produced by V8 when it compiles
the original and not when it compiles our text (docs/O1.md §6.3). The count had
not moved under any fix, which is what made it worth attributing before
touching anything: you cannot be equivalent on a function your text never
references.

The mechanism is V8's, measured in self-test F of
`tools/verify/o1_corpus_selftest.mjs` and again here.
`bytecode-generator.cc::VisitFunctionDeclaration:2181` returns at :2187 when
the declaration's variable `is_used()` is false, so an inner function
declaration nothing reads is never visited: no `CreateClosure`, no SFI in the
parent's constant pool, nothing in the serialised cache.
`VisitVariableDeclaration:2135` has the same early return at :2138, but it
guards only the TDZ hole store — V8's parser turns `var f = e` into a
declaration plus an assignment statement, and `VisitAssignment` evaluates the
right-hand side whether or not anything reads `f`. `VisitGlobalDeclarations:2281`
has no such test at all; it `DCHECK`s `var->is_used()` at :2285, because a
top-level binding is observable whether or not the script reads it.

Two consequences for this layer:

1. a `CreateClosure` **in the input is proof the original had a reader** — V8
   would not have emitted it otherwise. A `CreateClosure` whose value reaches
   no statement of ours is therefore a reader *we* lost, not dead code.
2. the **form** of the binding our text uses decides whether the function
   survives a recompilation, and the form is `src/emit/index.mjs`'s choice.

### 9.1 The attribution, before any behaviour change

`tools/probes/probe_closure.mjs fate` classifies every `CreateClosure`
instruction by which branch of the statement pass (§1 step 6) actually decided
it. 29 corpus files, every 37th, profile `14.4.258.16`, 5 313 units, none
failing to recover:

| fate | count | share |
|---|---:|---:|
| `liveUse` — read by something we emit | 3 148 | 59.58% |
| `materialised` — named, so emitted as `let f = …` | 2 134 | 40.39% |
| `droppedByDce` | 2 | 0.04% |
| `droppedNoLiveUse` | 0 | 0.00% |
| **lost** (the last two) | **2** | **0.04%** |

The drop site was real and is not the defect. Both losses are an arrow whose
only user is a `Star` nothing reads again; `opcode_effects.mjs` classifies
`CreateClosure` as an allocation, so `hasEffect` is false, the value is
pure-and-unused, and §4.3 step 1 killed it. **0.04% is not 35.20%**, so the
hypothesis that the readers are lost in this layer is refuted by two orders of
magnitude.

The same run answers the complementary question. Of 5 313 units, 5 284 —
**99.45%** — are named by a `CreateClosure` somewhere in the file, and all 29
that are not are the script units themselves, which `DeclareGlobals` carries
instead. None is deeper than that. So the input really does create every
function it contains, and the loss is downstream of here.

`tools/probes/probe_closure.mjs cause` asks the same question one layer down,
where `src/emit/index.mjs` counts the consequence as `unreferencedClosures`.
25 corpus files, every 43rd, 2 531 units, before the fixes below: **544
children our text declares and nothing references, 21.5% of the functions
emitted**, and the reference went

| where | count | share |
|---|---:|---:|
| `inUnusedExprOnly` — the `{e:'fn'}` is in `exprs` and in no statement | 502 | 92.28% |
| `parentFailed` — the parent emitted no body, so no statement of it was visited | 41 | 7.54% |
| `t7Missing` — no statement and no `exprs` entry mentions it | 1 | 0.18% |

All 23 of the sample's `parentFailed` parents are the refusals of docs/O1.md
§6.8 — an unplaceable context binding, body replaced by a `throw` — and not
units that failed to recover; the sample contains none of those.

By the child's own kind: 384 methods, 101 getters, 59 arrows. The dominant row
is one shape — the closure's user is a `Star` that the `%DefineClass` idiom
claimed, so it emits no statement and §8.1's undecoded `ClassBoilerplate`
leaves `{e:'class'}.members` empty. That `t7Missing` count of 1 is this layer's
share of the whole defect, and it is the same instruction the `fate` table
found.

The 384 methods and 101 getters of that row are §9.6: once the boilerplate is
decoded their `{e:'fn'}` is inside `{e:'class'}.members`, which **is** a
statement, so they are neither unreferenced nor siblings. The 59 arrows are
not — an arrow is never a class member — and they stay.

### 9.2 A function literal nothing reads (step 5b)

Every instruction carrying an `{t:'sfi'}` constant pool entry is collected
before DCE and passed to `dce.mjs` as `cx.extraRoots`, so no function literal
is ever dropped as pure-and-unused. `DeclareGlobals` carries its SFIs inside a
`{t:'array'}` pair list and is deliberately not matched: V8 does not drop a
top-level declaration, and the mint table in §9.4 measures that rather than
assuming it.

Keeping the value alive only moves the problem, because the statement pass has
two branches for a value-producing instruction — name it, or emit it for its
effect — and a pure value with no live use fits neither. So step 5b forces such
a literal to be materialised: `let fn = function …`. That is not a guess, it is
the inverse of the bytecode. The original is `CreateClosure; Star rN` with `rN`
never read again, and a `let` whose initialiser is the closure compiles back to
exactly that pair. It is reported as its own inlining reason,
`forcedByAFunctionLiteralWithNoLiveUse`, and not as `forcedByPattern`, so a
duplication report can tell a pattern's decision from this one.

Refusing the function was the other candidate and it is the wrong trade: a
refusal replaces the body with a `throw`, which un-references every closure the
body created, and docs/O1.md §6.8 measured that cost — 1 483 paired functions
lost to 23 refusals. Repair what the bytecode states; refuse only what it does
not state.

Measured effect, same 29 files: `lost` 2 → **0**, `materialised` 2 134 → 2 136,
`liveUse` unchanged at 3 148. Nothing else in the table moves, which is the
whole claim for the root class.

### 9.3 What is counted and what throws (step 7d)

The drop site produced no statement, no hole and no counter, which is how it
stayed invisible. Two counters now cover every exit:

* **`stats.emit.droppedPureValues`**, with `byDroppedPureOpcode`. The one exit
  from the statement pass that emits nothing: a pure value that some root keeps
  live and nothing reads. Measured **0** across all 5 313 units — the only root
  class that can produce such a value is the function literals, and 5b
  materialises those first, so the branch is now exercised by nothing.
* **`stats.emit.functionLiteralsNotInAnyStatement`**, with
  `byUnplacedFunctionLiteral`. A literal whose `{e:'fn'}` appears in no
  statement cannot reach T9 at all, so T9 emits that function as a sibling
  declaration nothing references and V8 then does not serialise it. **99 of
  5 284, 1.87%** (`node tools/probes/probe_class.mjs emit`); it was 747 =
  14.14% before the `ClassBoilerplate` decode of §8.1:

| reason | count | was |
|---|---:|---:|
| `claimedByAPatternThroughItsUser:class` | **0** | 648 |
| `readByAValueWithNoStatement:DefineNamedOwnProperty` | 54 | 54 |
| `readByAValueWithNoStatement:CallProperty1` | 25 | 25 |
| `readByAValueWithNoStatement:CallUndefinedReceiver2` | 7 | 7 |
| `readByAValueWithNoStatement:CallUndefinedReceiver1` | 7 | 7 |
| `readByAValueWithNoStatement:CallUndefinedReceiver` | 6 | 6 |
| everything else | 0 | 0 |

The whole of the 648 is the `class` row and it is now zero, which is the one
number this section is for: the member closures are in a statement because
`{e:'class'}.members` mentions them. Nothing else in the table moved, which is
the check that the change is the one described and not a side effect.

The reason decides whether the literal is counted or the function is refused,
and the split is a closed set, `UNPLACED_LITERAL_DECLARED_GAPS`:

* **counted** — `claimedByAPattern`, `claimedByAPatternThroughItsUser` and
  `readByAValueWithNoStatement`. Each is a gap this layer already declares
  somewhere else and marks with its own hole, so the output does say "I don't
  know" where the function went. The `class` row used to be §8.1's undecoded
  `ClassBoilerplate` and is now empty — the member closures reach a statement
  through `{e:'class'}.members`, and `claimedByAPattern:class` stays in the
  declared set only for the shapes §8.1 still refuses. The
  `readByAValueWithNoStatement` rows are a literal whose only reader
  transcribes to a hole —
  `ownPropertyDefinitionNotFoldedIntoItsLiteral` for the `Define*OwnProperty`
  row (§6). Refusing them would delete every class in the corpus to report a
  gap that is already reported. The fourth,
  `inABlockTheStatementPassDoesNotVisit`, is the statement pass's own
  contract: it walks `dominators.rpo`, so an instruction in a block nothing
  reaches is never visited. It costs the function all the same, which is why
  it is counted separately rather than folded into the others; nothing in the
  sample reaches it either.
* **refused** — anything else, by `throw new RecoverError`, unconditionally
  rather than under `opts.strict`. `noLiveUse`,
  `materialisedButItsStatementIsMissing` and `instructionDefinesNoValue` are
  not declared gaps; they are inconsistencies in this layer's own analysis.
  `noLiveUse` in particular is what the drop site used to produce silently, so
  reaching 7d with it means 5b did not hold. Nothing in the sample reaches any
  of them, which is the point: an assertion that costs nothing today and fires
  the moment the analysis breaks, instead of a function quietly leaving the
  output.

Every unplaced literal also raises a `functionLiteralNotInAnyStatement`
warning carrying the offset, the SFI and the reason, whether it throws or not.

### 9.4 The binding form, which is where the 35.20% is

A child nothing in the body references is declared by
`src/emit/index.mjs::emitUnitInner`'s prologue, and until now it was declared
as `function f(){}` — the one form V8 drops. `tools/probes/probe_closure.mjs
form` mints 100 unreferenced functions per script with the corpus's own V8 and
`--no-lazy`, one spelling per row, and counts the units that come back with
bytecode:

| carried / expected | shape |
|---:|---|
| 2 / 102 | in a function: `function h(){}` |
| 2 / 102 | in a function: `function* h(){}` |
| 102 / 102 | in a function: `var h = function h(){}` |
| 102 / 102 | in a function, strict: `var h = function h(){}` |
| 102 / 102 | in a function: `let h = function h(){}` |
| 102 / 102 | in a function: `var h = function* h(){}` |
| 102 / 102 | in a function: `var h = async function h(){}` |
| 102 / 102 | in a function: `var h = (a)=>a` |
| 102 / 102 | in a function: `function h(){}` + one reference |
| 101 / 101 | top level: `function h(){}` |
| 101 / 101 | top level: `var h = function h(){}` |
| 101 / 101 | top level, strict: `function h(){}` |
| 101 / 101 | in a block at top level: `function h(){}` |

So the fix is the form: an unreferenced child is emitted as
`var f = function f(){}` instead of `function f(){}`. The body, the name, the
position and the generator/async flags are untouched, the inner name keeps
recursion legal, and the child's emitted name is already uniquified against
every declaration, parameter and visible binding of the parent, so the `var`
cannot collide. An arrow child was already emitted as `var f = () => {}` and so
was never really lost; this gives every other unreferenced child the same
protection.

Two cases keep the plain declaration, each with its own counter, because
rebinding them would make things worse rather than better:

* `unreferencedClosuresAtTheTopLevel` — a child of the script unit. The last
  four rows of the table measure it: a top-level declaration is carried either
  way, so rebinding would only move the script's own bytecode away from the
  original. (A module top level is the one place that does skip them,
  `VisitModuleDeclarations:2258` at :2262; nothing here emits a module.)
* `unreferencedClosuresNotInTheInput` — a child with no bytecode in the input.
  Stream A does not contain it, so forcing V8 to compile it would manufacture a
  function with no partner, which docs/O1.md §4 reads as a defect of its own.

On the 25-file sample: 543 unreferenced children, **485 rebound**, 58 already
bound (the arrows), 0 at the top level, 0 absent from the input. 485 of 2 531
functions emitted, **19.2%**, go from a form V8 discards to one it keeps.

### 9.5 Measured on the corpus

Both runs are the sharded O1 scan over all 1039 files
(`gh workflow run scan.yml -f layer=o1 -f shards=12`), one on `main` and one on
this branch, nothing executed either time.

| | `main` | this branch |
|---|---:|---:|
| functions in stream A that reached a comparison | 184 672 | 184 672 |
| functions in stream B (our text, recompiled) | 119 659 | **184 672** |
| **paired** | 119 659 | **184 672** |
| **A-side unpaired** (V8 makes it, our text does not) | 65 013 = 35.2046% | **0 = 0.0000%** |
| **B-side unpaired** (we emit one V8 does not) | 0 | **0** |
| **exactly equal** | 18 006 | **33 516** |
| exactly equal, share of paired | 15.0478% | **18.1489%** |
| exactly equal, share of all of V8's functions | 9.7502% | **18.1489%** |
| mean opcode similarity | 0.770205 | 0.780057 |
| mean whole-instruction similarity | 0.502109 | 0.519185 |
| holes our emitter marked | 105 319 | 105 319 |

The A-side count goes to **zero**: stream B now contains exactly the 184 672
functions stream A does, and both unpaired counts are 0, so the correspondence
is total in both directions. The exact count rose by 15 510 and the exact
*rate* rose with it, which is the unusual direction — 65 013 functions arrived
as new pairs and, rather than diluting the rate, lifted it. How the +15 510
splits between a newly paired function that is equivalent and a parent that
became equivalent by regaining the `CreateClosure` it was missing is not
measured: the scan reports neither, and both are the same fix. Read on the
identity-by-construction mode alone, where the pairing needs no caveat
(docs/O1.md §4), `sfi` pairs go 114 950 → 179 961 and `sfi` exacts
17 961 → 33 207, 15.6251% → 18.4523%: the headline is not carried by the weak
pairing modes. Holes are unchanged, as they should be — this changes the form
of a binding, not what the emitter is willing to guess.

§9.4's 19.2% counts the bindings this layer rewrote; 35.20% is the share of
V8's functions that came back. The two are not the same number because of the
cascade: a function V8 does not create cannot create its own children either,
so one unreferenced declaration costs its whole subtree, and rewriting the
binding at every level at once recovers more functions than it rewrites
bindings.

### 9.6 What this did not fix, and what closed it

The 648-strong `claimedByAPatternThroughItsUser:class` row was the largest
remaining block and it was not a closure-scoping problem at all: it was §8.1's
`ClassBoilerplate`. A class method was emitted as a sibling declaration rather
than as a member of its class body, and the binding form of §9.4 is what kept
it in the output at all — but a method that has to be read off
`class C { m(){} }` was a decoding gap in `src/heap`.

**That gap is closed.** `src/heap` decodes the boilerplate
(docs/FRONTEND.md §4.2a), `patterns/classes.mjs` joins each entry's argument
index to `args[i]`, and `src/emit/index.mjs::resolveClass` places the result in
the class body. On the same 29-file sample
(`node tools/probes/probe_class.mjs`):

| | before | after |
|---|---:|---:|
| `{e:'class'}` nodes with a member list | 0 of 82 | **82 of 82** |
| members carried into `{e:'class'}.members` | 0 | **648** |
| class body members `src/emit` placed (`classMembersPlaced`) | 82 | **730** |
| `classMembersNotDecoded` holes | 82 | **0** |
| function literals in no statement (§9.3's table) | 747 = 14.14% | **99 = 1.87%** |
| dynamic arguments no template describes | — | **0** |

The first four "before" figures are structural rather than re-measured:
`defineClass` set `members: []` unconditionally, so every one of the 82 classes
took the `classMembersNotDecoded` branch and `resolveClass` placed its
constructor and nothing else. The function-literal row is a real before/after on
the same 29 files, because §9.3's table was measured on exactly this sample.

`classMembersPlaced` counts 730 rather than 648 because `resolveClass` already
inlined the constructor; what is new is the other 648. The emit report's
`unreferencedClosures` fell too — a method is no longer a sibling declaration
nothing references — but §9.4's 543 was measured on a different sample (25
files, every 43rd), so the two are not a before/after pair; the corpus run is.

Three things this still does not fix, all of them §8.1's and all of them
measured at 0 in the sample, so the corpus-wide count is the number to read
rather than a known quantity: a dictionary-shaped properties or elements
template, `accessor x`, and a class FIELD — which is not an undecoded part of
the boilerplate but an absent one, because `ClassBoilerplate::New:769`
`continue`s on `ClassLiteral::Property::FIELD` before it writes any template.

### 9.7 On the corpus: the shape is right, and the cost was not the class

Both runs are the sharded O1 scan over all 1039 files
(`gh workflow run scan.yml -f layer=o1 -f shards=12`), nothing executed either
time: `main` at `300c1be` — both §9.6's change and `literal-order` merged — as
run `42018138145`, against this branch as run `42021949756`. They are one
baseline and one head of the same scan; the two columns an earlier draft of
this section carried came from separate single-branch runs and do not subtract.

| | `main` @ `300c1be` | this branch |
|---|---:|---:|
| files `ok` / `decompile-timeout` / `output-does-not-compile` | 1035 / 3 / 1 | 1035 / 3 / 1 |
| functions in stream A that reached a comparison | 184 672 | 184 672 |
| **paired** | 184 672 | 184 672 |
| **A-side unpaired** | **0** | **0** |
| **B-side unpaired** | **0** | **0** |
| `sfi` pairs (identity by construction) | 179 943 | 179 943 |
| **exactly equal** | **32 830 = 17.7775%** | **33 596 = 18.1923%** |
| exactly equal, `sfi` mode alone | 32 501 | 33 267 |
| mean opcode similarity | 0.776664 | 0.782407 |
| mean whole-instruction similarity | 0.518320 | 0.519905 |
| instructions in stream B | 11 444 351 | 11 430 826 |
| **holes our emitter marked** | 100 317 | 100 317 |
| `load-form` | 13 905 | **6 169** |
| its top row, `LdaImmutableCurrentContextSlot → LdaImmutableContextSlot` | 5 831 | **60** |
| the same row with register moves, `(+1/+2/+3 move)` | 2 312 | **0** |
| `extra-context-push` | 1 345 | **268** |

The exact count **rises by 766** and the rate rises with it; holes do not move,
both unpaired counts stay at 0, and the status counts are identical file for
file. 33 596 is 80 above 33 516 — the highest this measurement had ever read,
`literal-order` alone — and 133 above the 33 463 of `main` before either
branch. So §9.6's 5 002 holes are kept and the 686 exact matches the class body
cost are paid back with interest.

#### The 686 was never the class body. It was the language mode.

A class body is strict code: `ClassScope::ClassScope:195` calls
`set_language_mode(LanguageMode::kStrict)` at :199, unconditionally.
`Scope::ForceContextForLanguageMode` (`scopes.h:423`) returns false only for a
FUNCTION_SCOPE or a script scope and otherwise answers
`language_mode() > outer_scope_->language_mode()`; a class scope is neither
(`Scope::is_class_scope:375`). `Scope::AllocateVariablesRecursively`
(`scopes.cc:2621`) folds that into `must_have_context` at :2646/:2651, which
suppresses the `num_heap_slots_ = 0` shortcut at :2662, so `NeedsContext()`
(`scopes.h:434`) is true. `BytecodeGenerator::VisitClassLiteral:3836` then
takes its :3838 branch and emits `BuildNewLocalBlockContext` at :3852.

**A class body in sloppy text therefore sits behind a context that the same
class body in strict text does not**, and every slot a member captures from an
enclosing scope is read one `PREVIOUS_INDEX` hop further out. Minted both ways
with the corpus's own V8 (`.v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe`,
`--no-lazy --print-bytecode`), the same two function bodies capturing the same
variable, differing only in the directive at the top of the file:

| enclosing code | the body as a class member | the same body as a sibling |
|---|---|---|
| sloppy | `LdaImmutableContextSlot <context>, [2], [1]` | `LdaImmutableCurrentContextSlot [2]` |
| strict | `LdaImmutableCurrentContextSlot [2]` | `LdaImmutableCurrentContextSlot [2]` |

Nothing about the class decides it. §9.6 did not cause this row; it made it
visible, by moving 648 functions into the one position where an interposed
context can be seen. `tools/probes/probe_class.mjs context` counts the rest of
the exposure on §9.6's own 29-file sample: **5 135 of 5 313 units are `kStrict`
in the original** and this layer emitted all 5 313 as sloppy; all 72 classes
that carry a member sit in a `kStrict` holder; and **296 of the 648 members
read a slot of an enclosing context**, which is the set that pays.

#### What the earlier account got wrong, and why

The paragraph this replaces said a minimal mint did not reproduce the
interposed context, and treated that as grounds for looking elsewhere. It does
reproduce. **The probe that said otherwise was run with `node <file>.js`
instead of through a minter, and this repository declares `"type": "module"`,
so its file was loaded as an ES MODULE — and a module body is strict code.**
The harness had silently set the one variable under test. Re-minted with
d8 14.4.258.17, which compiles a `.js` file as a script, that probe's own file
reproduces on the first try: `probeInside` (anonymous class) and `probeNamed`
(named class) both read `LdaImmutableContextSlot <context>, [2], [1]`, while
`probeBeside` — the same body as a sibling — reads
`LdaImmutableCurrentContextSlot [2]`.

The control is one engine and one source, differing only in how the file is
loaded. Under `node`'s own V8 (14.6.202.34), the same file as `.js` under
`"type": "module"` reads the shallow form for both classes and as `.cjs` reads
the deep form for both. So the mechanism also holds in a second V8 version —
`Scope::ForceContextForLanguageMode` is `scopes.h:433` there, unchanged — and
the earlier refutation was not an engine difference but a language-mode
difference in the probe itself. docs/O1.md §1's rule that anything minted is
minted with the corpus's own V8 would have caught it either way: the minter
compiles a script, which is what the corpus is.

One row of that probe survives the correction and is worth keeping:
`probeUsesOwnName`, a method that reads the class's own name binding, reads the
DEEP form in strict code too, in both engines. That is the hazard
`src/emit/index.mjs::classId` guards against, and it is why the id is kept off
every spelling a member uses even though it is not what cost the 686.

Three hypotheses are refuted rather than untested:

* **The class's own name.** `src/emit/index.mjs::classId` keeps the id off
  every spelling a member uses, and that is worth keeping, but it is not this:
  under 14.4 a named and an anonymous class interpose the same context, and
  §9.7's named repro is anonymous — `fn$8 = class extends r$3.Vue`, with no
  `super` property access, no private name, no computed key and no static
  member anywhere in its body.
* **Placement in a block of its own.** The class expression is emitted at
  exactly the statement position, and the same nesting depth, that
  `var get_isInMacAudit = function …` occupied before it.
* **`src/emit/scopes.mjs`'s frame ownership.** The binding is the same binding:
  the same `scopeInfoId`, the same `localIndex`, the same owner, the same
  spelling, and no refusal moved. Only the DEPTH the emitted text implies
  changed, which is not a property of the plan.

#### The fix: emit the language mode the input states

Every ScopeInfo carries it and `src/heap/objects.mjs:197` already decodes it
(the frontend self-test pins the enum, `C++ LanguageMode = {kSloppy: 0,
kStrict: 1}`, because Torque's declaration order is the other way round). This
layer discarded it. It now emits `'use strict'` on a function iff that
function's own ScopeInfo says `kStrict` and no emitted ancestor already has.

Strictness is inherited in the original by construction — a parser cannot put
a sloppy scope inside a strict one — so one directive at the outermost strict
unit reproduces the mode for its whole subtree. That is measured, not assumed:
`unitsSloppyUnderAStrictAncestor` counts every unit our emitted nesting would
make strict that the original compiled sloppy, and it is **0** over the
sample's 5 313 units. The one thing that can refuse the directive is V8's own
syntax — a directive prologue is illegal in a function with a non-simple
parameter list, and the only non-simple form this layer emits is a rest
parameter — counted as `strictDirectivesNotExpressible`, **0** of the sample's
193 strictness roots.

On `r_4672.jsc`, this section's named repro: 168 of 171 units are strict, 8
directives carry them, and `get isInMacAudit` goes from
`LdaImmutableContextSlot <context> [11] [1]` to
`LdaImmutableCurrentContextSlot [11]` — instruction for instruction the
bytecode `main` produced for the SIBLING form, verified by minting `main`'s own
text. On the 36-file local sample the loss closes exactly: 578 → **605** exact
against a pre-§9.6 baseline of 604, `r_4672.jsc` 26 → **39**, which is the 39
it had before §9.6, and holes unchanged at 1 830.

#### What this does not close

* **1 073 functions still disagree about a context, in the other direction.**
  60 of the 5 831 keep the original row, and
  `LdaImmutableContextSlot → LdaImmutableCurrentContextSlot` — the original
  deeper than us — grows 711 → 1 013. A class scope can need a context for
  reasons of its own, a private brand among them
  (`ClassScope::ClassScope:210` reads `ScopeInfo::ClassScopeHasPrivateBrand`),
  and this layer emits no private names at all. Not measured further here.
* **The families that grew are reclassification, not regression.** Only a
  function's first hunk is independent (docs/O1.md §7.3), so a function whose
  first divergence WAS the depth row now reports whatever came next:
  `operand-value` +2 662, `extra-temp-materialisation` +2 302, `call-form`
  +1 752 against `load-form` −7 736, `replaced-block` −1 728,
  `extra-context-push` −1 077 and `undefined-for-a-value` −621. The net on the
  one number that is not a classification is +766 exact and −13 525
  instructions emitted.
* **The repro's slot INDEX is a different defect.** Stream A reads
  `LdaImmutableCurrentContextSlot [13]` where we read `[11]`, before this
  change and after it, and in `main`'s sibling form too — so
  `get isInMacAudit` was not an exact match before §9.6 either. Our emitted
  context layout for that scope is two slots short of the original's; nothing
  here touches it.

Two defects were found and fixed on the way, both of which this measurement is
what caught:

* **`async` and `*` were dropped from a member**, which puts `await` inside a
  non-async method — a `SyntaxError` that costs the whole file. 4 of a 20-file
  sample stopped compiling; now 0 (docs/EMIT.md §9 gap 2).
* **the pairing name**: the first run of §9.6's branch left 15 863 functions in
  the weaker `name` mode because `emitName` still held the sibling spelling.
  Restoring the member's own name put them back into `sfi` and moved the exact
  total by nothing, which is how that run established the loss was not a
  pairing artefact.
