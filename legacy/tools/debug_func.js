import { V8Profile } from '../src/profile.js';
import { JSCDeserializer } from '../src/deserializer.js';
import { Lifter } from '../src/lifter.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const lifter = new Lifter(profile);

const res = deserializer.deserializeFile('./extracted_jsc/p_preload_chatwin.jsc');
console.log('Total functions in p_preload_chatwin:', res.functions.length);
console.log('Total strings:', res.strings.length);

for (let i = 2; i <= 6; i++) {
  console.log(`\n=== Function ${i} (paramSize=${res.functions[i].paramSize}, frameSize=${res.functions[i].frameSize}, len=${res.functions[i].length}) ===`);
  const insts = lifter.disassemble(res.functions[i].bytecode, res.strings);
  insts.forEach(ins => {
    console.log(`  [+${ins.offset}] ${ins.name} ${ins.operandsDecoded.join(', ')}`);
  });
}
