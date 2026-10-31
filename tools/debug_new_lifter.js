import { JSCDeserializer } from '../src/deserializer.js';
import { V8Profile } from '../src/profile.js';
import { Lifter } from '../src/lifter.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const lifter = new Lifter(profile);

// Custom register decoder
lifter.decodeRegister = function(operand) {
  let signedVal = operand;
  if (signedVal >= 128) signedVal -= 256;

  // Local registers: r0 (-7), r1 (-8), r2 (-9)...
  if (signedVal <= -7) {
    const regIdx = -7 - signedVal;
    return `r${regIdx}`;
  }
  // Parameters: 2 (<this>), 3 (arg0), 4 (arg1), 5 (arg2)...
  if (signedVal === 2) {
    return '<this>';
  }
  if (signedVal >= 3) {
    return `arg${signedVal - 3}`;
  }
  // Special stack frame registers (-6 to 1)
  if (signedVal === -1) return '<context>';
  if (signedVal === -2) return '<closure>';
  return `reg_${signedVal}`;
};

const res = deserializer.deserializeFile('./extracted_jsc/p_preload_chatwin.jsc');

for (let i = 2; i <= 6; i++) {
  const fn = res.functions[i];
  console.log(`\n================ FUNCTION ${i} (paramSize=${fn.paramSize}, frameSize=${fn.frameSize}) ================`);
  // +4 offset because +12 from header
  const insts = lifter.disassemble(fn.bytecode.subarray(4), res.strings);
  insts.forEach(ins => {
    console.log(`  [+${ins.offset.toString(16).padStart(4, '0')}] ${ins.name.padEnd(28)} ${ins.operandsDecoded.join(', ')}`);
  });
}
