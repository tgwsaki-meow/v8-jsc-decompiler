# O1 — the V8 bytecode oracle

The only instrument in this project that can answer *"is the decompiled JS the
same program as the `.jsc`?"* with a number.

```
original .jsc ──our decoder──────────────────────────────→ bytecode stream A
              └─our decompiler─→ JS' ──real V8 --print-bytecode──→ stream B
                              normalise, then compare A vs B
```

## Files

| file | role |
|---|---|
| `oracle.mjs` | public API + CLI (`dump`, `compare`, `engines`) |
| `bytecode_parser.mjs` | `--print-bytecode` text → structured per-function form |
| `normalize.mjs` | erases incidental differences; **the erasure contract is documented in the file header** |
| `compare.mjs` | per-function similarity + first divergence |
| `../../tools/oracle/engines.mjs` | engine-pluggable runner (`node` or any `d8`) |
| `../../tools/oracle/selftest.mjs` | the self-test (A–E below) |
| `../../tools/oracle/snippets.mjs` | the snippet corpus and the equal/unequal pairs |

## CLI

```
node src/verify/oracle.mjs engines .v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe
node src/verify/oracle.mjs dump    --engine node --file a.js --filter f --json out.json
node src/verify/oracle.mjs compare --engine .v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe \
                                   --left a.js --right b.js --filter f
node src/verify/oracle.mjs compare --engine node \
     --right-engine .v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe --left a.js --right a.js
```

Flags passed to the engine are `--print-bytecode --no-lazy
--no-enable-lazy-source-positions`. The last one matters: without it V8 builds
the source position table lazily and the listing has no `NN S>` markers at all.

Output is always captured through a file, never a pipe.

## Structured form

```js
{ name, bytecodeLength, parameterCount, registerCount, frameSize,
  instructions: [{ offset, opcode, scale, bytes, operands,
                   sourcePosition, isStatement, isExpression, isBreakable,
                   jumpTarget, jumpTable, raw }],
  constantPool: [{ index, value } | null],
  constantPoolSize, constantPoolResolution: 'dumped' | 'partial',
  handlerTable: [{ from, to, handler, prediction, data }],
  handlerTableSize, sourcePositionTableSize }
```

`constantPoolResolution` is `'partial'` on a release `d8`, which prints the pool
size but not its contents; the pool is then reconstructed from the inline
`[index:value]` annotations, which cover every constant an instruction actually
names. Same for the handler table: a release `d8` prints `Handler Table
(size = N)` without the rows, so the comparator falls back to comparing N.

## What the normaliser erases

Summarised here; the full argument for each is in the header of
`normalize.mjs`.

| erased | replaced by | why it is incidental |
|---|---|---|
| local register numbers | first-appearance identity classes `R0, R1, …` | frame slot indices shift when an unrelated earlier expression changes; only the def/use relation is semantic |
| feedback vector slot indices | `FB[*]` | a running counter over preceding feedback-consuming ops |
| constant pool indices | the resolved value `K(…)` | pool position is emission order; the value is the semantics |
| heap addresses inside constants | stripped, descriptor kept | per-run allocation artifact |
| absolute jump offsets | labels `->L0`, with `L0:` on the target | byte distances move with instruction width; the engine's own resolved target gives the real edge |
| `.Wide` / `.ExtraWide` prefixes | dropped | a width artifact of the four values above |
| `Star0` … `Star15` | rewritten to `Star` + a synthetic register operand | `SHORT_STAR_BYTECODE_LIST` encodes the register in the *opcode*; without this a register-allocation shift would change the opcode and defeat the register rule, and the long form `Star r0` would never match the short form of the same operation |
| source positions | excluded from the stream, kept in the structured form | character offsets into the source text; renaming a variable shifts them all |
| raw bytes and addresses | excluded from the stream | they encode exactly the erased values |

Kept: opcode, operand arity and kind order, parameter register indices
(`a0` ≠ `a1` is semantics), `<context>`/`<closure>`/`<this>`/`<new.target>`,
register-range lengths, flag immediates (`#29`), non-jump immediates
(`LdaSmi [1]`), runtime/intrinsic callee names, handler ranges mapped to
instruction indices.

Deliberate cross-version consequence: V8 14.4 prints `FBV[n]` and 14.6 prints
`EmbeddedFeedback[0xN]` for the six comparison bytecodes; both normalise to
`FB[*]` so that a 14.4 stream and a 14.6 stream of the same source compare
equal. The price is that a normalised stream says nothing about encoded
instruction length across versions — read `bytes` from the structured form for
that.

## Self-test

`node tools/oracle/selftest.mjs [<path-to-d8> …]`

| check | assertion |
|---|---|
| **A** round trip | every printed instruction re-renders from the parsed structure alone; 0 operands may fall through to `kind: 'other'`; 0 listing lines may go unrecognised |
| **B** rename invariance | sources differing only in identifier names normalise to **equal** streams |
| **C** discrimination | structurally different programs normalise to **unequal** streams (without C, a comparator that always says "match" would pass B) |
| **D** identity | every snippet compares exactly equal to itself |
| **E** cross-engine | informational: 14.4 `d8` vs 14.6 `node` on the same source |

Latest run (18 snippets, both engines): A/B/C/D all pass with 476 instructions
parsed per engine and 0 mismatches; E is 16/18, and the two residuals are known
V8 differences, not normaliser gaps — see `scratch/t2/O1_SELFTEST.md`.
