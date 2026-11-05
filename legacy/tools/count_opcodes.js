import fs from 'fs';
import path from 'path';
import { JSCDeserializer } from '../src/deserializer.js';
import { V8Profile } from '../src/profile.js';
import { Lifter } from '../src/lifter.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const lifter = new Lifter(profile);

const opCounts = new Map();
const files = fs.readdirSync('extracted_jsc').filter(f => f.endsWith('.jsc')).slice(0, 30);

for (const file of files) {
  try {
    const res = deserializer.deserializeFile(path.join('extracted_jsc', file));
    for (const fn of res.functions) {
      if (fn.bytecode.length > 4) {
        const insts = lifter.disassemble(fn.bytecode.subarray(4), res.strings);
        for (const ins of insts) {
          opCounts.set(ins.name, (opCounts.get(ins.name) || 0) + 1);
        }
      }
    }
  } catch(e) {}
}

const sorted = Array.from(opCounts.entries()).sort((a,b) => b[1] - a[1]);
console.log('Top 45 opcodes across 30 JSC files:');
sorted.slice(0, 45).forEach(([name, count]) => {
  console.log('  ' + name.padEnd(32) + ' : ' + count);
});
