// Normaliser: turn a parsed bytecode listing into a token stream in which two
// structurally identical programs compare equal.
//
// ===========================================================================
// WHAT IS ERASED, AND WHY EACH ERASURE IS SAFE
// ===========================================================================
//
// 1. ABSOLUTE LOCAL REGISTER NUMBERS -> first-appearance identity classes.
//    `r7` becomes `R0` if it is the first local register mentioned, `r2`
//    becomes `R1` if it is the second, and so on; the same source register
//    always maps to the same class and two different registers never share a
//    class.
//    Safe because: BytecodeRegisterAllocator hands out indices by frame slot,
//    and the frame layout depends on how many temporaries the generator needed
//    earlier in the function -- which shifts when an unrelated earlier
//    expression changes, without changing this instruction's meaning. What is
//    semantically load-bearing is the def/use relation ("this Ldar reads what
//    that Star wrote"), and a first-appearance bijection preserves exactly
//    that relation and nothing else.
//    NOT erased: parameter registers (`a0`, `a1`, ...). Their index *is*
//    semantics -- a0 is the first argument. Same for `<context>`, `<closure>`,
//    `<this>`, `<new.target>`.
//    Register ranges (`r1-r4`, used for call argument lists) map their start
//    register through the same bijection and keep their *length*, because
//    V8 requires the range to be contiguous, so the length carries the arity
//    while the absolute start does not.
//
// 2. FEEDBACK VECTOR SLOT INDICES -> erased to `FB[*]`.
//    Safe because: slots are allocated sequentially by FeedbackVectorSpec as
//    the generator walks the AST, so the index of a slot is a running counter
//    over all preceding feedback-consuming operations. It identifies nothing
//    about the operation itself. The *presence* of a feedback operand is kept
//    (the token is still there, in the same position), so an instruction that
//    gained or lost a feedback operand still compares unequal.
//    Cross-version note: V8 14.4 prints `FBV[n]` (kFeedbackSlot, scalable) and
//    14.6 prints `EmbeddedFeedback[0xN]` (kEmbeddedFeedback, fixed uint16) for
//    the six comparison bytecodes. Both normalise to `FB[*]` *on purpose*, so
//    that a 14.4 stream and a 14.6 stream of the same program still compare
//    equal. The cost: normalised streams must never be used to reason about
//    encoded instruction length across versions. Raw byte lengths are kept in
//    the structured form for that.
//
// 3. CONSTANT POOL INDICES -> replaced by the resolved value.
//    `[3:"m"]` becomes `K("m")`. Safe because: the index is the position in a
//    pool built in emission order, so inserting an unrelated earlier constant
//    renumbers every later one. The value is the semantics.
//    Heap-object constants are printed by V8 as `0xADDR <Descriptor>`; the
//    address is erased and the descriptor kept (`<ScopeInfo CATCH_SCOPE>`,
//    `<SharedFunctionInfo get g>`, `<ObjectBoilerplateDescription[2]>`), which
//    keeps the type and shape while dropping the run-to-run address.
//    When the engine did not dump the pool and the instruction did not print
//    the value inline, the token degrades to `K#<index>` and the function is
//    flagged `constantPoolResolution: 'partial'`. Such a function is still
//    comparable but a difference in a `K#` token is not trustworthy, so the
//    comparator reports it separately.
//
// 4. ABSOLUTE JUMP OFFSETS -> labels.
//    A jump's immediate operand (`Jump [8]`) and V8's resolved target
//    annotation (`(0x... @ 45)`) both encode a byte offset that moves whenever
//    any instruction between source and target changes width. Every distinct
//    jump target in the function gets a label `L0, L1, ...` numbered by
//    increasing target offset, and jumps emit `->L<k>`; the targeted
//    instruction emits a leading `L<k>:` marker. Jump tables emit
//    `{case: ->L<k>}`.
//    Safe because: the labels are derived from the engine's own resolved
//    targets, so "which instruction is jumped to" is preserved exactly, while
//    the byte distance -- a pure encoding artifact -- is dropped. The label
//    marker on the target is what makes the erasure lossless: without it, two
//    different control-flow graphs could collapse to the same token list.
//    `JumpLoop`'s backward delta is handled the same way; V8 prints its
//    resolved target too.
//
// 5. SOURCE POSITIONS -> excluded from the normalised stream (kept in the
//    structured form).
//    Safe for the comparisons this oracle makes, and *necessary* for them:
//    source positions are character offsets into the source text, so renaming
//    a variable shifts every later position. They say nothing about the
//    emitted code. The statement/expression *flag* is also excluded, since it
//    is attached to a position.
//
// 6. RAW BYTES and ADDRESSES -> excluded from the normalised stream.
//    The bytes encode exactly the four things erased above (register numbers,
//    feedback slots, pool indices, jump deltas) plus the opcode, which is kept
//    symbolically. Keeping them would re-introduce every erasure.
//
// NOT erased (deliberately): the opcode, the operand *arity* and *kind order*,
// the operand scale prefix (`.Wide` / `.ExtraWide`) is erased because it is a
// width artifact of the erased values -- see WIDTH NOTE below -- runtime and
// intrinsic callee names, flag8/flag16 immediates (`#29` -- these are real
// literal flags such as object-literal shape bits), non-jump immediates
// (`LdaSmi [1]`, `LdaImmutableCurrentContextSlot [2]`, `BitwiseOrSmi [0]`),
// handler table ranges, parameter count, and the structural counts.
//
// WIDTH NOTE: `.Wide` / `.ExtraWide` prefixes exist only because an operand
// value did not fit in one byte, and the operand values that commonly force
// them (register numbers, feedback slots, pool indices, jump deltas) are all
// erased. Keeping the prefix would make two equivalent streams differ purely
// because one function happened to have more than 256 registers. It is
// therefore erased, and the structured form keeps it.

import { stripAddress } from './bytecode_parser.mjs';

const SPECIAL_REGS = new Set(['context', 'closure', 'this', 'new.target']);

/**
 * SHORT-STAR NORMALISATION
 *
 * `SHORT_STAR_BYTECODE_LIST` (src/interpreter/bytecodes.h) gives Star0..Star15
 * their own opcodes with the register encoded in the opcode byte instead of in
 * an operand. Left alone, a register-allocation shift would turn `Star0` into
 * `Star3` -- a different *opcode* -- and defeat rule 1 entirely; and the long
 * form `Star r0`, which V8 emits once the index exceeds 15, would never match
 * the short form of the same operation.
 *
 * So a short star is rewritten to the long form before normalising: opcode
 * `Star` with a synthetic register operand. This folds an encoding choice that
 * is purely a function of the (erased) register number into the register rule,
 * where it belongs.
 */
function expandShortStar(ins) {
  const m = /^Star(\d+)$/.exec(ins.opcode ?? '');
  if (!m) return ins;
  return { ...ins, opcode: 'Star', operands: [{ kind: 'reg', index: +m[1], raw: `r${m[1]}`, synthetic: true }] };
}

/** Build the label map for a function: target offset -> label index. */
function buildLabels(fn) {
  const targets = new Set();
  for (const ins of fn.instructions) {
    if (ins.jumpTarget != null) targets.add(ins.jumpTarget);
    if (ins.jumpTable) for (const e of ins.jumpTable) targets.add(e.target);
  }
  const sorted = [...targets].sort((a, b) => a - b);
  const map = new Map();
  sorted.forEach((off, i) => map.set(off, i));
  return map;
}

/** True when a bracketed immediate on this opcode is a jump delta. */
function isJumpDeltaOperand(opcode, opIndex) {
  // src/interpreter/bytecodes.h: every Jump* bytecode takes its delta as the
  // first operand (kUImm for forward jumps, kUImm + loop depth for JumpLoop);
  // the *Constant variants take a constant-pool index instead, which the
  // constant rule already handles.
  return /^Jump/.test(opcode) && opIndex === 0;
}

function normalizeConstantValue(value) {
  if (value == null) return null;
  // Heap-object constants print as `0xADDR <Descriptor>`; the address is a
  // per-run artifact of where the object happened to be allocated, so drop it
  // and keep the descriptor.
  return stripAddress(String(value)).replace(/\s+/g, ' ').trim();
}

/**
 * Normalise one function.
 * @returns {{tokens: string[], stream: string, perInstruction: string[], regClasses: Map, labels: Map, resolution: string}}
 */
export function normalizeFunction(fn) {
  const labels = buildLabels(fn);
  const regClass = new Map(); // local register index -> class id
  const classOf = (idx) => {
    if (!regClass.has(idx)) regClass.set(idx, regClass.size);
    return regClass.get(idx);
  };

  const perInstruction = [];
  let partialConstants = 0;

  for (const rawIns of fn.instructions) {
    const ins = expandShortStar(rawIns);
    const pieces = [];
    const label = labels.get(ins.offset);
    if (label != null) pieces.push(`L${label}:`);
    pieces.push(ins.opcode ?? '?');

    ins.operands.forEach((op, i) => {
      switch (op.kind) {
        case 'reg':
          pieces.push(`R${classOf(op.index)}`);
          break;
        case 'param':
          pieces.push(`A${op.index}`);
          break;
        case 'specialReg':
          pieces.push(SPECIAL_REGS.has(op.name) ? `<${op.name}>` : `<${op.name}>`);
          break;
        case 'regRange': {
          const len = op.to - op.from + 1;
          if (op.fromKind === 'param') pieces.push(`A${op.from}+${len}`);
          else pieces.push(`R${classOf(op.from)}+${len}`);
          break;
        }
        case 'feedback':
        case 'embeddedFeedback':
          pieces.push('FB[*]');
          break;
        case 'flag':
          pieces.push(`#${op.value}`);
          break;
        case 'constant': {
          const v = normalizeConstantValue(op.value);
          pieces.push(v == null || v === '' ? `K#${op.index}` : `K(${v})`);
          break;
        }
        case 'imm':
          if (isJumpDeltaOperand(ins.opcode ?? '', i) && ins.jumpTarget != null) {
            pieces.push(`->L${labels.get(ins.jumpTarget)}`);
          } else if (isJumpDeltaOperand(ins.opcode ?? '', i)) {
            pieces.push('->?');
          } else {
            pieces.push(`[${op.value}]`);
          }
          break;
        case 'name':
          pieces.push(`<<${op.name}>>`);
          break;
        default:
          pieces.push(op.text ?? '');
      }
    });

    // Non-jump instructions never carry a resolved target annotation, so a
    // target here always belongs to a jump whose delta we already turned into
    // a label. Jump tables need their own tokens.
    if (ins.jumpTable) {
      pieces.push('{' + ins.jumpTable.map((e) => `${e.caseValue}:->L${labels.get(e.target)}`).join(',') + '}');
    } else if (ins.jumpTarget != null && !/^Jump/.test(ins.opcode ?? '')) {
      pieces.push(`->L${labels.get(ins.jumpTarget)}`);
    }

    // Count constants we could not resolve (reported, not silently accepted).
    for (const op of ins.operands) {
      if (op.kind === 'constant' && (op.value == null || op.value === '')) partialConstants++;
    }

    perInstruction.push(pieces.join(' '));
  }

  // Handler ranges are expressed in byte offsets too. Map them onto the
  // instruction *index* space, which is stable under re-encoding.
  const offsetToIndex = new Map(fn.instructions.map((ins, i) => [ins.offset, i]));
  const handlers = fn.handlerTable.map((h) => ({
    fromIndex: offsetToIndex.has(h.from) ? offsetToIndex.get(h.from) : `off:${h.from}`,
    toIndex: offsetToIndex.has(h.to) ? offsetToIndex.get(h.to) : `off:${h.to}`,
    handlerIndex: offsetToIndex.has(h.handler) ? offsetToIndex.get(h.handler) : `off:${h.handler}`,
    prediction: h.prediction,
    // `data` is a register index holding the finally-token -> an identity class
    data: h.data < 0 ? h.data : `R?${h.data}`,
  }));

  return {
    name: fn.name,
    parameterCount: fn.parameterCount,
    instructionCount: fn.instructions.length,
    // A release d8 prints `Handler Table (size = N)` but not the entries
    // (entry printing needs object printing, which is compiled out), so the
    // handler stream is only comparable when both sides actually listed them.
    handlerTableSize: fn.handlerTableSize,
    handlersListed: fn.handlerTable.length > 0 || fn.handlerTableSize === 0,
    perInstruction,
    opcodes: fn.instructions.map((i) => expandShortStar(i).opcode ?? '?'),
    stream: perInstruction.join('\n'),
    handlers,
    handlerStream: handlers.map((h) => `H ${h.fromIndex}..${h.toIndex} -> ${h.handlerIndex} p=${h.prediction}`).join('\n'),
    registerClassCount: regClass.size,
    labelCount: labels.size,
    constantPoolResolution: fn.constantPoolResolution,
    unresolvedConstantOperands: partialConstants,
  };
}

export function normalizeDump(parsed) {
  return parsed.functions.map(normalizeFunction);
}

export { buildLabels, isJumpDeltaOperand };
