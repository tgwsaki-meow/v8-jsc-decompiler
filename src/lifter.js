import { V8Profile } from './profile.js';

export class Instruction {
  constructor(offset, opcodeInfo, operandsRaw, operandsDecoded, scale = 1, size = 1, jumpTarget = null) {
    this.offset = offset;
    this.name = opcodeInfo.name;
    this.value = opcodeInfo.value;
    this.hex = opcodeInfo.hex;
    this.implicit = opcodeInfo.implicit_register_use;
    this.operandsRaw = operandsRaw;
    this.operandsDecoded = operandsDecoded;
    this.scale = scale;
    this.size = size;
    this.jumpTarget = jumpTarget;
  }

  toString() {
    const ops = this.operandsDecoded.join(', ');
    const targetStr = this.jumpTarget !== null ? ` -> [0x${this.jumpTarget.toString(16)}]` : '';
    return `${this.offset.toString(16).padStart(4, '0')} : ${this.name} ${ops}${targetStr}`.trim();
  }
}

export class BasicBlock {
  constructor(id, startOffset) {
    this.id = id;
    this.startOffset = startOffset;
    this.endOffset = startOffset;
    this.instructions = [];
    this.predecessors = [];
    this.successors = [];
    this.condition = null;
    this.branchTarget = null;
    this.fallthroughTarget = null;
  }
}

export class Lifter {
  constructor(profile = new V8Profile()) {
    this.profile = profile;
  }

  disassemble(bytecodeBuf, constants = []) {
    const instructions = [];
    let pc = 0;
    const len = bytecodeBuf.length;

    while (pc < len) {
      const startOffset = pc;
      let byte = bytecodeBuf[pc++];
      let scale = 1;

      if (byte === 0x00) {
        scale = 2; // Wide
        if (pc >= len) {
          throw new Error(`[Lifter] Truncated bytecode after Wide prefix at offset 0x${startOffset.toString(16)}`);
        }
        byte = bytecodeBuf[pc++];
      } else if (byte === 0x01) {
        scale = 4; // ExtraWide
        if (pc >= len) {
          throw new Error(`[Lifter] Truncated bytecode after ExtraWide prefix at offset 0x${startOffset.toString(16)}`);
        }
        byte = bytecodeBuf[pc++];
      }

      const op = this.profile.getOpcode(byte);
      if (!op || op.name === 'Illegal') {
        throw new Error(`[Lifter] Illegal or unknown opcode 0x${byte.toString(16)} at offset 0x${startOffset.toString(16)}`);
      }

      const operandsRaw = [];
      const operandsDecoded = [];
      let jumpTarget = null;

      // Handle Short Star instructions (Star0 .. Star15)
      // kStar0 = 210 (0xd2), kStar1 = 209 (0xd1), ..., kStar15 = 195 (0xc3)
      if (op.implicit === 'kReadAccumulatorWriteShortStar') {
        const starIdx = 210 - op.value;
        operandsDecoded.push(`r${starIdx}`);
      }

      const opcodeOffset = pc - 1;

      for (const opType of (op.operands || [])) {
        const prop = this.profile.operandProperties[opType];
        if (!prop) {
          throw new Error(`[Lifter] UnknownOperandTypeError: Operand type '${opType}' for opcode '${op.name}' at 0x${startOffset.toString(16)} is not defined in profile`);
        }
        const sz = prop.base_size * (prop.scalable ? scale : 1);
        if (pc + sz > len) {
          throw new Error(`[Lifter] Operand ${opType} (size ${sz}) overruns bytecode length ${len} at offset 0x${startOffset.toString(16)}`);
        }

        let rawVal = 0;
        let signedVal = 0;

        if (sz === 1) {
          rawVal = bytecodeBuf[pc];
          signedVal = bytecodeBuf.readInt8(pc);
        } else if (sz === 2) {
          rawVal = bytecodeBuf.readUInt16LE(pc);
          signedVal = bytecodeBuf.readInt16LE(pc);
        } else if (sz === 4) {
          rawVal = bytecodeBuf.readUInt32LE(pc);
          signedVal = bytecodeBuf.readInt32LE(pc);
        } else {
          rawVal = bytecodeBuf.readUIntLE(pc, sz);
          signedVal = rawVal;
        }

        pc += sz;
        operandsRaw.push(rawVal);

        const isReg = opType === 'kReg' || opType === 'kRegOut' || opType === 'kRegInOut' ||
                      opType === 'kRegList' || opType === 'kRegOutList' ||
                      opType === 'kRegPair' || opType === 'kRegOutPair' || opType === 'kRegOutTriple';
        if (isReg) {
          operandsDecoded.push(this.profile.decodeRegister(rawVal, sz));
        } else if (opType === 'kConstantPoolIndex') {
          if (constants && rawVal < constants.length) {
            const cVal = constants[rawVal];
            operandsDecoded.push(`[${rawVal}: ${typeof cVal === 'string' ? JSON.stringify(cVal) : String(cVal)}]`);
          } else {
            operandsDecoded.push(`[${rawVal}]`);
          }
        } else if (opType === 'kImm' || opType === 'kUImm') {
          operandsDecoded.push(`${rawVal}`);
        } else if (opType === 'kFlag8') {
          operandsDecoded.push(`0x${rawVal.toString(16)}`);
        } else {
          operandsDecoded.push(`${rawVal}`);
        }

        // Branch delta: relative to opcodeOffset
        if (op.name.startsWith('Jump') && jumpTarget === null) {
          if (op.name === 'JumpLoop') {
            jumpTarget = opcodeOffset - rawVal;
          } else if (op.name.endsWith('Constant')) {
            const cVal = constants ? constants[rawVal] : null;
            if (typeof cVal === 'number') {
              jumpTarget = opcodeOffset + cVal;
            } else {
              jumpTarget = opcodeOffset + rawVal;
            }
          } else {
            jumpTarget = opcodeOffset + rawVal;
          }
        }
      }

      const inst = new Instruction(
        startOffset,
        op,
        operandsRaw,
        operandsDecoded,
        scale,
        pc - startOffset,
        jumpTarget
      );
      instructions.push(inst);
    }

    return instructions;
  }

  buildCFG(instructions, handlers = []) {
    if (instructions.length === 0) return [];

    const instByOffset = new Map();
    for (const inst of instructions) {
      instByOffset.set(inst.offset, inst);
    }

    // 1. Identify leaders
    const leaders = new Set([instructions[0].offset]);
    for (const h of handlers) {
      if (instByOffset.has(h.handlerOffset)) leaders.add(h.handlerOffset);
      if (instByOffset.has(h.start)) leaders.add(h.start);
      if (instByOffset.has(h.end)) leaders.add(h.end);
    }
    for (let i = 0; i < instructions.length; i++) {
      const inst = instructions[i];
      if (inst.jumpTarget !== null) {
        if (!instByOffset.has(inst.jumpTarget)) {
          throw new Error(`[Lifter] Jump target 0x${inst.jumpTarget.toString(16)} does not point to an instruction offset`);
        }
        leaders.add(inst.jumpTarget);
        if (i + 1 < instructions.length) {
          leaders.add(instructions[i + 1].offset);
        }
      } else if (inst.name === 'Return' || inst.name === 'Throw' || inst.name === 'ReThrow' || inst.name === 'Abort') {
        if (i + 1 < instructions.length) {
          leaders.add(instructions[i + 1].offset);
        }
      }
    }

    // 2. Slice into basic blocks
    const blocks = [];
    let currentBlock = null;
    let blockId = 0;

    for (const inst of instructions) {
      if (leaders.has(inst.offset)) {
        if (currentBlock) {
          currentBlock.endOffset = inst.offset;
          blocks.push(currentBlock);
        }
        currentBlock = new BasicBlock(blockId++, inst.offset);
      }
      currentBlock.instructions.push(inst);
    }
    if (currentBlock) {
      const lastInst = currentBlock.instructions[currentBlock.instructions.length - 1];
      currentBlock.endOffset = lastInst.offset + lastInst.size;
      blocks.push(currentBlock);
    }

    // 3. Connect CFG edges
    const blockByOffset = new Map();
    for (const b of blocks) {
      blockByOffset.set(b.startOffset, b);
    }

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const lastInst = b.instructions[b.instructions.length - 1];

      if (lastInst.jumpTarget !== null) {
        const targetBlock = blockByOffset.get(lastInst.jumpTarget);
        if (!targetBlock) {
          throw new Error(`[Lifter] CFG construction failed: target block at 0x${lastInst.jumpTarget.toString(16)} not found`);
        }

        if (lastInst.name === 'Jump' || lastInst.name === 'JumpConstant' || lastInst.name === 'JumpLoop') {
          // Unconditional jump
          b.successors.push(targetBlock);
          targetBlock.predecessors.push(b);
        } else {
          // Conditional branch
          b.branchTarget = targetBlock;
          b.successors.push(targetBlock);
          targetBlock.predecessors.push(b);

          if (i + 1 < blocks.length) {
            const nextBlock = blocks[i + 1];
            b.fallthroughTarget = nextBlock;
            b.successors.push(nextBlock);
            nextBlock.predecessors.push(b);
          }
        }
      } else if (lastInst.name !== 'Return' && lastInst.name !== 'Throw' && lastInst.name !== 'ReThrow' && lastInst.name !== 'Abort') {
        // Fallthrough
        if (i + 1 < blocks.length) {
          const nextBlock = blocks[i + 1];
          b.fallthroughTarget = nextBlock;
          b.successors.push(nextBlock);
          nextBlock.predecessors.push(b);
        }
      }
    }

    return blocks;
  }
}
