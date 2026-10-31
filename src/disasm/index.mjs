// src/disasm/index.mjs
//
// Stage A of ARCHITECTURE.md 4.1: a FunctionUnit (8.1) -> Instruction[] (8.2).
//
// Everything version-dependent is read from the profile through
// src/disasm/opcode_facts.mjs and src/disasm/frame.mjs. This file contains the
// decoding *rules*, which are version-independent:
//
//   instruction  = [prefix] opcode operand*
//   operand size = scalable ? baseSize * scale : baseSize      (operands.json)
//   scale        = prefix ? prefixes[prefix].scale : 1          (bytecodes.json)
//
//   jump target  = opcodeByteOffset + delta
//                  delta is negated for the one backward jump (JumpLoop)
//                  delta is the kUImm operand, or the Smi named by the
//                  kConstantPoolIndex operand for the *Constant variants
//                  -- BytecodeArrayIterator::GetRelativeJumpTargetOffset and
//                     GetAbsoluteOffset(rel) = current_offset() + rel + prefix_size_
//                     (src/interpreter/bytecode-array-iterator.cc)
//                  NOTE the `+ prefix_size_`: the delta is relative to the
//                  OPCODE byte, not to the start of the instruction. They
//                  differ by one for every Wide/ExtraWide jump, which is why
//                  src/lifter.js's `opcodeOffset = pc - 1` happened to work
//                  and a naive `instruction.offset + delta` would not.
//
//   jump table   = table_size consecutive constant-pool Smis starting at
//                  table_start; entry j is case value (case_value_base + j)
//                  and target opcodeByteOffset + Smi
//                  -- JumpTableTargetOffsets (same file). Identical in 14.4
//                     and 14.6; both CHECK that every entry in the span is a
//                     Smi, so a non-Smi entry is reported, never skipped.
//
//   source pos   = V8 walks the decoded SourcePositionTable in lockstep with
//                  the instruction stream and consumes one entry when
//                  current_offset() == code_offset()
//                  -- BytecodeArray::Disassemble (src/objects/bytecode-array.cc).
//                  Reproduced exactly so our listing lines up with V8's.

import { opcodeFacts } from './opcode_facts.mjs';
import { frameModel } from './frame.mjs';

export class DisasmError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

/** Pull a Smi out of a 8.1 constant-pool entry. */
function smiValue(c) {
  if (typeof c === 'number') return Number.isInteger(c) ? c : null;
  if (c && c.t === 'number' && Number.isInteger(c.v)) return c.v;
  return null;
}

function readOperand(buf, at, size, signed) {
  switch (size) {
    case 1: return signed ? buf.readInt8(at) : buf[at];
    case 2: return signed ? buf.readInt16LE(at) : buf.readUInt16LE(at);
    case 4: return signed ? buf.readInt32LE(at) : buf.readUInt32LE(at);
    default: return signed ? buf.readIntLE(at, size) : buf.readUIntLE(at, size);
  }
}

/**
 * Index the decoded source position table the way V8's disassembler walks it.
 * Entries with a negative code offset (the function-entry entry,
 * kFunctionEntryBytecodeOffset) are skipped, as SourcePositionTableIterator
 * does by default.
 */
function sourcePositionCursor(unit) {
  const list = (unit.sourcePositions ?? []).filter((e) => e && e.codeOffset >= 0);
  let i = 0;
  return {
    total: list.length,
    consumed: 0,
    /** @returns {null | {sourcePosition:number, isStatement:boolean, isBreakable:boolean}} */
    take(offset) {
      if (i >= list.length) return null;
      if (list[i].codeOffset !== offset) return null;
      const e = list[i++];
      this.consumed++;
      return e;
    },
  };
}

/**
 * Disassemble one FunctionUnit.
 *
 * @param {object} unit  the 8.1 FunctionUnit
 * @param {{profile: object, strict?: boolean, resolveConstants?: boolean}} opts
 * @returns {{instructions: Array, byOffset: Map<number,number>, warnings: Array, stats: object, frame: object}}
 */
export function disassemble(unit, opts) {
  const profile = opts?.profile;
  if (!profile) throw new DisasmError('disassemble() needs { profile }');
  const strict = opts?.strict ?? true;
  const resolveConstants = opts?.resolveConstants ?? true;

  const facts = opcodeFacts(profile);
  const frame = frameModel(profile);
  const buf = unit.bytecode;
  if (!buf || typeof buf.length !== 'number') {
    throw new DisasmError('FunctionUnit.bytecode must be a Buffer', { unit: unit.bytecodeId ?? unit.sfiId });
  }
  const len = buf.length;
  const constants = unit.constants ?? [];
  const registerCount = unit.registerCount ?? null;
  const parameterCount = unit.parameterCount ?? null;

  const instructions = [];
  const byOffset = new Map();
  const warnings = [];
  const lengthMismatch = new Map();
  const opcodeHistogram = new Map();
  const srcPos = sourcePositionCursor(unit);

  let jumps = 0, jumpTables = 0, jumpTableEntries = 0, jumpTableHoles = 0;
  let shortStars = 0, prefixed = 0, maxScale = 1;
  let badRegisters = 0, unresolvedJumps = 0;

  const warn = (code, detail) => {
    warnings.push({ code, ...detail });
    if (strict && (code === 'illegalOpcode' || code === 'truncated' || code === 'lengthMismatch')) {
      throw new DisasmError(`${code} at offset ${detail.offset}: ${detail.message}`, detail);
    }
  };

  let pc = 0;
  while (pc < len) {
    const offset = pc;
    let byte = buf[pc];
    let scale = 1;
    let prefix = null;
    const pfx = facts.prefixByByte.get(byte);
    if (pfx) {
      scale = pfx.scale;
      prefix = pfx.name;
      prefixed++;
      if (scale > maxScale) maxScale = scale;
      pc++;
      if (pc >= len) {
        warn('truncated', { offset, message: `bytecode ends after the ${prefix} prefix` });
        break;
      }
      byte = buf[pc];
    }
    const opcodeOffset = pc;
    pc++;

    const plan = facts.plans.get(scale)[byte];
    if (!plan) {
      warn('illegalOpcode', { offset, message: `byte 0x${byte.toString(16)} is not an opcode in profile ${profile.version}` });
      break;
    }
    const op = plan.op;
    if (byte === profile.illegalOpcode) {
      warn('illegalOpcode', { offset, message: `${op.name} (0x${byte.toString(16)}) must not appear in a BytecodeArray` });
      break;
    }
    if (facts.prefixByByte.has(byte)) {
      warn('illegalOpcode', { offset, message: `${op.name} is an operand-scaling prefix and cannot follow another prefix` });
      break;
    }
    const operandsEnd = pc + (plan.bodyLength - 1);
    if (operandsEnd > len) {
      warn('truncated', { offset, message: `${op.name} needs ${plan.bodyLength - 1} operand bytes but only ${len - pc} remain` });
      break;
    }

    // ----------------------------------------------------------- operands
    const operands = new Array(plan.operands.length);
    for (let k = 0; k < plan.operands.length; k++) {
      const spec = plan.operands[k];
      const raw = readOperand(buf, pc + spec.offset, spec.size, spec.signed);
      operands[k] = decodeOperand(spec, raw, {
        plan, k, buf, pc, frame, profile, constants, resolveConstants,
      });
    }
    pc = operandsEnd;

    // ------------------------------------------- short-star normalisation
    const shortStarIdx = facts.shortStarIndex.get(byte);
    let opcodeName = op.name;
    let implicitRegisterUse = op.implicitRegisterUse;
    let isShortStar = false;
    if (shortStarIdx !== undefined) {
      isShortStar = true;
      shortStars++;
      opcodeName = facts.longStar.name;
      implicitRegisterUse = facts.longStar.implicitRegisterUse;
      operands.push({
        type: facts.longStar.operands[0],
        reg: frame.fromLocalIndex(shortStarIdx),
        fromOpcode: true,
      });
    }

    // ------------------------------------------------------- jump target
    let jumpTarget = null;
    const delta = facts.jumpDeltaOperand(byte);
    if (delta) {
      jumps++;
      let rel = null;
      if (delta.via === 'immediate') {
        rel = operands[delta.index].value;
      } else {
        const idx = operands[delta.index].index;
        rel = smiValue(constants[idx]);
        if (rel === null) {
          unresolvedJumps++;
          warn('unresolvedJumpConstant', {
            offset, opcode: opcodeName,
            message: `constant pool entry ${idx} is not a Smi, so the jump delta is unknown`,
            constantIndex: idx,
          });
        }
      }
      if (rel !== null) {
        if (byte === facts.backwardJumpValue) rel = -rel;
        jumpTarget = opcodeOffset + rel;
      }
    }

    // -------------------------------------------------------- jump table
    let jumpTable = null;
    const roles = facts.switchRoles.get(byte);
    if (roles) {
      const start = operands[roles.tableStart].index;
      const count = operands[roles.tableLength].value;
      const base = roles.caseBase === null ? 0 : operands[roles.caseBase].value;
      jumpTable = [];
      for (let j = 0; j < count; j++) {
        const ci = start + j;
        const smi = smiValue(constants[ci]);
        if (smi === null) {
          jumpTableHoles++;
          jumpTable.push({ caseValue: base + j, target: null, constantIndex: ci, unresolved: true });
          warn('unresolvedJumpTableEntry', {
            offset, opcode: opcodeName, constantIndex: ci,
            message: `jump table entry ${j} (constant ${ci}) is not a Smi`,
          });
          continue;
        }
        jumpTable.push({ caseValue: base + j, target: opcodeOffset + smi, constantIndex: ci });
        jumpTableEntries++;
      }
      jumpTables++;
    }

    // ---------------------------------------------------- source position
    const sp = srcPos.take(offset);

    // ------------------------------------------------- length cross-check
    const length = pc - offset;
    const expected = (prefix ? 1 : 0) + profile.instructionLength(byte, scale);
    if (length !== expected) {
      const key = `${opcodeName}${prefix ? '.' + prefix : ''}`;
      lengthMismatch.set(key, (lengthMismatch.get(key) ?? 0) + 1);
      warn('lengthMismatch', {
        offset, opcode: opcodeName,
        message: `decoded ${length} bytes but profile.instructionLength says ${expected}`,
      });
    }

    const ins = {
      index: instructions.length,
      offset,
      length,
      opcode: opcodeName,
      scale,
      operands,
      jumpTarget,
      jumpTable,
      sourcePosition: sp ? sp.sourcePosition : null,
      isStatement: sp ? !!sp.isStatement : false,
      // additive (not in 8.2, documented in docs/DISASM.md)
      isBreakable: sp ? !!sp.isBreakable : false,
      implicitRegisterUse,
      opcodeValue: byte,
      opcodeOffset,
      prefix,
      rawOpcode: op.name,
      isShortStar,
    };
    instructions.push(ins);
    byOffset.set(offset, ins.index);
    opcodeHistogram.set(opcodeName, (opcodeHistogram.get(opcodeName) ?? 0) + 1);

    // ------------------------------------------ register range validation
    if (registerCount !== null || parameterCount !== null) {
      for (const o of operands) {
        const regs = o.reg ? [o.reg] : (o.regs ?? null);
        if (!regs) continue;
        for (const r of regs) {
          if (r.k === 'local' && registerCount !== null && (r.i < 0 || r.i >= registerCount)) {
            badRegisters++;
            warn('registerOutOfRange', {
              offset, opcode: opcodeName,
              message: `local register r${r.i} is outside [0,${registerCount}) -- the frame model or the unit's registerCount is wrong`,
            });
          } else if (r.k === 'param' && parameterCount !== null && (r.i < 0 || r.i >= parameterCount)) {
            badRegisters++;
            warn('registerOutOfRange', {
              offset, opcode: opcodeName,
              message: `parameter ${r.i} is outside [0,${parameterCount}) (parameter count includes the receiver)`,
            });
          }
        }
      }
    }
  }

  // ------------------------------------------- jump targets must be leaders
  let danglingTargets = 0;
  for (const ins of instructions) {
    if (ins.jumpTarget !== null && !byOffset.has(ins.jumpTarget)) {
      danglingTargets++;
      warnings.push({
        code: 'jumpTargetNotAnInstruction', offset: ins.offset, opcode: ins.opcode,
        message: `jump target ${ins.jumpTarget} is not the start of any instruction`,
      });
    }
    if (ins.jumpTable) {
      for (const e of ins.jumpTable) {
        if (e.target !== null && !byOffset.has(e.target)) {
          danglingTargets++;
          warnings.push({
            code: 'jumpTableTargetNotAnInstruction', offset: ins.offset, opcode: ins.opcode,
            message: `jump table case ${e.caseValue} targets ${e.target}, which is not the start of any instruction`,
          });
        }
      }
    }
  }

  const stats = {
    bytecodeLength: len,
    decodedBytes: pc,
    instructions: instructions.length,
    prefixed,
    maxScale,
    shortStars,
    jumps,
    jumpTargetsResolved: instructions.filter((i) => i.jumpTarget !== null).length,
    unresolvedJumps,
    jumpTables,
    jumpTableEntries,
    jumpTableHoles,
    danglingTargets,
    badRegisters,
    sourcePositionsTotal: srcPos.total,
    sourcePositionsAttached: srcPos.consumed,
    lengthMismatch,
    opcodeHistogram,
    warnings: warnings.length,
  };

  return { unit, instructions, byOffset, warnings, stats, frame, profile };
}

/** Decode one operand into its 8.2 form. */
function decodeOperand(spec, raw, ctx) {
  const { type } = spec;
  const { plan, k, buf, pc, frame, profile, constants, resolveConstants } = ctx;

  if (spec.isRegister) {
    if (spec.regCount === null) {
      // kRegList / kRegOutList: the count lives in the following kRegCount
      // operand (DCHECKed by BytecodeDecoder::Decode). V8 builds
      // RegisterList(first.index(), count), i.e. the registers run UPWARD in
      // register index and therefore DOWNWARD in operand value.
      const cnt = plan.operands[k + 1];
      const count = readOperand(buf, pc + cnt.offset, cnt.size, cnt.signed);
      const start = frame.decode(raw);
      const regs = new Array(count);
      for (let j = 0; j < count; j++) regs[j] = frame.fromIndex(start.index + j);
      return { type, start, count, regs };
    }
    const start = frame.decode(raw);
    if (spec.regCount === 1) return { type, reg: start };
    const regs = new Array(spec.regCount);
    for (let j = 0; j < spec.regCount; j++) regs[j] = frame.fromIndex(start.index + j);
    return { type, start, regs };
  }

  switch (type) {
    case 'kRegCount':
      return { type, count: raw };
    case 'kConstantPoolIndex': {
      const o = { type, index: raw };
      if (resolveConstants) o.constant = constants[raw] ?? { t: 'unresolved', why: 'outOfRange', detail: `constant pool index ${raw} >= ${constants.length}` };
      return o;
    }
    case 'kFeedbackSlot':
    case 'kEmbeddedFeedback':
      return { type, slot: raw };
    case 'kContextSlot':
    case 'kCoverageSlot':
      return { type, slot: raw };
    case 'kRuntimeId':
      return { type, id: raw, name: profile.runtimeName(raw) };
    case 'kIntrinsicId': {
      // 8.2 wants the intrinsic's own name. V8's listing prints something
      // else: BytecodeDecoder renders kIntrinsicId as
      //   NameForRuntimeId(IntrinsicsHelper::ToRuntimeId(id))
      // and ToRuntimeId maps IntrinsicId::kX to Runtime::FunctionId::kInlineX,
      // whose Runtime::Function::name is "_X" ("_" #name in the I() macro of
      // src/runtime/runtime.h). Keep both: `name` for consumers, `printedName`
      // for the formatter, so a listing diff against V8 lines up.
      const name = profile.intrinsicName(raw);
      const inline = name === null ? null : (profile.runtimeName(profile.runtimeId('_' + name)) ?? '_' + name);
      return { type, id: raw, name, printedName: inline };
    }
    case 'kNativeContextIndex':
      return { type, index: raw };
    case 'kAbortReason':
      return { type, reason: raw };
    case 'kFlag8':
    case 'kFlag16':
      return { type, value: raw };
    case 'kImm':
    case 'kUImm':
      return { type, value: raw };
    default:
      return { type, value: raw };
  }
}

/** Disassemble every FunctionUnit of a module, collecting per-unit results. */
export function disassembleAll(units, opts) {
  const results = [];
  const failures = [];
  for (const unit of units) {
    try {
      results.push(disassemble(unit, opts));
    } catch (e) {
      failures.push({ unit: unit.bytecodeId ?? unit.sfiId ?? null, name: unit.name ?? null, error: e.message });
    }
  }
  return { results, failures };
}

export { opcodeFacts, frameModel };
export default { disassemble, disassembleAll, DisasmError };
