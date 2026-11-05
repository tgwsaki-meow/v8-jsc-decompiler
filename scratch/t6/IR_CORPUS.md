# src/ir corpus scan

corpus          : extracted_jsc/  1039 .jsc files
profile         : profiles/14.4.258.16
exception model : instruction
node            : v26.12.1, 2 job(s), child heap 1400 MB
wall time       : 1673.5 s for the files run this pass  (child CPU total 2670.1 s)

## totals

| metric | value |
|---|---:|
| files read | 1039 / 1039 |
| files that failed | 0 |
| functions (SharedFunctionInfo) | 239979 |
| functions with bytecode | 239979 |
| **functions whose IR failed to build** | **0** |
| instructions | 10883604 |
| basic blocks | 1577930 |
| blocks reachable from the entry | 1577930 (100.0000%) |
| **unreachable blocks** | **0** |
| edges | 2107268 |
| SSA values | 14373569 |
| phi nodes | 241477 |
| max phi arity | 896 |
| projections (secondary outputs) | 149378 |
| CaughtException definitions | 25189 |
| effect-chain ops | 3589606 |
| effect phis | 259753 |
| ops with hasEffect | 3464196 |
| ops with allocatesIdentity | 2608950 |
| loops | 18201 |
| back edges | 18201 |
| retreating edges | 18364 |
| **functions with an irreducible back edge** | **121** of 239979 |
| **irreducible back edges** | **163** |
| endless loops (no exit edge) | 0 |
| loops with more than one latch | 0 |
| loops with more than one exit | 6973 |
| virtual exit edges invented for post-dominance | 0 |
| handler ranges | 25189 |
| handler blocks | 25189 |
| exception edges | 441578 |
| ranges with no throwing instruction (degenerate edge added) | 51 |
| inner handlers NOT covered by their enclosing range | 0 |
| handler live-ins written by a throwing terminator (model imprecision) | 11 |
| functions where the accumulator is live-in at a handler | 0 |
| uses of a clobbered accumulator | 0 |
| switch successor edges | 23242 |
| jump tables: generator dispatchers | 10068 |
| jump tables: SwitchOnSmiNoFeedback | 1140 |
| context slot ops | 980989 |
| **context slot ops resolved to a name** | **968489** (98.726%) |
| context frames | 322508 |
| functions the brute-force oracles were run on | 2958 |

Context header length source: derived from the 2 Slot<Context,...> members of contexts.tq's ContextSlot enum (SCOPE_INFO_INDEX, PREVIOUS_INDEX) plus the extension slot

## invariants

| invariant | result | violations | items checked | functions affected |
|---|---|---:|---:|---:|
| every block is reachable from the entry | PASS | 0 | 1577930 | 0 |
| every edge has endpoints that exist and the adjacency lists agree | PASS | 0 | 2107268 | 0 |
| every SSA use is dominated by its definition | PASS | 0 | 14373569 | 0 |
| every phi operand is available at the matching predecessor's exit | PASS | 0 | 241477 | 0 |
| phi arity equals the predecessor count, in predecessor order | PASS | 0 | 241477 | 0 |
| every variable use has exactly one reaching definition, for the right variable | PASS | 0 | 14373569 | 0 |
| every back edge's target dominates its source | PASS | 0 | 18201 | 0 |
| the loop nesting forest is a forest and every header dominates its body | PASS | 0 | 18201 | 0 |
| ipdom is a tree rooted at the virtual exit | PASS | 0 | 1577930 | 0 |
| every jump-table target is a block leader | PASS | 0 | 23242 | 0 |
| every protected range has a handler block and at least one exception edge | PASS | 0 | 25189 | 0 |
| every back edge comes from the backward branch opcode | PASS | 0 | 18201 | 0 |
| every reachable JumpLoop produces exactly one classified edge | PASS | 0 | 18590 | 0 |
| switch successor count equals the decoded jump-table entry count | PASS | 0 | 23242 | 0 |
| the accumulator is dead at every handler entry | PASS | 0 | 25189 | 0 |
| idom agrees with the brute-force dominator oracle | PASS | 0 | 25715 | 0 |
| ipdom agrees with the brute-force post-dominator oracle | PASS | 0 | 25715 | 0 |

## reducibility

ARCHITECTURE.md section 0 asserts the CFG is always reducible because Ignition bytecode is emitted
from an AST by a single-pass generator that never rewrites control flow. Measured over
239979 functions and 10883604 instructions:

| measurement | value |
|---|---:|
| retreating edges (target earlier in reverse postorder) | 18364 |
| of those, back edges (target dominates source) | 18201 |
| **irreducible retreating edges** | **163** |
| **functions containing one** | **121** of 239979 (0.0504%) |
| of those, async | 80 |
| of those, generator | 42 |
| of those, neither async nor generator | 0 |
| **functions still irreducible once the generator resume edges are removed** | **0** |
| edges still irreducible once the generator resume edges are removed | 0 |

### terminator of the block the irreducible edge leaves

| opcode | edges |
|---|---:|
| JumpLoop | 75 |
| Jump | 27 |
| JumpConstant | 12 |
| JumpIfToBooleanFalse | 11 |
| PopContext | 8 |
| JumpIfFalse | 7 |
| Ldar | 5 |
| GetNamedProperty | 4 |
| JumpIfToBooleanTrue | 4 |
| CallProperty1 | 2 |
| JumpIfTrue | 2 |
| CallProperty | 1 |
| CallUndefinedReceiver1 | 1 |
| CallUndefinedReceiver2 | 1 |
| InvokeIntrinsic | 1 |
| Mov | 1 |
| JumpIfToBooleanFalseConstant | 1 |

### irreducible functions

```
{
 "file": "b_544background.jsc",
 "index": 161,
 "bytecodeId": 1933,
 "name": "probeCacheFileOnDisk",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 81,
 "edges": 137,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 65,
   "from": 59,
   "to": 60,
   "kind": "fallthrough",
   "fromOffset": 326,
   "toOffset": 330,
   "terminator": "Ldar",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_86background.jsc",
 "index": 1676,
 "bytecodeId": 19870,
 "name": "",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 60,
 "edges": 97,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 18,
   "from": 14,
   "to": 40,
   "kind": "unconditional",
   "fromOffset": 122,
   "toOffset": 311,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  },
  {
   "edge": 30,
   "from": 27,
   "to": 40,
   "kind": "unconditional",
   "fromOffset": 212,
   "toOffset": 311,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_86background.jsc",
 "index": 1967,
 "bytecodeId": 23314,
 "name": "format",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 64,
 "edges": 107,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 16,
   "from": 12,
   "to": 43,
   "kind": "unconditional",
   "fromOffset": 76,
   "toOffset": 233,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  },
  {
   "edge": 18,
   "from": 14,
   "to": 25,
   "kind": "true",
   "fromOffset": 82,
   "toOffset": 142,
   "terminator": "JumpIfToBooleanFalse",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_86background.jsc",
 "index": 2283,
 "bytecodeId": 26429,
 "name": "handleAvatarChanged",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 101,
 "edges": 173,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 68,
   "from": 54,
   "to": 83,
   "kind": "true",
   "fromOffset": 284,
   "toOffset": 474,
   "terminator": "JumpIfToBooleanFalse",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_86background.jsc",
 "index": 2671,
 "bytecodeId": 30496,
 "name": "warmupProtectedFolders",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 58,
 "edges": 96,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 37,
   "from": 34,
   "to": 35,
   "kind": "fallthrough",
   "fromOffset": 269,
   "toOffset": 271,
   "terminator": "PopContext",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_86background.jsc",
 "index": 3148,
 "bytecodeId": 35255,
 "name": "sendInit",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 134,
 "edges": 237,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 41,
   "from": 38,
   "to": 76,
   "kind": "unconditional",
   "fromOffset": 246,
   "toOffset": 393,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_nodeXpluginbackground.jsc",
 "index": 8488,
 "bytecodeId": 72758,
 "name": "",
 "isAsync": false,
 "isGenerator": true,
 "kind": "normal",
 "blocks": 62,
 "edges": 95,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 38,
   "from": 32,
   "to": 13,
   "kind": "unconditional",
   "fromOffset": 193,
   "toOffset": 87,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_nodeXpluginbackground.jsc",
 "index": 13947,
 "bytecodeId": 126096,
 "name": "syncInstallDbAndRegedit",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 131,
 "edges": 232,
 "generatorResumeEdges": 5,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 121,
   "from": 113,
   "to": 21,
   "kind": "unconditional",
   "fromOffset": 660,
   "toOffset": 116,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_nodeXpluginbackground.jsc",
 "index": 14017,
 "bytecodeId": 126877,
 "name": "queryAllDownloadTaskInner",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 271,
 "edges": 480,
 "generatorResumeEdges": 5,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 74,
   "from": 63,
   "to": 42,
   "kind": "unconditional",
   "fromOffset": 405,
   "toOffset": 267,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  },
  {
   "edge": 99,
   "from": 84,
   "to": 29,
   "kind": "unconditional",
   "fromOffset": 522,
   "toOffset": 192,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  },
  {
   "edge": 254,
   "from": 221,
   "to": 120,
   "kind": "unconditional",
   "fromOffset": 1334,
   "toOffset": 737,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_nodeXpluginbackground.jsc",
 "index": 14019,
 "bytecodeId": 126901,
 "name": "refreshSingleGameStatus",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 159,
 "edges": 282,
 "generatorResumeEdges": 4,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 124,
   "from": 106,
   "to": 36,
   "kind": "unconditional",
   "fromOffset": 639,
   "toOffset": 207,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "b_nodeXpluginbackground.jsc",
 "index": 14021,
 "bytecodeId": 126923,
 "name": "refreshGameStatus",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 119,
 "edges": 208,
 "generatorResumeEdges": 3,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 85,
   "from": 75,
   "to": 48,
   "kind": "unconditional",
   "fromOffset": 464,
   "toOffset": 273,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  },
  {
   "edge": 109,
   "from": 95,
   "to": 35,
   "kind": "unconditional",
   "fromOffset": 578,
   "toOffset": 202,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_10114.jsc",
 "index": 190,
 "bytecodeId": 2328,
 "name": "loadStickersSrcData",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 73,
 "edges": 123,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 57,
   "from": 52,
   "to": 25,
   "kind": "unconditional",
   "fromOffset": 312,
   "toOffset": 158,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_12217.jsc",
 "index": 74,
 "bytecodeId": 801,
 "name": "confirmCallback",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 110,
 "edges": 191,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 38,
   "from": 32,
   "to": 75,
   "kind": "unconditional",
   "fromOffset": 184,
   "toOffset": 426,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_12696.jsc",
 "index": 70,
 "bytecodeId": 715,
 "name": "p",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 124,
 "edges": 215,
 "generatorResumeEdges": 3,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 114,
   "from": 99,
   "to": 19,
   "kind": "unconditional",
   "fromOffset": 553,
   "toOffset": 141,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_12696.jsc",
 "index": 74,
 "bytecodeId": 768,
 "name": "d",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 65,
 "edges": 109,
 "generatorResumeEdges": 3,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 50,
   "from": 47,
   "to": 29,
   "kind": "unconditional",
   "fromOffset": 290,
   "toOffset": 191,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_15091.jsc",
 "index": 1291,
 "bytecodeId": 14282,
 "name": "fetchConsecutivePttMessages",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 64,
 "edges": 113,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 58,
   "from": 54,
   "to": 55,
   "kind": "fallthrough",
   "fromOffset": 353,
   "toOffset": 357,
   "terminator": "PopContext",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_15091.jsc",
 "index": 1294,
 "bytecodeId": 14341,
 "name": "batchTranslatePttMessages",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 96,
 "edges": 166,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 74,
   "from": 69,
   "to": 44,
   "kind": "unconditional",
   "fromOffset": 439,
   "toOffset": 259,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_15570.jsc",
 "index": 950,
 "bytecodeId": 10756,
 "name": "spawnAllProcesses",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 44,
 "edges": 77,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 33,
   "from": 30,
   "to": 39,
   "kind": "true",
   "fromOffset": 157,
   "toOffset": 207,
   "terminator": "JumpIfFalse",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_16691.jsc",
 "index": 33,
 "bytecodeId": 309,
 "name": "A",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 53,
 "edges": 86,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 38,
   "from": 35,
   "to": 14,
   "kind": "unconditional",
   "fromOffset": 202,
   "toOffset": 91,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_24288.jsc",
 "index": 9,
 "bytecodeId": 100,
 "name": "realFormatMsg",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 79,
 "edges": 134,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 28,
   "from": 25,
   "to": 26,
   "kind": "fallthrough",
   "fromOffset": 168,
   "toOffset": 182,
   "terminator": "Mov",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_247.jsc",
 "index": 143,
 "bytecodeId": 1703,
 "name": "batchGetFileThumbnailUrl",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 113,
 "edges": 191,
 "generatorResumeEdges": 1,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 32,
   "from": 27,
   "to": 29,
   "kind": "unconditional",
   "fromOffset": 142,
   "toOffset": 146,
   "terminator": "Jump",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_247.jsc",
 "index": 186,
 "bytecodeId": 2214,
 "name": "loadChildrenData",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 101,
 "edges": 177,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 85,
   "from": 80,
   "to": 18,
   "kind": "unconditional",
   "fromOffset": 498,
   "toOffset": 129,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_25549.jsc",
 "index": 31,
 "bytecodeId": 356,
 "name": "initCacheData",
 "isAsync": true,
 "isGenerator": false,
 "kind": "method",
 "blocks": 108,
 "edges": 191,
 "generatorResumeEdges": 3,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 103,
   "from": 97,
   "to": 43,
   "kind": "unconditional",
   "fromOffset": 560,
   "toOffset": 286,
   "terminator": "JumpLoop",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_34189.jsc",
 "index": 138,
 "bytecodeId": 1767,
 "name": "ds",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 63,
 "edges": 104,
 "generatorResumeEdges": 2,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 39,
   "from": 35,
   "to": 36,
   "kind": "fallthrough",
   "fromOffset": 207,
   "toOffset": 211,
   "terminator": "Ldar",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```
```
{
 "file": "r_34189.jsc",
 "index": 139,
 "bytecodeId": 1777,
 "name": "gs",
 "isAsync": true,
 "isGenerator": false,
 "kind": "arrow",
 "blocks": 154,
 "edges": 268,
 "generatorResumeEdges": 3,
 "irreducibleWithoutGeneratorResume": 0,
 "detail": [
  {
   "edge": 35,
   "from": 30,
   "to": 31,
   "kind": "fallthrough",
   "fromOffset": 189,
   "toOffset": 193,
   "terminator": "Ldar",
   "why": "retreating edge whose target does not dominate its source"
  }
 ]
}
```

Every irreducible function becomes reducible once the generator resume dispatcher's jump-table
edges are removed. So the irreducibility is entirely an artefact of the `SwitchOnGeneratorState`
entry dispatcher jumping into the middle of a loop body, and ARCHITECTURE.md 4.4.6 already
prescribes removing it. The only thing that has to be added to the plan is an ORDER: T8 must
delete the dispatcher before it structures loops, not after.

## cross-checks against the disassembler

| cross-check | disagreements |
|---|---:|
| every back edge comes from the backward branch opcode | 0 |
| every reachable JumpLoop produces exactly one classified edge | 0 |
| switch successor count equals the decoded jump-table entry count | 0 |
| every protected range has a handler block and at least one exception edge | 0 |
| every jump-table target is a block leader | 0 |

### what each reachable JumpLoop turned into

| class | count | share |
|---|---:|---:|
| a back edge (target dominates source) | 18201 | 97.91% |
| in an irreducible region (cyclic, target does not dominate) | 130 | 0.70% |
| a forward edge: the cycle is broken by a suspend | 259 | 1.39% |
| unclassified (a real failure) | 0 | 0.00% |
| total | 18590 | |

The third class is the one that makes "back edges == JumpLoop count" wrong. In an async function
whose `await` is inside the loop, the body ends in `SuspendGenerator`, which returns, so the body
has no path back to the header: one invocation's CFG is acyclic and the loop closes only by
re-entering the function through the resume dispatcher. 243 function(s) are in that shape.

## corpus shape

| metric | value |
|---|---:|
| mean blocks per function | 6.58 |
| mean instructions per block | 6.90 |
| mean edges per block | 1.34 |
| mean phis per function | 1.01 |
| mean SSA values per function | 59.9 |
| functions with at least one loop | 12844 (5.35%) |
| functions with exception edges | 18245 (7.60%) |
| functions with a generator dispatcher | 10068 (4.20%) |
| functions with a SwitchOnSmiNoFeedback table | 842 (0.35%) |

### edges by kind

| kind | count | share |
|---|---:|---:|
| fallthrough | 681026 | 32.32% |
| exception | 441578 | 20.95% |
| true | 400532 | 19.01% |
| false | 400532 | 19.01% |
| unconditional | 160358 | 7.61% |
| switch | 23242 | 1.10% |

### blocks by kind (8.4 `kind`, resolved by priority)

| kind | count |
|---|---:|
| normal | 1523332 |
| handler | 25189 |
| loopHeader | 18201 |
| switchDispatch | 11208 |

### blocksPerFunction

| bucket | count | share |
|---|---:|---:|
| 1 | 132299 | 55.13% |
| 2 | 2 | 0.00% |
| 3 | 22982 | 9.58% |
| 4 | 18231 | 7.60% |
| 5 | 7584 | 3.16% |
| 6 | 7687 | 3.20% |
| 7 | 7328 | 3.05% |
| 8 | 4532 | 1.89% |
| 9-16 | 17852 | 7.44% |
| 17-32 | 11210 | 4.67% |
| 33-64 | 6993 | 2.91% |
| 65-128 | 2687 | 1.12% |
| 129-256 | 519 | 0.22% |
| 257-512 | 59 | 0.02% |
| 513-1024 | 10 | 0.00% |
| 1025-4096 | 4 | 0.00% |

### edgesPerBlock

| bucket | count | share |
|---|---:|---:|
| 0 | 318814 | 20.20% |
| 1 | 423003 | 26.81% |
| 2 | 831946 | 52.72% |
| 3 | 2646 | 0.17% |
| 4 | 629 | 0.04% |
| 5 | 238 | 0.02% |
| 6 | 164 | 0.01% |
| 7 | 167 | 0.01% |
| 8 | 78 | 0.00% |
| 9-16 | 130 | 0.01% |
| 17-32 | 66 | 0.00% |
| 33-64 | 36 | 0.00% |
| 65-128 | 12 | 0.00% |
| 129-256 | 1 | 0.00% |

### instructionsPerBlock

| bucket | count | share |
|---|---:|---:|
| 1 | 354330 | 22.46% |
| 2 | 372448 | 23.60% |
| 3 | 195492 | 12.39% |
| 4 | 146489 | 9.28% |
| 5 | 84397 | 5.35% |
| 6 | 84442 | 5.35% |
| 7 | 50343 | 3.19% |
| 8 | 38285 | 2.43% |
| 9-16 | 141394 | 8.96% |
| 17-32 | 69062 | 4.38% |
| 33-64 | 25913 | 1.64% |
| 65-128 | 9744 | 0.62% |
| 129-256 | 3864 | 0.24% |
| 257-512 | 1175 | 0.07% |
| 513-1024 | 345 | 0.02% |
| 1025-4096 | 194 | 0.01% |
| 4097+ | 13 | 0.00% |

### loopDepth

| bucket | count | share |
|---|---:|---:|
| 0 | 15801 | 86.81% |
| 1 | 2020 | 11.10% |
| 2 | 313 | 1.72% |
| 3 | 64 | 0.35% |
| 4 | 3 | 0.02% |

### phisPerFunction

| bucket | count | share |
|---|---:|---:|
| 0 | 159089 | 66.29% |
| 1 | 44998 | 18.75% |
| 2 | 14313 | 5.96% |
| 3 | 6563 | 2.73% |
| 4 | 3782 | 1.58% |
| 5 | 2540 | 1.06% |
| 6 | 1815 | 0.76% |
| 7 | 1167 | 0.49% |
| 8 | 946 | 0.39% |
| 9-16 | 3103 | 1.29% |
| 17-32 | 1185 | 0.49% |
| 33-64 | 348 | 0.15% |
| 65-128 | 101 | 0.04% |
| 129-256 | 23 | 0.01% |
| 257-512 | 4 | 0.00% |
| 513-1024 | 1 | 0.00% |
| 1025-4096 | 1 | 0.00% |

### phiArity

| bucket | count | share |
|---|---:|---:|
| 2 | 191181 | 79.17% |
| 3 | 19825 | 8.21% |
| 4 | 6673 | 2.76% |
| 5 | 2752 | 1.14% |
| 6 | 1795 | 0.74% |
| 7 | 1100 | 0.46% |
| 8 | 2608 | 1.08% |
| 9-16 | 5692 | 2.36% |
| 17-32 | 5371 | 2.22% |
| 33-64 | 3399 | 1.41% |
| 65-128 | 936 | 0.39% |
| 129-256 | 123 | 0.05% |
| 257-512 | 14 | 0.01% |
| 513-1024 | 8 | 0.00% |

### predsPerBlock

| bucket | count | share |
|---|---:|---:|
| 0 | 239631 | 15.19% |
| 1 | 1038016 | 65.78% |
| 2 | 232773 | 14.75% |
| 3 | 31038 | 1.97% |
| 4 | 9476 | 0.60% |
| 5 | 6977 | 0.44% |
| 6 | 2035 | 0.13% |
| 7 | 1593 | 0.10% |
| 8 | 1912 | 0.12% |
| 9-16 | 5664 | 0.36% |
| 17-32 | 5075 | 0.32% |
| 33-64 | 2824 | 0.18% |
| 65-128 | 805 | 0.05% |
| 129-256 | 93 | 0.01% |
| 257-512 | 10 | 0.00% |
| 513-1024 | 8 | 0.00% |

### exceptionPredsPerHandler

| bucket | count | share |
|---|---:|---:|
| 1 | 767 | 3.04% |
| 2 | 587 | 2.33% |
| 3 | 4022 | 15.97% |
| 4 | 1402 | 5.57% |
| 5 | 775 | 3.08% |
| 6 | 853 | 3.39% |
| 7 | 1133 | 4.50% |
| 8 | 1647 | 6.54% |
| 9-16 | 5309 | 21.08% |
| 17-32 | 4986 | 19.79% |
| 33-64 | 2797 | 11.10% |
| 65-128 | 800 | 3.18% |
| 129-256 | 93 | 0.37% |
| 257-512 | 10 | 0.04% |
| 513-1024 | 8 | 0.03% |

### valuesPerFunction

| bucket | count | share |
|---|---:|---:|
| 6 | 7324 | 3.05% |
| 7 | 8847 | 3.69% |
| 8 | 19819 | 8.26% |
| 9-16 | 36877 | 15.37% |
| 17-32 | 59046 | 24.60% |
| 33-64 | 54001 | 22.50% |
| 65-128 | 31593 | 13.16% |
| 129-256 | 15515 | 6.47% |
| 257-512 | 5037 | 2.10% |
| 513-1024 | 1350 | 0.56% |
| 1025-4096 | 497 | 0.21% |
| 4097+ | 73 | 0.03% |

### effect kinds touched

| kind | ops |
|---|---:|
| w:context | 3279843 |
| r:context | 3178772 |
| r:heap | 3075174 |
| r:global | 3057612 |
| w:heap | 3054505 |
| w:global | 3054505 |
| w:module | 3054505 |
| r:module | 3054505 |
| w:generator | 40620 |
| w:message | 26067 |
| r:message | 26067 |
| r:generator | 25344 |

### context slot resolution

| outcome | count |
|---|---:|
| resolved to a name | 968489 |
| contextValueNotStaticallyKnown | 12119 |
| slotOutsideContextLocals | 303 |
| contextChainShorterThanDepth | 78 |

### max context depth per function

| bucket | count | share |
|---|---:|---:|
| 0 | 143114 | 82.66% |
| 1 | 19997 | 11.55% |
| 2 | 7618 | 4.40% |
| 3 | 1985 | 1.15% |
| 4 | 347 | 0.20% |
| 5 | 63 | 0.04% |
| 6 | 9 | 0.01% |
| 7 | 6 | 0.00% |

## warnings by kind

| code | count |
|---|---:|
| cfg:handlerRangeEmpty | 5 |

## slowest files

| file | functions | instructions | blocks | ms |
|---|---:|---:|---:|---:|
| r_yuanbaoXmarkxxXfallback.jsc | 2238 | 557997 | 36761 | 111777 |
| b_nodeXpluginbackground.jsc | 19125 | 791300 | 128024 | 94644 |
| b_86background.jsc | 12289 | 611335 | 135974 | 57560 |
| r_vendorsXvue.jsc | 2518 | 90021 | 15259 | 48422 |
| r_8878.jsc | 22775 | 1197509 | 125319 | 48024 |
| r_63903.jsc | 4227 | 195995 | 17886 | 28470 |
| b_357background.jsc | 1334 | 69442 | 10997 | 27675 |
| r_qqfabric.jsc | 1491 | 68907 | 8231 | 26612 |
| r_vXcalendar.jsc | 891 | 32097 | 4669 | 25078 |
| r_56118.jsc | 744 | 28164 | 5036 | 24821 |
| r_uploader.jsc | 557 | 30220 | 3254 | 24057 |
| r_55854.jsc | 835 | 37686 | 7087 | 23619 |
| r_44384.jsc | 2082 | 100325 | 10792 | 23063 |
| b_background_ex.jsc | 1617 | 64145 | 10534 | 22116 |
| r_yuanbaoXreactXmarkdown.jsc | 391 | 15335 | 2639 | 20650 |

==============================================================================
IR CORPUS SCAN: NO FAILURES
