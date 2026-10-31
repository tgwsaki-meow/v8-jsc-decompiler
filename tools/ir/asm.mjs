// tools/ir/asm.mjs
//
// A tiny, profile-driven assembler, so the self-test can build a CFG of a
// known shape without a .jsc and without a single hardcoded byte.
//
// Everything comes from the profile: the opcode value, the operand types and
// their widths, the register encoding (via src/disasm/frame.mjs) and the
// prefix bytes. Jump deltas are patched in a second pass against the same rule
// the decoder uses -- relative to the OPCODE byte, negated for the one
// backward jump -- so a mistake in either direction shows up as a disagreement
// between the assembler and src/disasm rather than as a passing test.
//
// Operand forms:
//
//   { reg: n }        local register n
//   { param: n }      parameter n (0 = the receiver)
//   { special: 'context' | 'closure' | 'acc' | ... }
//   { imm: v }        a signed immediate
//   { u: v }          an unsigned immediate
//   { label: 'x' }    a jump delta to label x
//   { const: i }      a constant pool index
//   { slot: v }       a feedback / context / coverage slot
//   { table: ['a','b'] }  a jump table: allocates len constant pool slots and
//                         patches each with the delta to that label
//   { regList: [n, count] }  a register list start + its kRegCount

import { frameModel } from '../../src/disasm/frame.mjs';
import { opcodeFacts } from '../../src/disasm/opcode_facts.mjs';

export class Asm {
  constructor(profile) {
    this.profile = profile;
    this.frame = frameModel(profile);
    this.facts = opcodeFacts(profile);
    this.items = [];
    this.constants = [];
    this.handlers = [];
    this.labels = new Map();
  }

  /** Reserve a constant pool slot and return its index. */
  constant(entry) { this.constants.push(entry); return this.constants.length - 1; }

  label(name) { this.items.push({ label: name }); return this; }

  emit(op, operands = []) { this.items.push({ op, operands }); return this; }

  handler(rangeStartLabel, rangeEndLabel, handlerLabel, prediction = 1, data = 0) {
    this.handlers.push({ rangeStartLabel, rangeEndLabel, handlerLabel, prediction, data });
    return this;
  }

  // ------------------------------------------------------------------ build
  build(unitExtra = {}) {
    const p = this.profile;
    // pass 1: sizes and label offsets
    let at = 0;
    const placed = [];
    for (const it of this.items) {
      if (it.label !== undefined) { this.labels.set(it.label, at); continue; }
      const op = p.getOpcode(it.op);
      if (!op) throw new Error(`no opcode ${it.op} in profile ${p.version}`);
      let len = 1;
      for (const t of op.operands) len += p.operandSize(t, 1);
      placed.push({ ...it, offset: at, opcodeOffset: at, op, length: len });
      at += len;
    }
    const size = at;

    // jump tables need their constant pool slots reserved before patching
    for (const ins of placed) {
      ins.op.operands.forEach((t, i) => {
        const o = ins.operands[i];
        if (o && o.table) {
          o.base = o.base ?? 0;
          o.index = this.constants.length;
          for (let k = 0; k < o.table.length; k++) this.constants.push({ t: 'number', v: 0, repr: 'smi' });
        }
      });
    }

    // pass 2: encode
    const buf = Buffer.alloc(size);
    const labelOf = (name) => {
      if (!this.labels.has(name)) throw new Error(`undefined label ${name}`);
      return this.labels.get(name);
    };
    for (const ins of placed) {
      buf[ins.offset] = ins.op.value;
      let at2 = ins.offset + 1;
      ins.op.operands.forEach((t, i) => {
        const size1 = p.operandSize(t, 1);
        const signed = !!p.operandType(t).signed;
        const o = ins.operands[i] ?? { u: 0 };
        let v = 0;
        if (o.reg !== undefined) v = this.frame.toOperand(o.reg);
        else if (o.param !== undefined) v = this.frame.fromParameterIndex(o.param).operand;
        else if (o.special !== undefined) v = this.frame.toOperand(this.frame.idx[o.special === 'acc' ? 'accumulator' : o.special]);
        else if (o.regList !== undefined) v = this.frame.toOperand(o.regList[0]);
        else if (o.label !== undefined) {
          const target = labelOf(o.label);
          v = ins.op.value === this.facts.backwardJumpValue
            ? ins.opcodeOffset - target
            : target - ins.opcodeOffset;
          if (v < 0) throw new Error(`${ins.op.name} at ${ins.offset}: delta ${v} is negative`);
        } else if (o.table !== undefined) {
          v = o.index;
          o.table.forEach((name, k) => {
            this.constants[o.index + k] = { t: 'number', v: labelOf(name) - ins.opcodeOffset, repr: 'smi' };
          });
        } else if (o.count !== undefined) v = o.count;
        else if (o.imm !== undefined) v = o.imm;
        else if (o.u !== undefined) v = o.u;
        else if (o.const !== undefined) v = o.const;
        else if (o.slot !== undefined) v = o.slot;
        if (size1 === 1) signed ? buf.writeInt8(v, at2) : buf.writeUInt8(v & 0xff, at2);
        else if (size1 === 2) signed ? buf.writeInt16LE(v, at2) : buf.writeUInt16LE(v & 0xffff, at2);
        else signed ? buf.writeInt32LE(v, at2) : buf.writeUInt32LE(v >>> 0, at2);
        at2 += size1;
      });
    }

    const handlers = this.handlers.map((h, index) => ({
      index,
      rangeStart: labelOf(h.rangeStartLabel),
      rangeEnd: h.rangeEndLabel === null ? size : labelOf(h.rangeEndLabel),
      handlerOffset: labelOf(h.handlerLabel),
      prediction: h.prediction,
      predictionName: ['UNCAUGHT', 'CAUGHT', 'PROMISE', 'ASYNC_AWAIT', 'UNCAUGHT_ASYNC_AWAIT'][h.prediction] ?? String(h.prediction),
      wasUsed: false,
      data: h.data,
    })).sort((a, b) => a.rangeStart - b.rangeStart);

    return {
      unit: {
        sfiId: 1, bytecodeId: 1, functionLiteralId: 0, name: unitExtra.name ?? 'test',
        kind: 'normal', isGenerator: false, isAsync: false, isStrict: true,
        startPosition: 0, endPosition: 0,
        bytecode: buf, bytecodeLength: size,
        frameSize: null, parameterCount: unitExtra.parameterCount ?? 1,
        maxArguments: 0, registerCount: unitExtra.registerCount ?? 8,
        incomingNewTargetOrGeneratorRegister: unitExtra.incomingNewTargetOrGeneratorRegister ?? -1,
        constants: this.constants,
        handlers,
        sourcePositions: [],
        scope: unitExtra.scope ?? null,
        uncompiled: null, warnings: [], compiled: true,
        ...unitExtra,
      },
      labels: this.labels, size,
    };
  }
}

export function asm(profile) { return new Asm(profile); }
export default { Asm, asm };
