import fs from 'fs';
import path from 'path';

const bytecodesH = fs.readFileSync('rules/raw/bytecodes.h', 'utf8');

function extractMacroBlock(source, macroName) {
  const lines = source.split(/\r?\n/);
  const result = [];
  let recording = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#define ' + macroName)) {
      recording = true;
      result.push(line);
      continue;
    }
    if (recording) {
      result.push(line);
      // Check if continuation ends
      if (!line.trimEnd().endsWith('\\')) {
        break;
      }
    }
  }
  return result.join('\n');
}

// 1. Get raw blocks
const callPropsRaw = extractMacroBlock(bytecodesH, 'CALL_PROPERTY_BYTECODES');
let uniqueHandlersRaw = extractMacroBlock(bytecodesH, 'BYTECODE_LIST_WITH_UNIQUE_HANDLERS_IMPL');
const shortStarsRaw = extractMacroBlock(bytecodesH, 'SHORT_STAR_BYTECODE_LIST');

// 2. Expand CALL_PROPERTY_BYTECODES(V) right where it appears in uniqueHandlersRaw!
uniqueHandlersRaw = uniqueHandlersRaw.replace('CALL_PROPERTY_BYTECODES(V)', callPropsRaw);

// 3. Combine in exact order of BYTECODE_LIST:
// BYTECODE_LIST_WITH_UNIQUE_HANDLERS (which contains UNIQUE_HANDLERS_IMPL)
// SHORT_STAR_BYTECODE_LIST
// V(Illegal, ImplicitRegisterUse::kNone)
const fullCombined = (uniqueHandlersRaw + '\n' + shortStarsRaw + '\n V(Illegal, ImplicitRegisterUse::kNone)')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/\\\r?\n/g, ' ');

const opcodes = [];
const opcodeRegex = /(?:V|V_TSA)\s*\(\s*(\w+)\s*,\s*([^,\)]+)(?:,([^\)]+))?\)/g;
let match;
while ((match = opcodeRegex.exec(fullCombined)) !== null) {
  const name = match[1];
  const implicit = match[2].trim().replace('ImplicitRegisterUse::', '');
  const operandsRaw = match[3];
  const operands = [];
  if (operandsRaw) {
    for (let op of operandsRaw.split(',')) {
      op = op.trim().replace('OperandType::', '');
      if (op) operands.push(op);
    }
  }
  opcodes.push({
    name,
    implicit_register_use: implicit,
    operands
  });
}

console.log('Total opcodes extracted:', opcodes.length);
const opcodesByVal = {};
const opcodesByName = {};

opcodes.forEach((op, idx) => {
  op.value = idx;
  op.hex = '0x' + idx.toString(16).padStart(2, '0');
  opcodesByVal[idx] = op;
  opcodesByName[op.name] = op;
});

console.log('CallProperty:', opcodesByName['CallProperty']);
console.log('CallUndefinedReceiver:', opcodesByName['CallUndefinedReceiver']);
console.log('Return:', opcodesByName['Return']);
console.log('Star0:', opcodesByName['Star0']);

const profile = {
  v8_version: '14.4.258.16',
  total_opcodes: opcodes.length,
  header_offsets: {
    kMagicNumberOffset: 0,
    kVersionHashOffset: 4,
    kSourceHashOffset: 8,
    kFlagHashOffset: 12,
    kReadOnlySnapshotChecksumOffset: 16,
    kPayloadLengthOffset: 20,
    kChecksumOffset: 24,
    kHeaderSize: 32
  },
  operand_properties: {
    kReg: { scalable: true, signed: true, base_size: 1 },
    kRegList: { scalable: true, signed: true, base_size: 1 },
    kRegPair: { scalable: true, signed: true, base_size: 1 },
    kRegOut: { scalable: true, signed: true, base_size: 1 },
    kRegOutList: { scalable: true, signed: true, base_size: 1 },
    kRegOutPair: { scalable: true, signed: true, base_size: 1 },
    kRegOutTriple: { scalable: true, signed: true, base_size: 1 },
    kRegInOut: { scalable: true, signed: true, base_size: 1 },
    kImm: { scalable: true, signed: true, base_size: 1 },
    kConstantPoolIndex: { scalable: true, signed: false, base_size: 1 },
    kFeedbackSlot: { scalable: true, signed: false, base_size: 1 },
    kContextSlot: { scalable: true, signed: false, base_size: 1 },
    kCoverageSlot: { scalable: true, signed: false, base_size: 1 },
    kUImm: { scalable: true, signed: false, base_size: 1 },
    kRegCount: { scalable: true, signed: false, base_size: 1 },
    kFlag8: { scalable: false, signed: false, base_size: 1 },
    kIntrinsicId: { scalable: false, signed: false, base_size: 1 },
    kNativeContextIndex: { scalable: false, signed: false, base_size: 1 },
    kAbortReason: { scalable: false, signed: false, base_size: 1 },
    kFlag16: { scalable: false, signed: false, base_size: 2 },
    kRuntimeId: { scalable: false, signed: false, base_size: 2 }
  },
  opcodes_by_val: opcodesByVal,
  opcodes_by_name: opcodesByName
};

fs.writeFileSync('rules/v8-14.4.258.16.json', JSON.stringify(profile, null, 2), 'utf8');
console.log('Updated rules/v8-14.4.258.16.json successfully!');
