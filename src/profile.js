import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class V8Profile {
  constructor(profilePath) {
    if (!profilePath) {
      profilePath = path.resolve(__dirname, '../rules/v8-14.4.258.16.json');
    }
    const data = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    this.version = data.v8_version;
    this.headerOffsets = data.header_offsets;
    this.operandProperties = data.operand_properties || {};
    
    // Map numerical opcode to instruction definition
    this.opcodes = new Map();
    for (const [k, v] of Object.entries(data.opcodes_by_val)) {
      this.opcodes.set(parseInt(k, 10), v);
    }

    // Map name to definition
    this.opcodesByName = new Map();
    for (const [name, v] of Object.entries(data.opcodes_by_name)) {
      this.opcodesByName.set(name, v);
    }

    // Load official V8 roots
    this.roots = new Map();
    const rootsPath = path.resolve(__dirname, '../rules/v8-roots-14.4.258.16.json');
    if (fs.existsSync(rootsPath)) {
      const rootsData = JSON.parse(fs.readFileSync(rootsPath, 'utf8'));
      const entries = rootsData.roots || rootsData.roots_by_index || {};
      for (const [k, v] of Object.entries(entries)) {
        this.roots.set(parseInt(k, 10), v);
      }
    }

    // Load official V8 ReadOnlyHeap strings table
    this.roHeap = new Map();
    const roHeapPath = path.resolve(__dirname, '../rules/v8-ro-heap.json');
    if (fs.existsSync(roHeapPath)) {
      const roHeapData = JSON.parse(fs.readFileSync(roHeapPath, 'utf8'));
      for (const [k, v] of Object.entries(roHeapData)) {
        this.roHeap.set(k, v);
      }
    }
  }

  getRoot(index) {
    return this.roots.get(index) || null;
  }


  getReadOnlyRef(chunkIndex, chunkOffset) {
    const key = `${chunkIndex}:${chunkOffset}`;
    return this.roHeap.get(key) || null;
  }

  getOpcode(val) {
    return this.opcodes.get(val);
  }

  getOpcodeByName(name) {
    return this.opcodesByName.get(name);
  }

  decodeRegister(operand, size = 1) {
    // Exact V8 Ignition register encoding (frame-constants.h & bytecode-register.h):
    // kRegisterFileStartOffset = -7
    // Local registers: operand = -7 - index  => index = -7 - operand
    // Parameters:
    //   operand = 2: <this> (parameter index 0)
    //   operand = 3: a0 (parameter index 1)
    //   operand = 4: a1 (parameter index 2)
    //   operand = 2 + k: ak-1
    let signedVal = operand;
    if (size === 1) {
      if (signedVal >= 128) signedVal -= 256;
    } else if (size === 2) {
      if (signedVal >= 32768) signedVal -= 65536;
    } else if (size === 4) {
      signedVal = signedVal | 0;
    }

    // Parameters
    if (signedVal >= 2) {
      const paramIdx = signedVal - 2;
      if (paramIdx === 0) return 'this';
      return `a${paramIdx - 1}`;
    }

    // Local registers
    if (signedVal <= -7) {
      const localIdx = -7 - signedVal;
      return `r${localIdx}`;
    }

    // Special frame registers (bytecode-register.h)
    if (signedVal === -1) return 'acc';
    if (signedVal === -2) return 'feedback_vector';
    if (signedVal === -3) return 'bytecode_offset';
    if (signedVal === -4) return 'bytecode_array';
    if (signedVal === -5) return 'context';
    if (signedVal === -6) return 'closure';
    if (signedVal === 0) return 'arg_count';
    if (signedVal === 1) return 'caller_pc';

    throw new Error(`[V8Profile] Invalid register operand ${signedVal} (raw ${operand})`);
  }
}
