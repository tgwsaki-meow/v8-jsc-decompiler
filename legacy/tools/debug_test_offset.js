import { JSCDeserializer } from '../src/deserializer.js';
import { V8Profile } from '../src/profile.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const res = deserializer.deserializeFile('./extracted_jsc/p_preload_chatwin.jsc');

console.log('Testing functions with pc + 12 (bytecode.subarray(4)):');
let validFirstOp = 0;
for (let i = 0; i < res.functions.length; i++) {
  const fn = res.functions[i];
  const firstByte = fn.bytecode[4];
  const op = profile.getOpcode(firstByte);
  if (op && op.name !== 'Illegal') {
    validFirstOp++;
  }
}
console.log('Valid first opcodes at +4:', validFirstOp, '/', res.functions.length);
