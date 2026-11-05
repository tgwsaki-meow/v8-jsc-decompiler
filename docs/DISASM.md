# `src/disasm/` — Ignition bytecode → `Instruction[]`

Stage A of [ARCHITECTURE.md §4.1](ARCHITECTURE.md). Input: a `FunctionUnit`
(§8.1). Output: `Instruction[]` (§8.2). Replaces `legacy/src/lifter.js`.

```
src/disasm/
  index.mjs            disassemble(unit, {profile}) -> {instructions, stats, warnings}
  frame.mjs            the interpreter frame: operand value <-> structured register
  opcode_facts.mjs     jump / switch / short-star / reg-list facts, derived from the profile
  format.mjs           a listing in V8's own column layout, plus a richer one
  adapter_legacy.mjs   FALLBACK: legacy/src/deserializer.js output -> a FunctionUnit
src/cli/disasm.mjs     the CLI
tools/disasm/          the oracle, the self-test, the corpus scan, the source corpus
corpus/features/disasm/*.js   the 41 oracle sources (written by the oracle run)
```

The §8.1 `FunctionUnit` comes from T4's `src/cache` + `src/heap`.
`adapter_legacy.mjs` exists because `src/disasm` was built against the §8.1
contract before that pipeline landed; it is now the fallback, and the oracle
runs **both** input paths against the same V8 listing so that the contract is
demonstrated rather than assumed.

Nothing version-specific is written down here. Every opcode, operand type,
operand width, runtime name and intrinsic name comes from
`profiles/<tag>/*.json` through `src/profile/index.mjs`;
`tools/disasm/selftest.mjs` check **A** greps `src/disasm/*.mjs` for hex
literals and for decimal literals of three digits or more (outside comments)
and fails if it finds any.

---

## 1. Running it

```
node src/cli/disasm.mjs <file.jsc> [--function <id|index|name>] [--profile <tag>]
                        [--v8] [--json [out.json]] [--list] [--stats]
                        [--units real|legacy] [--no-constants] [--quiet]

node tools/disasm/selftest.mjs                 # 37 unit checks, both profiles
node tools/disasm/oracle_agreement.mjs         # agreement with V8's own listing
node --max-old-space-size=2600 tools/disasm/corpus_scan.mjs   # all 1039 .jsc
```

`--v8` prints the listing in `BytecodeArray::Disassemble`'s exact column
layout, so it diffs line-for-line against a real engine's
`--print-bytecode`. The address column is incidental (we have no address and
print a synthetic base); everything else is byte-identical, including the hex
column, the `NN S>` source-position markers, the `(0x… @ N)` jump annotation
and the `{ 0: @59, … }` jump table.

---

## 2. Instruction layout and operand widths

```
instruction  ::=  [prefix] opcode operand*
scale        ::=  prefix ? bytecodes.json prefixes[prefix].scale : 1
width(type)  ::=  operands.json: scalable ? baseSize * scale : baseSize
```

`Wide` and `ExtraWide` are opcodes `0x00` and `0x01` in both profiles, but the
decoder never says so: it asks the profile which opcodes are prefixes and what
scale each selects (`bytecodes.json` → `prefixes`). A prefix scales **only the
scalable** operand types; a fixed-width operand keeps its width. That
distinction is the whole reason the profile has to be per-version — see §7.

Two offsets per instruction, and the difference between them matters:

| name | meaning |
|---|---|
| `offset` | start of the instruction, **including** the prefix byte |
| `opcodeOffset` | the opcode byte, i.e. `offset + (prefix ? 1 : 0)` |

`offset` is what the source position table and the handler table are expressed
in. `opcodeOffset` is what jump deltas are relative to (§3).

### Per-operand decoding

Every operand is read as the profile's `operandSize(type, scale)` bytes, signed
or unsigned per `operands.json`'s `signed` flag, little-endian — exactly
`BytecodeDecoder::DecodeSignedOperand` / `DecodeUnsignedOperand`
(`src/interpreter/bytecode-decoder.cc`). The decoded forms:

| operand type | §8.2 form | notes |
|---|---|---|
| `kReg`, `kRegOut`, `kRegInOut` | `{type, reg}` | `reg` is §8.3 structured, see §5 |
| `kRegList`, `kRegOutList` | `{type, start, count, regs}` | count comes from the **following** `kRegCount`; see §6 |
| `kRegCount` | `{type, count}` | kept in place so `operands[]` lines up with `profile` `operands[]` |
| `kRegPair`, `kRegOutPair` | `{type, start, regs}` | 2 registers |
| `kRegOutTriple` | `{type, start, regs}` | 3 registers |
| `kImm` | `{type, value}` | signed |
| `kUImm` | `{type, value}` | unsigned |
| `kConstantPoolIndex` | `{type, index, constant}` | `constant` is the §8.1 pool entry |
| `kContextSlot`, `kCoverageSlot` | `{type, slot}` | |
| `kFeedbackSlot` | `{type, slot}` | scalable |
| `kEmbeddedFeedback` | `{type, slot}` | fixed `uint16`, 14.6 only |
| `kFlag8`, `kFlag16` | `{type, value}` | V8 prints these in **hex** with no `0x` |
| `kRuntimeId` | `{type, id, name}` | `name` from `runtime.json` |
| `kIntrinsicId` | `{type, id, name, printedName}` | see below |
| `kNativeContextIndex` | `{type, index}` | **not resolvable**, see §8 |
| `kAbortReason` | `{type, reason}` | **not resolvable**, see §8 |

`kRegCount` is kept as its own entry even though V8's printer folds it into the
preceding list, because §8.2 says the operand array follows the profile's
`operands[]` order; dropping it would misalign every later index.

`kIntrinsicId` has two names on purpose. `name` is the intrinsic's own name,
which is what §8.2 asks for. `printedName` is what V8 prints, which is *not*
the same thing: `BytecodeDecoder` renders the operand as
`NameForRuntimeId(IntrinsicsHelper::ToRuntimeId(id))`, `ToRuntimeId` maps
`IntrinsicId::kX` to `Runtime::FunctionId::kInlineX`, and the `I()` macro in
`src/runtime/runtime.h` names inline runtime functions `"_" #name`. So V8
prints `_CreateJSGeneratorObject` where the intrinsic is
`CreateJSGeneratorObject`. The formatter uses `printedName`; everything else
uses `name`.

---

## 3. Jump targets

**The rule.** The delta is located by **operand type**, never by the opcode's
name:

* an opcode whose operand 0 is `kUImm` is a *jump immediate*; the delta is
  that operand's value;
* an opcode inside the jump block (§4) whose operand 0 is `kConstantPoolIndex`
  is a *jump constant*; the delta is the **Smi** in that pool slot;
* exactly one jump is backward and its delta is negated.

and then

```
jumpTarget = opcodeOffset + delta          // forward
jumpTarget = opcodeOffset - delta          // the one backward jump (JumpLoop)
```

**Citation.** `src/interpreter/bytecode-array-iterator.cc`, identical in
14.4.258.16 and 14.6.202.34:

```cpp
int BytecodeArrayIterator::GetRelativeJumpTargetOffset() const {
  Bytecode bytecode = current_bytecode();
  if (interpreter::Bytecodes::IsJumpImmediate(bytecode)) {
    int relative_offset = GetUnsignedImmediateOperand(0);
    if (bytecode == Bytecode::kJumpLoop) relative_offset = -relative_offset;
    return relative_offset;
  } else if (interpreter::Bytecodes::IsJumpConstant(bytecode)) {
    Tagged<Smi> smi = GetConstantAtIndexAsSmi(GetConstantPoolIndexOperand(0));
    return smi.value();
  }
  UNREACHABLE();
}
int BytecodeArrayIterator::GetAbsoluteOffset(int relative_offset) const {
  return current_offset() + relative_offset + prefix_size_;
}
```

`current_offset()` is the instruction start (`cursor_ - start_ - prefix_size_`),
so `current_offset() + prefix_size_` is the **opcode byte**, not the start.
They differ by one for every `Wide`/`ExtraWide` jump, which is why
`instruction.offset + delta` is wrong and `legacy/src/lifter.js`'s
`opcodeOffset = pc - 1` was accidentally right. The emitter agrees:
`BytecodeArrayWriter::PatchJump` subtracts one from the delta when the jump
carries a prefix, and `EmitJumpLoop` adds one to the backward delta for the
same reason (`src/interpreter/bytecode-array-writer.cc`).

A concrete instance, from `corpus/features/disasm/extrawide_loop.js`:

```
ExtraWide JumpLoop @ 116255, length 14, delta 116254  ->  target 2
    opcodeOffset = 116255 + 1 = 116256;  116256 - 116254 = 2   correct
    offset       = 116255;               116255 - 116254 = 1   not an
                                                               instruction
```

**Why a `*Constant` variant exists at all.** A forward jump's operand width is
fixed when the jump is *emitted*, before its distance is known, from the size
of a reserved constant-pool entry (`BytecodeArrayWriter::EmitJump`). If the
distance later turns out not to fit, the delta goes into that pool entry and
the opcode is rewritten to its `*Constant` form
(`PatchJumpWith8BitOperand`). A consequence worth knowing when writing test
inputs: a forward jump becomes `.Wide` because the function has **many
constants**, not because the jump is long. A backward `JumpLoop`, whose delta
*is* known at emit time, becomes `.Wide` past 255 bytes of loop body and
`.ExtraWide` past 65535.

If a `*Constant` jump names a pool slot that does not hold a Smi, the
instruction gets `jumpTarget: null` and an `unresolvedJumpConstant` warning.
Nothing is guessed.

Every target is checked against the instruction index afterwards; a target that
is not the start of a decoded instruction produces a
`jumpTargetNotAnInstruction` warning and is counted in `stats.danglingTargets`.

---

## 4. Which opcodes are jumps — derived, then cross-checked

V8's predicates are opcode-value ranges (`src/interpreter/bytecodes.h`):

```cpp
IsJump(bc)          = bc >= kJumpLoop && bc <= kJumpIfForInDone
IsJumpImmediate(bc) = bc == kJump || bc == kJumpLoop || IsConditionalJumpImmediate(bc)
IsJumpConstant(bc)  = bc >= kJumpConstant && bc <= kJumpIfToBooleanFalseConstant
IsForwardJump(bc)   = bc >= kJump && bc <= kJumpIfForInDone
```

so the family is one contiguous block, the immediate members are exactly the
ones taking `kUImm` first, and the single backward jump sits at the bottom of
the block, immediately below `kJump`. `opcode_facts.mjs` reproduces that from
the profile alone:

```
jumpImmediate := { op : op.operands[0] == 'kUImm' }
block         := [ min(jumpImmediate.value) .. max(jumpImmediate.value) ]
jumpConstant  := { op in block : op.operands[0] == 'kConstantPoolIndex' }
backward      := the member of block with the lowest opcode value
```

In both profiles `jumpImmediate` is exactly the 13 jump-immediate bytecodes and
no other opcode takes `kUImm` in position 0, which is what makes step one a
derivation and not a guess. (`kConstantPoolIndex` first is *not* enough on its
own: 44 opcodes have it, from `LdaConstant` to `SwitchOnSmiNoFeedback`. Hence
the block.)

Three cross-checks run at profile load and throw rather than mis-decode:

1. the block must be exactly `jumpImmediate ∪ jumpConstant` — 25 = 13 + 12;
2. the derived family must coincide, in both directions, with the set of
   opcodes whose name begins with `Jump`;
3. the backward jump must be the unique jump carrying a loop-depth `kImm` and
   a `kFeedbackSlot` (`JumpLoop [kUImm, kImm, kFeedbackSlot]`), and that opcode
   must be the lowest in the block.

---

## 5. Registers (§8.3)

A register operand is a signed integer that V8 converts with

```cpp
Register::FromOperand(operand) = Register(kRegisterFileStartOffset - operand)
Register::ToOperand()          = kRegisterFileStartOffset - index_
                                        -- src/interpreter/bytecode-register.h
```

`kRegisterFileStartOffset` and the reserved negative indices come from the
**frame layout**, via

```cpp
constexpr int OffsetFromFPToRegisterIndex(int offset) {
  return (InterpreterFrameConstants::kRegisterFileFromFp - offset) / kSystemPointerSize;
}
```

The generated profile carries the bytecode tables and the type sizes but **not**
`InterpreterFrameConstants`, so `frame.mjs` rebuilds the layout from the sizes
the profile does carry (`kSystemPointerSize`, `kPCOnStackSize`,
`kFPOnStackSize`, `kFrameCPSlotCount`) plus the slot arithmetic that
`src/execution/frame-constants.h` states itself. Every term is annotated with
the declaration it mirrors; the only bare integers are the slot ordinals that
appear literally in those declarations. On x64 with pointer compression the
derivation produces:

| register | index | operand |
|---|---:|---:|
| `r0` | 0 | −7 |
| `r1` | 1 | −8 |
| `<this>` (parameter 0) | −9 | 2 |
| `a0` (parameter 1) | −10 | 3 |
| `<context>` | −6 | −1 |
| `<closure>` | −5 | −2 |
| `<accumulator>` (virtual) | −8 | 1 |
| bytecode array | −3 | −4 |
| bytecode offset | −2 | −5 |
| feedback vector | −1 | −6 |
| argument count | −4 | −3 |

`decode(operand)` returns the §8.3 tagged form — `{k:'local', i}`,
`{k:'param', i}` (`i = 0` is the receiver), `{k:'context'}`, `{k:'closure'}`,
`{k:'acc'}`, `{k:'bytecodeArray'}`, `{k:'bytecodeOffset'}`,
`{k:'feedbackVector'}`, `{k:'argumentCount'}`, `{k:'invalid', index}` — never a
string. That is the point: `legacy/src/profile.js`'s `decodeRegister` returned
`'feedback_vector'` / `'r3'` / `'this'`, and those strings leaked all the way
into the emitted JavaScript as undeclared variable names. With a tagged object
the leak is type-impossible.

Rendering back to V8's text (`frame.toString`) mirrors
`Register::ToString()` exactly, including its precedence: context, closure,
accumulator, then "is a parameter" (`index < 0`), then the register file. The
frame-header registers all satisfy `index < 0`, so V8 would print them as
`a<negative>`; the renderer reproduces that, while the classification above
still names them properly.

The model is not trusted, it is checked three ways:

* `frame.validate()` requires the reserved indices to be distinct, negative and
  above the first parameter index;
* every decoded local index must land in `[0, registerCount)` and every
  parameter index in `[0, parameterCount)` — asserted per function, reported as
  `registerOutOfRange` and counted in `stats.badRegisters` (0 over the whole
  corpus);
* the oracle compares every register the formatter prints against the register
  V8's own listing prints, for both profiles.

`frame.mjs` honours `profile.constants.interpreterFrame` if a future profile
ever carries one, and skips the derivation.

---

## 6. Register lists

`kRegList` / `kRegOutList` always come paired with a following `kRegCount`;
`BytecodeDecoder::Decode` `DCHECK`s it and so does `opcode_facts.mjs`. The pair
decodes to one run:

```cpp
RegisterList BytecodeDecoder::DecodeRegisterListOperand(
    Address operand_start, uint32_t count, OperandType t, OperandScale s) {
  Register first_reg = DecodeRegisterOperand(operand_start, t, s);
  return RegisterList(first_reg.index(), static_cast<int>(count));
}
const Register operator[](size_t i) const { return Register(first_reg_index_ + i); }
```

So the run is `start.index, start.index + 1, …` — **upward in register index**,
and therefore **downward in operand value**, since `operand = S - index`. Both
statements are true and they are easy to confuse; ARCHITECTURE.md §4.1 phrases
it in operand-value space ("递减"), V8's printer phrases it in index space
(`r1-r4`). `regs[]` is in V8's order: index increasing.

`count` may be zero. V8 then prints `r0-r0`, because
`RegisterList::first_register()` and `last_register()` both return
`Register(0)` for an empty list; the formatter reproduces that so an empty
argument list still diffs clean.

`kRegPair` / `kRegOutPair` name 2 registers and `kRegOutTriple` names 3
(`Bytecodes::GetNumberOfRegistersRepresentedBy`); `opcode_facts.mjs` reads the
count off the operand type's own name and asserts that every register operand
type in the profile is accounted for.

---

## 7. Jump tables

Two opcodes carry one. `Bytecodes::IsSwitch` is an enumeration, not a range, so
members are found by the `SwitchOn` name prefix — and then their three operands
are located **by type**, exactly as
`BytecodeArrayIterator::GetJumpTableTargetOffsets()` does:

| opcode | operands | table start | length | case base |
|---|---|---|---|---|
| `SwitchOnSmiNoFeedback` | `[kConstantPoolIndex, kUImm, kImm]` | operand 0 | operand 1 | operand 2 |
| `SwitchOnGeneratorState` | `[kReg, kConstantPoolIndex, kUImm]` | operand 1 | operand 2 | implicit 0 |

The rule: `tableStart` is the `kConstantPoolIndex` operand, `tableLength` is the
`kUImm` operand, `caseValueBase` is the `kImm` operand or 0 when absent.

**The table is a run of constant-pool slots, not a nested array.**
`BytecodeJumpTable::ConstantPoolEntryFor(case_value)` is
`constant_pool_index_ + case_value - case_value_base_`, so slots
`[tableStart, tableStart + tableLength)` hold `tableLength` Smis, one per case,
in case order. Each Smi is a delta relative to the switch instruction:

```cpp
void BytecodeArrayWriter::BindJumpTableEntry(BytecodeJumpTable* jump_table, int case_value) {
  size_t relative_jump = bytecodes()->size() - jump_table->switch_bytecode_offset();
  constant_array_builder()->SetJumpTableSmi(
      jump_table->ConstantPoolEntryFor(case_value), Smi::FromInt(relative_jump));
}
```

and it is read back through the same `GetAbsoluteOffset` as a plain jump, so:

```
entry j  ->  { caseValue: caseValueBase + j,
               target:    opcodeOffset + Smi(constants[tableStart + j]) }
```

Both 14.4.258.16 and 14.6.202.34 `CHECK` that every slot in the span is a Smi
(`GetConstantAtIndexAsSmi`), so a non-Smi slot is a decode problem, not a hole
to skip: the entry gets `target: null, unresolved: true`, an
`unresolvedJumpTableEntry` warning, and a bump of `stats.jumpTableHoles`.
(0 over the whole corpus.)

Two things this unlocks, both previously lost outright:

* `switch` — a jump table is emitted when the cases are ≥ 6 Smi literals with a
  spread under a threshold; smaller or non-Smi switches become comparison
  chains, which is why `switch_strings.js` in the corpus shows 0 tables;
* every generator and every async function — their entry dispatcher is
  `SwitchOnGeneratorState`, and the `finally` desugaring uses a token register
  plus a trailing `SwitchOnSmiNoFeedback`.

Corpus-wide: **11 208 jump tables / 23 242 entries**, of which 10 068 are
`SwitchOnGeneratorState` and 1 140 are `SwitchOnSmiNoFeedback`.

---

## 8. Source positions

`FunctionUnit.sourcePositions` is already decoded to absolute values (§8.1).
Attachment reproduces `BytecodeArray::Disassemble` exactly — a **lockstep**
walk that consumes one row when `current_offset() == code_offset()`:

```cpp
SourcePositionTableIterator source_positions(handle->SourcePositionTable());
while (!iterator.done()) {
  if (!source_positions.done() &&
      iterator.current_offset() == source_positions.code_offset()) {
    os << std::setw(5) << source_positions.source_position().ScriptOffset();
    os << (source_positions.is_breakable()
             ? (source_positions.is_statement() ? " S> " : " E> ")
             : (source_positions.is_statement() ? " s> " : " e> "));
    source_positions.Advance();
  } else { os << "         "; }
  ...
```

Matching is against `offset`, the instruction start including the prefix.
Rows with a negative code offset (the function-entry row, at
`kFunctionEntryBytecodeOffset`) are skipped, as
`SourcePositionTableIterator`'s default `kSkipFunctionEntry` filter does.
`stats.sourcePositionsAttached / sourcePositionsTotal` reports the result;
over the corpus it is 4 166 530 / 4 166 530 = 100%, which is a strong check on
the decode: a row that does not land on an instruction start means the table
was decoded wrong.

Two details of the table itself live in `adapter_legacy.mjs` (they belong in
`src/heap/`, T4's code) and are worth repeating because both are easy to get
wrong by one:

* the running code offset starts at `kFunctionEntryBytecodeOffset` (−1), not 0,
  because `SourcePositionTableBuilder::previous_` is default-constructed and
  `PositionTableEntry`'s default `code_offset` is that sentinel. From-zero
  decoding makes every row miss its instruction by one;
* the accumulated `source_position` is `SourcePosition::raw()`, a packed
  int64, not a script offset: `IsExternalField` is bit 0, `ScriptOffsetField`
  is bits 1..30 holding `scriptOffset + 1`, so
  `ScriptOffset() == ((raw >> 1) & mask30) - 1`.

---

## 9. Known gaps

Everything here is reported, never papered over.

`src/disasm/adapter_legacy.mjs` was written before T4's `src/cache` +
`src/heap` landed, and is now only a fallback: `src/cli/disasm.mjs` prefers the
real pipeline (`--units real`, the default) and the oracle runs both. The gaps
in the table below marked "adapter" therefore no longer apply to the normal
path; they are kept because the adapter is still the fallback for a cache the
real reader declines.

| gap | effect | owner |
|---|---|---|
| `kNativeContextIndex` | V8 names it from `NATIVE_CONTEXT_FIELDS`, which no generated table carries. The operand decodes to `{index}` and prints `[nativeContextIndex_N]`. Only `CallJSRuntime` uses it: 1 occurrence across the 41 oracle sources, 18 across the 10 883 604 corpus instructions. | profilegen (T1) |
| `kAbortReason` | same, from `src/codegen/bailout-reason.h`. Only `Abort`, which V8 emits under `--debug-code`; 0 occurrences in the corpus. | profilegen (T1) |
| `SourcePosition` bit layout | not Torque, so not in `constants.json`; `adapter_legacy.mjs` carries it with a citation and honours `constants.sourcePositionTable.rawPosition` if a profile ever supplies it. | profilegen (T1) |
| `InterpreterFrameConstants` | not in `constants.json`; `frame.mjs` re-derives it (§5) and honours `constants.interpreterFrame` if supplied. | profilegen (T1) |
| function `name`, `kind`, `startPosition`, `scope`, `uncompiled` | adapter only: it returns `null`/`''`, because the name usually lives in the `ScopeInfo` that `name_or_scope_info` points at and it has no ScopeInfo decoder. Reported per unit as `adapterGap`. `src/heap` recovers all of them. | adapter |
| constant classification | adapter only: it classifies strings, Smis, HeapNumbers, roots, RO refs and SFIs, and 12.15% of corpus pool entries come back `{t:'unresolved'}` (boilerplate descriptors, BigInts, symbols, scope infos). Jump deltas and jump tables are unaffected either way — they are Smis, which **are** classified: 0 of 23 242 table entries and 0 of 560 890 jump deltas failed to resolve. | adapter |
| BigInt constants | neither input side produces `{t:'bigint'}`; both report `{t:'unresolved'}`, which §8.1 requires rather than a guess. | `src/heap/` (T4) |
| no 14.6 `.jsc` path | both profiles describe a **sandboxed** V8 build (`layouts.json`: `ExposedTrustedObject` has `self_indirect_pointer`), which is what Chromium/Electron ship and what the corpus is. The `node` on this machine is V8 14.6.202.34 built **without** the sandbox, so its code cache has no `kIndirectPointerPrefix` / `kInitializeSelfIndirectPointer` tags. Both readers reject it — `legacy/src/deserializer.js` on an unexpected tag, `src/cache` on "object size 0 tagged slots is below the one-slot map word" — so this is a profile-vs-binary mismatch, not a reader bug. The 14.6 oracle therefore runs in `listing` mode (§10). Closing it needs either a sandboxed V8 14.6 binary or a non-sandboxed 14.6 profile. | — |

---

## 10. Acceptance

### The oracle

`tools/disasm/oracle_agreement.mjs` compares our instruction stream against
V8's own `--print-bytecode` for 41 sources (`tools/disasm/sources.mjs`, written
out to `corpus/features/disasm/`), covering every control-flow form, a `switch`
with enough contiguous Smi cases to force a jump table (plus one with a
negative case base and one with fall-through), generators, `yield*`, async
functions, async generators, `for await`, `try`/`catch`/`finally`, labeled
break/continue, optional chaining, destructuring, spread/rest, classes with
private fields and static blocks, template literals, `with`/`eval`, 320
simultaneously live registers, 640 constants, and a loop body over 65535 bytes.

Functions are paired by their **bytecode bytes**, reconstructed from the hex
column of V8's listing — unambiguous, and in cache mode it also verifies that
the cache engine and the listing engine emitted the same bytecode.

Each paired function is checked twice: directly, instruction for instruction
(count, offsets, raw bytes, opcode, scale, every operand's text, jump target,
jump table, source position, statement and breakable flags), and through
`src/verify/normalize.mjs` + `compare.mjs` requiring `exactMatch`.
Constant-pool operands are compared **by index**, not by V8's printed value:
both sides read the same pool out of the same `BytecodeArray`, so the index is
the stronger comparison, and a release `d8` does not dump the pool at all.

Three input modes:

* **cache** — `vm.Script(src).createCachedData()` in the target engine produces
  a real `.jsc`, read through `adapter_legacy.mjs`. The full path: serialized
  constant pool, handler table and source position table included.
* **cache-t4** — the same `.jsc`, read through **T4's** `src/cache` +
  `src/heap`, i.e. the real §8.1 producer. `src/disasm` is specified against
  §8.1 and consumes T4's output with no adaptation; running both input paths
  against the same oracle is how that is demonstrated, and a disagreement
  between them would say which one has the contract wrong.
* **listing** — the `FunctionUnit`'s bytecode bytes, header numbers and
  constant pool are lifted out of V8's own listing
  (`tools/disasm/unit_from_listing.mjs` documents exactly how circular that is
  and is not). Needed for 14.6, see §9. Source positions are not available in
  this mode and are not compared.

| profile | input mode | unit source | listing engine | functions | exact | instructions | diffs |
|---|---|---|---|---:|---|---:|---:|
| 14.4.258.16 | cache | `adapter_legacy` | `d8` 14.4.258.17 | 102 | 102/102 | 31 919 | **0** |
| 14.4.258.16 | cache-t4 | `src/cache` + `src/heap` | `d8` 14.4.258.17 | 102 | 102/102 | 31 919 | **0** |
| 14.6.202.34 | listing | from the listing | `node` v26.12.1 (V8 14.6.202.34-node.40) | 1 578 | 1 578/1 578 | 112 312 | **0** |

The `.jsc` for 14.4 comes from Electron 40.0.0, which carries V8 14.4.258.16 —
exactly the profile tag, and a sandboxed build like the corpus. `electron.exe`
cannot print a listing (it is a Windows GUI-subsystem binary, so V8's
`StdoutStream` has nowhere to write), so `d8` 14.4.258.17 does the printing,
one patch ahead. Pairing by bytecode bytes is what makes that safe.

The 14.6 run picks up node's own bootstrap internals as well as the corpus
source, which is why it compares 15× more functions.

One class of difference is counted rather than asserted, and only on the 14.6
pair: `CallRuntime` / `InvokeIntrinsic` **callee names**. Node's V8 is a
patched, non-sandboxed build whose `FOR_EACH_INTRINSIC` expansion differs from
the pristine 14.6.202.34 the profile was generated from — profile id 273 is
`IsJSReceiver`, node's binary prints `InternalSetPrototype` for the same id,
i.e. node's list is short by one somewhere below id 167. That shifts names
while changing nothing about operand widths, instruction lengths or jump
arithmetic. 119 occurrences. The pristine `d8` 14.4 pair asserts callee names
and agrees exactly (0 mismatches), which is what shows the lookup itself is
right.

### The self-test

`tools/disasm/selftest.mjs` — 37 checks, both profiles, no engine needed.
Besides the hygiene grep it includes a tiny profile-driven **assembler**, so
every opcode at every scale is encoded, decoded and compared without a single
hardcoded byte; jump arithmetic is checked at scale 1/2/4 including the
assertion that `instruction.offset + delta` is *not* the rule for a prefixed
jump; jump tables are checked with case bases 0, −4 and 10; register lists with
counts 0, 1 and 5; all 16 short stars; the source-position lockstep; and seven
malformed inputs.

Check **K** is the ARCHITECTURE.md §1.3 demonstration: the five comparison
bytecodes that moved from `kFeedbackSlot` to `kEmbeddedFeedback` really do have
different widths in the two profiles (3 vs 4 bytes at scale 1), and a stream of
14.6 comparison bytecodes decoded with the 14.4 table desynchronises after two
instructions instead of yielding six.

### The corpus

`tools/disasm/corpus_scan.mjs`, all 1039 `extracted_jsc/*.jsc` against
`profiles/14.4.258.16`. Identical numbers through either unit source
(`--units real` = `src/cache` + `src/heap`, `--units legacy` =
`adapter_legacy`):

| metric | value |
|---|---:|
| files read | 1039 / 1039 |
| functions | 239 979 |
| instructions | 10 883 604 |
| failures (file or function) | **0** |
| distinct opcodes | 165 of 212 |
| jump instructions / targets resolved | 560 890 / 560 890 |
| **jump tables decoded** | **11 208** (23 242 entries) |
| jump table entries that were not a Smi | 0 |
| targets that are not an instruction start | 0 |
| register operands outside the frame | 0 |
| Wide / ExtraWide | 661 916 / 77 530 |
| short stars normalised to `Star` | 2 649 411 |
| source position rows attached | 4 166 530 / 4 166 530 (100%) |
| handler tables / entries | 18 245 / 25 189 |
| constant pool entries reported `{t:'unresolved'}` | 5 629 of 1 790 172 (0.31%) via `src/heap`; 217 470 (12.15%) via `adapter_legacy` |
| **decoded length ≠ `profile.instructionLength`** | **0** |
| warnings of any kind | 0 |

Every decode figure above is identical through either unit source. The only
column that moves is the constant classification, which is T4's job, not the
disassembler's.

Wall time is reported split, because most of it is not ours: reading the
`.jsc` takes 55–69% and decoding takes 25–37%. Decoding is the stable number —
146.0 s and 145.3 s for 10 883 604 instructions in two runs, about **74 500
instructions/s** (190 KiB of bytecode/s) single-threaded. End-to-end wall time
measured between 67 s and 574 s across five runs on this host (4 GB of RAM with
~300 MB free, 2 cores), so the absolute end-to-end figure says more about
memory pressure than about the code.

The length cross-check is asserted permanently, per instruction, in
`disassemble()`: the decoded width of every instruction is compared against
`profile.instructionLength(opcode, scale)` and a disagreement is a
`lengthMismatch` warning (a throw in strict mode). It is the cheapest possible
detector for the failure mode §1.3 describes — a wrong-version operand table
desynchronising the stream — and it must stay 0.
