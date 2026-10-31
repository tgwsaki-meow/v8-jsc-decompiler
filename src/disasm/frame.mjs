// src/disasm/frame.mjs
//
// The interpreter register encoding: operand value <-> structured register.
//
// WHY THIS FILE EXISTS AND WHERE ITS NUMBERS COME FROM
// ---------------------------------------------------------------------------
// A register operand is a *signed* integer that V8 converts with
//
//     Register::FromOperand(operand) = Register(kRegisterFileStartOffset - operand)
//     Register::ToOperand()          = kRegisterFileStartOffset - index_
//                                      -- src/interpreter/bytecode-register.h
//
// so decoding needs kRegisterFileStartOffset and the handful of negative
// register indices V8 reserves for frame-header slots. Those come from
//
//     constexpr int OffsetFromFPToRegisterIndex(int offset) {
//       return (InterpreterFrameConstants::kRegisterFileFromFp - offset)
//              / kSystemPointerSize;
//     }
//                                      -- src/interpreter/bytecode-register.h
//
// i.e. from the *frame layout*, not from the bytecode tables. The generated
// profile carries the bytecode tables (bytecodes.json / operands.json) and the
// sizes (constants.json) but NOT InterpreterFrameConstants, so this file
// rebuilds the frame layout from the sizes the profile does carry plus the
// slot-counting arithmetic that frame-constants.h itself states. Every term
// below is annotated with the declaration it mirrors; the only bare integers
// are the slot *ordinals* that appear literally in those declarations (the `3`
// in `3 * kSystemPointerSize`, the `0/1/2` pushed-value indices, ...), which
// are structural, not version-specific:
//
//   CommonFrameConstants                        -- src/execution/frame-constants.h
//     kCallerFPOffset      = 0
//     kCallerPCOffset      = kCallerFPOffset + kFPOnStackSize
//     kCallerSPOffset      = kCallerPCOffset + kPCOnStackSize
//   StandardFrameConstants
//     kFixedFrameSizeFromFp = 3 * kSystemPointerSize + kCPSlotSize
//     kContextOffset        = -(kCPSlotSize + kContextOrFrameTypeSize)
//     kFunctionOffset       = -2 * kSystemPointerSize - kCPSlotSize
//     kArgCOffset           = -3 * kSystemPointerSize - kCPSlotSize
//     kExpressionsOffset    = -4 * kSystemPointerSize - kCPSlotSize
//     kFirstPushedFrameValueOffset = kExpressionsOffset
//   UnoptimizedFrameConstants   (STANDARD_FRAME_EXTRA_PUSHED_VALUE_OFFSET(x)
//                                = kFirstPushedFrameValueOffset - x*kSystemPointerSize)
//     kBytecodeArrayFromFp               = pushed value 0
//     kBytecodeOffsetOrFeedbackCellFromFp = pushed value 1
//     kFeedbackVectorFromFp              = pushed value 2
//     DEFINE_STANDARD_FRAME_SIZES(3) ->
//        kFixedFrameSizeFromFp = StandardFrameConstants::kFixedFrameSizeFromFp
//                              + 3 * kSystemPointerSize
//     kFirstParamFromFp     = StandardFrameConstants::kCallerSPOffset
//     kRegisterFileFromFp   = -kFixedFrameSizeFromFp - kSystemPointerSize
//
// The derived model is then CHECKED, not trusted:
//   * `validate()` re-derives the register indices V8 documents as a sanity
//     net (context/closure/feedback-vector/... must be distinct, negative, and
//     above the first parameter index);
//   * every decoded local index must land in [0, registerCount) and every
//     parameter index in [0, parameterCount) -- asserted per function by
//     src/disasm/index.mjs, which fails loudly instead of mis-decoding;
//   * tools/disasm/selftest.mjs compares every register this file prints with
//     the register V8's own `--print-bytecode` prints, for both profiles.
//
// If a profile ever starts carrying an `interpreterFrame` block (it should --
// see docs/DISASM.md), it is used verbatim and the derivation is skipped.

/** @typedef {{k:string, index:number, operand:number, i?:number}} Reg */

const cache = new WeakMap();

function g(profile, name) {
  const v = profile.constants?.globals?.[name];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Build (and memoise) the frame model for a profile.
 * @param {object} profile a src/profile/index.mjs Profile
 */
export function frameModel(profile) {
  let m = cache.get(profile);
  if (!m) { m = build(profile); cache.set(profile, m); }
  return m;
}

function build(profile) {
  // --- sizes, all from the profile -----------------------------------------
  const sys = profile.constants?.sizes?.kSystemPointerSize ?? g(profile, 'kSystemPointerSize');
  if (!sys) throw new Error('profile does not carry kSystemPointerSize; cannot derive the interpreter frame layout');
  const pcOnStack = g(profile, 'kPCOnStackSize') ?? sys;
  const fpOnStack = g(profile, 'kFPOnStackSize') ?? sys;
  // kCPSlotSize = kFrameCPSlotCount * kSystemPointerSize. Architectures with
  // an embedded constant pool (ppc64, s390x) set the count to 1. The profile
  // carries kFrameCPSlotCount when profilegen could evaluate it; when it
  // cannot, assume no constant-pool slot and say so in `provenance`, because
  // that is the configuration of every architecture V8 still supports a code
  // cache on for this project (x64 / arm64).
  const cpSlotCount = g(profile, 'kFrameCPSlotCount');
  const cpSlotSize = (cpSlotCount ?? 0) * sys;
  const contextOrFrameTypeSize = sys;

  // --- a profile-supplied model wins ---------------------------------------
  const given = profile.constants?.interpreterFrame;

  // --- CommonFrameConstants ------------------------------------------------
  const callerFPOffset = 0;
  const callerPCOffset = callerFPOffset + fpOnStack;
  const callerSPOffset = callerPCOffset + pcOnStack;

  // --- StandardFrameConstants ---------------------------------------------
  const stdFixedFrameSizeFromFp = 3 * sys + cpSlotSize;
  const contextOffset = -(cpSlotSize + contextOrFrameTypeSize);
  const functionOffset = -2 * sys - cpSlotSize;
  const argCOffset = -3 * sys - cpSlotSize;
  const expressionsOffset = -4 * sys - cpSlotSize;

  // --- UnoptimizedFrameConstants / InterpreterFrameConstants --------------
  const pushed = (x) => expressionsOffset - x * sys;
  const bytecodeArrayFromFp = pushed(0);
  const bytecodeOffsetFromFp = pushed(1);
  const feedbackVectorFromFp = pushed(2);
  const unoptFixedFrameSizeFromFp = stdFixedFrameSizeFromFp + 3 * sys;
  const firstParamFromFp = callerSPOffset;
  const registerFileFromFp = -unoptFixedFrameSizeFromFp - sys;

  const toIndex = (offsetFromFp) => (registerFileFromFp - offsetFromFp) / sys;

  const derived = {
    registerFileStart: toIndex(0),
    firstParam: toIndex(firstParamFromFp),
    closure: toIndex(functionOffset),
    context: toIndex(contextOffset),
    bytecodeArray: toIndex(bytecodeArrayFromFp),
    bytecodeOffset: toIndex(bytecodeOffsetFromFp),
    feedbackVector: toIndex(feedbackVectorFromFp),
    accumulator: toIndex(callerPCOffset), // Register::virtual_accumulator()
    argumentCount: toIndex(argCOffset),
  };

  const idx = given ? { ...derived, ...given } : derived;
  const model = new FrameModel(idx, {
    provenance: given ? 'profile.constants.interpreterFrame' : 'derived from frame-constants.h arithmetic',
    systemPointerSize: sys,
    constantPoolSlotKnown: cpSlotCount !== undefined,
    offsets: {
      registerFileFromFp, firstParamFromFp, contextOffset, functionOffset,
      argCOffset, bytecodeArrayFromFp, bytecodeOffsetFromFp,
      feedbackVectorFromFp, callerPCOffset,
    },
  });
  model.validate();
  return model;
}

export class FrameModel {
  constructor(idx, meta) {
    this.idx = idx;
    this.meta = meta;
    // index -> kind, for the handful of reserved negative indices
    this.special = new Map([
      [idx.context, 'context'],
      [idx.closure, 'closure'],
      [idx.accumulator, 'acc'],
      [idx.bytecodeArray, 'bytecodeArray'],
      [idx.bytecodeOffset, 'bytecodeOffset'],
      [idx.feedbackVector, 'feedbackVector'],
      [idx.argumentCount, 'argumentCount'],
    ]);
  }

  /** Structural sanity net on the derived indices. */
  validate() {
    const i = this.idx;
    const problems = [];
    for (const [k, v] of Object.entries(i)) {
      if (!Number.isInteger(v)) problems.push(`${k} is not an integer (${v})`);
    }
    const reserved = ['context', 'closure', 'accumulator', 'bytecodeArray', 'bytecodeOffset', 'feedbackVector', 'argumentCount'];
    for (const k of reserved) {
      if (i[k] >= 0) problems.push(`${k} index ${i[k]} is not negative`);
      if (i[k] <= i.firstParam) problems.push(`${k} index ${i[k]} collides with the parameter range (first param ${i.firstParam})`);
    }
    if (new Set(reserved.map((k) => i[k])).size !== reserved.length) {
      problems.push(`reserved register indices are not distinct: ${reserved.map((k) => `${k}=${i[k]}`).join(' ')}`);
    }
    if (i.registerFileStart >= 0) problems.push(`registerFileStart ${i.registerFileStart} should be negative`);
    if (problems.length) {
      throw new Error(`interpreter frame model is inconsistent (${this.meta.provenance}):\n  ${problems.join('\n  ')}`);
    }
    return this;
  }

  /** Register index -> operand value. Register::ToOperand(). */
  toOperand(index) { return this.idx.registerFileStart - index; }

  /** Operand value -> register index. Register::FromOperand(). */
  toIndex(operand) { return this.idx.registerFileStart - operand; }

  /**
   * Operand value -> the structured register of ARCHITECTURE.md 8.3.
   * @param {number} operand signed operand value
   * @returns {Reg}
   */
  decode(operand) {
    const index = this.toIndex(operand);
    return this.fromIndex(index);
  }

  /** @returns {Reg} */
  fromIndex(index) {
    const operand = this.toOperand(index);
    const sp = this.special.get(index);
    if (sp) return { k: sp, index, operand };
    if (index >= 0) return { k: 'local', index, operand, i: index };
    if (index <= this.idx.firstParam) return { k: 'param', index, operand, i: this.idx.firstParam - index };
    return { k: 'invalid', index, operand };
  }

  /** Parameter index (0 = receiver) -> structured register. */
  fromParameterIndex(i) { return this.fromIndex(this.idx.firstParam - i); }

  /** Local register index -> structured register. */
  fromLocalIndex(i) { return this.fromIndex(i); }

  /**
   * V8's own printed form, for a listing that diffs against --print-bytecode.
   * Mirrors Register::ToString() (src/interpreter/bytecode-register.cc)
   * including its precedence: context, closure, accumulator, then "is a
   * parameter" == index < 0, then the register file.
   */
  toString(reg) {
    const index = reg.index;
    if (index === this.idx.context) return '<context>';
    if (index === this.idx.closure) return '<closure>';
    if (index === this.idx.accumulator) return '<accumulator>';
    if (index < 0) {
      const p = this.idx.firstParam - index;
      return p === 0 ? '<this>' : `a${p - 1}`;
    }
    return `r${index}`;
  }

  describe() {
    const i = this.idx;
    return [
      `interpreter frame model (${this.meta.provenance})`,
      `  kSystemPointerSize ${this.meta.systemPointerSize}`
      + `  constant-pool slot ${this.meta.constantPoolSlotKnown ? 'from profile' : 'assumed absent'}`,
      `  registerFileStart ${i.registerFileStart}  firstParam ${i.firstParam}`,
      `  context ${i.context}  closure ${i.closure}  acc ${i.accumulator}`,
      `  bytecodeArray ${i.bytecodeArray}  bytecodeOffset ${i.bytecodeOffset}`
      + `  feedbackVector ${i.feedbackVector}  argumentCount ${i.argumentCount}`,
      `  operand(r0)=${this.toOperand(0)}  operand(<this>)=${this.fromParameterIndex(0).operand}`
      + `  operand(a0)=${this.fromParameterIndex(1).operand}`,
    ].join('\n');
  }
}

export default { frameModel, FrameModel };
