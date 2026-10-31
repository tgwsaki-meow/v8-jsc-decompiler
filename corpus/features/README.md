# `corpus/features/` — the syntax-feature corpus

270 small, single-purpose JavaScript files, one syntactic feature each, plus
`manifest.json`. This is the verification corpus for O1/O2/O3 and the input for
mining bytecode patterns (ARCHITECTURE.md §4.3: a fixed V8 version turns
"snippet ↔ bytecode shape" into a mechanical table).

These are **our own files**. They are the only JavaScript in this project that
is ever executed — see the execution policy below.

## Manifest

`manifest.json` carries one entry per file:

```json
{ "id": "try-finally-break",
  "feature": "break inside finally, out of the enclosing loop",
  "file": "corpus/features/try-finally-break.js",
  "sloppyOrStrict": "sloppy",
  "scriptOrModule": "script",
  "notes": "token register + dispatch shape",
  "group": "try", "deps": [], "behavioural": true, "heavy": false,
  "bytes": 512, "sha256": "…" }
```

`deps` lists sibling files an entry imports (only the `mod-*` module entries
have any). `behavioural` means O3 may execute it. `heavy` marks the one file
that is large on purpose, which `--quick` samples skip. `sha256` lets
`corpus/check.mjs` detect a file edited without regenerating the manifest.

## Conventions

* **One feature per file.** A file exercises its feature and nothing else.
* **The sandbox supplies `T(label, ...values)`.** That call is the observable
  trace O3 compares. Nothing else is assumed about the global object, so the
  same file still compiles standalone under `d8` or `node` for O1, where `T` is
  simply undefined at run time — the bytecode has already been printed by then.
* **Deterministic.** No `Date.now`, no `Math.random`, no I/O, no host objects.
* **Independent.** The only cross-file dependency is `mod-dep.mjs`, which
  exists to be imported by the `mod-import-*` entries.
* `.js` is a sloppy classic script unless the header says strict (in which case
  the file starts with `'use strict'`); `.mjs` is a module.

## Regenerating

The files are generated from one spec table so that families of near-identical
files (every compound assignment, every regex flag) are declared once:

```powershell
node scratch/t3/gen_corpus.mjs           # write corpus/features/ + manifest.json
node scratch/t3/gen_corpus.mjs --check   # fail if anything on disk differs
node corpus/check.mjs                    # parse + compile + trace every entry
```

`corpus/check.mjs` is the gate: it checks the manifest against the directory,
parses every file with the `sourceType` the manifest claims, compiles every
file to a `.jsc` with the same minter O1/O2 use, and runs every behavioural
file to confirm it produces a non-empty trace and does not throw out of its own
body (a file that throws early cannot discriminate anything).

## What is covered

| group | files | covers |
|---|---:|---|
| `operator` | 55 | one file per operator: `+ - * / % **`, unary `+ - ~ !`, `& \| ^ << >> >>>`, `< > <= >= == != === !==`, `in`, `instanceof`, `typeof`, `delete`, `void`, comma, `??`, `&&`, `\|\|`, `?:`, `++`/`--` prefix and postfix on locals and properties, all twelve arithmetic/bitwise compound assignments, `&&= \|\|= ??=`, plain and chained `=` |
| `declaration` | 7 | `var` hoisting and redeclaration, `let`, `const` (assignment is a runtime `TypeError`), `let`/`const` TDZ, per-iteration `let` binding captured by closures |
| `loop` | 12 | `while`, `do-while`, 3-clause `for`, `for(;;)` and `for(;test;)`, `for-in` (own/inherited/array/`let`/property target), `for-of` (array, string, `Set`, empty, early `break` → `IteratorClose`, destructuring head), nested, `continue`, `for await-of` |
| `label` | 6 | labeled `break`, labeled `continue`, two- and three-level labeled jumps, `break` out of a labeled block, labeled `break` out of a `switch` inside a loop |
| `switch` | 9 | dense (jump table), sparse, fallthrough, `default` in the middle, empty body and empty case, string cases, no `default`, inside a loop with `break`/`continue`, side-effecting discriminant and case expressions |
| `try` | 18 | every combination of `try`/`catch`/`finally`, optional catch binding, destructuring catch binding, nested with rethrow, **`return`/`break`/`continue`/labeled `break` inside `finally`** (the token-register + `SwitchOnSmiNoFeedback` dispatch shape), nested `finally` returns, `finally` that throws, `try` in a loop, catch-parameter shadowing, non-`Error` throws, strict mode |
| `function` | 18 | declaration and hoisting, anonymous and named expressions, arrows with and without block bodies, lexical `this`/`arguments`, default parameters (including a side-effecting default), rest, mapped and unmapped `arguments`, IIFE (function, arrow), closures, closure capture across four depths, direct and mutual recursion, object-literal accessors, `call`/`apply`/`bind`, constructor functions |
| `destructuring` | 12 | array, elisions, object with renaming, nested, defaults, array rest, object rest, parameter position, assignment form without a declaration (including a member-expression target), swap, computed key, non-array iterables and the non-iterable `TypeError` |
| `class` | 18 | methods, static methods and fields, getters/setters, computed keys, instance fields and initialiser order, private fields, private methods and accessors, private statics, `#x in obj`, static blocks, `extends` + `super()`, `super.x` and `super["x"]`, implicit derived constructor, `this` before `super()`, class expressions (named and anonymous), `extends` an expression, `super` in a static method, implicit strictness |
| `generator` | 7 | basic, `next(v)` into `yield`, `yield*` delegation, `.return()`/`.throw()`, generator methods in classes and object literals, `yield` inside `try`/`finally`, `[Symbol.iterator]` generator |
| `async` | 10 | `async function`, await chains, async arrows, async generators, `for await`, `await` in `try`/`catch`/`finally`, rejection handling, `await` in loops, async IIFE, async methods, `Promise.all`/`race`/`allSettled` |
| `template` | 6 | substitutions, nesting, multiline and escapes, tagged templates (with call-site caching), `raw` strings, member-expression tag |
| `regex` | 12 | no flags and one file per flag (`d g i m s u y`), a combination file covering `gi gim gimsy gimsuy dgimsy v gv`, named groups and backreferences, slash/class/escape-heavy sources vs division, `replace` with a callback |
| `literal` | 11 | shorthand, computed keys (with evaluation order), spread, accessors, `__proto__` (literal vs computed), numeric/string/BigInt keys, deep nesting, duplicate keys, arrays, sparse arrays with holes, trailing commas |
| `spread` | 4 | calls, array literals, `new`, rest→spread forwarding |
| `optional-chain` | 6 | property, call, computed, whole-chain short-circuit, `delete`, mixed with `??`/`&&` |
| `dynamic-scope` | 5 | `with`, `with` shadowing, direct `eval` (including introducing a binding), indirect `eval`, `eval` in strict mode |
| `accessor` | 3 | `Object.defineProperty` getter/setter and a non-writable property, `defineProperty` on a class prototype, inherited accessor receivers |
| `new-target` | 3 | in a function, in constructors across `extends` and via `Reflect.construct`, lexical in arrows |
| `numeric` | 3 | BigInt literals and operators, numeric separators and every radix, `globalThis` |
| `scale` | 5 | 90 context-allocated locals (past `kScopeInfoMaxInlinedLocalNamesSize = 75`, forcing the `ScopeInfo` hashtable), 300 live stack locals (`.Wide` register operands), 66 000 feedback slots (`.ExtraWide` operands), 200 parameters, deep block and closure nesting |
| `module` | 14 | every `export` form, default (declaration and expression), default+named and default+namespace imports, namespace import, bare import, re-export (named, renamed, `*`, `* as`, default), dynamic `import()`, top-level `await`, `import.meta`, module scope |
| `mode` | 4 | whole-script strict, function-level `"use strict"` inside a sloppy script, `this` coercion, Annex B block-scoped function declarations |
| `flat` | 22 | the same features again — `while`, `do-while`, `for`, nested loops, labeled `break`, `for-in`, `for-of`, `if`/`else if`, `try`/`catch`, `try`/`finally`, `try` in a loop, dense `switch`, fallthrough `switch`, `&&`/`\|\|`/`??`/`?.`, destructuring, object mutation in place, templates, string builtins, `typeof`/`delete`/`void`/`in`/`instanceof`, top-level `let`/`const` vs `var`, strict mode — **in top-level code, with no function literal anywhere in the file** |

256 scripts and 14 modules; 251 sloppy and 19 strict.

The `flat` group earns its place twice. Top-level control flow is a real shape
(webpack chunks are mostly top-level code, and top-level `let`/`const` live in
the script context, which is a different slot path from `var`). And a script
with no function literal has exactly one `BytecodeArray`, which is the only
shape the pipeline under test can currently read at all — see
`scratch/t3/FINDINGS.md` §1. Without it, metric 4 has no measurable entry.

Two choices worth stating:

* **"every regex flag combination"** is interpreted as one file per flag plus a
  representative combination file. All 2⁸ combinations would be 256 files
  testing the same lexer path, and `u`/`v` are mutually exclusive anyway.
* **`.ExtraWide`** needed measuring rather than guessing. A body of 9 000,
  20 000 or 30 000 statements reaches 210 KB of bytecode with no ExtraWide
  operand at all, because a jump whose delta does not fit takes the
  `Jump*Constant` form — the delta moves into the constant pool instead of
  widening the operand. The scalable operand that does grow without bound is
  the feedback slot index, so the trigger is "more than 65 535
  feedback-consuming operations in one function". 66 000 is the smallest round
  number past it and yields 464 `AddSmi.ExtraWide [1], FBV[65536+]`
  (`scratch/t3/probe_extrawide2.mjs`). That file is ~390 KB, which is why it is
  marked `heavy`.

## Execution policy

`corpus/features/**` and the decompiler's output for those files (in
`scratch/t3/work/`) are the only code this project executes. `extracted_jsc/`
and `decompiled_js/` are reverse-engineered third-party code from a chat
client: they are read, parsed, disassembled and compared, never run. The rule
is enforced by `assertExecutable()` in `src/verify/corpus.mjs`, re-checked
inside the O3 child, and covered by a self-check that asserts a path under
`decompiled_js/` is refused.
