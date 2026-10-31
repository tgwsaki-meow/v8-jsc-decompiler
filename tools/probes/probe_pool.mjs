// Why does O1 call `f([1,2,3])` and `f([2,2,3])` identical on a release d8?
// Hypothesis: the literal lives in an ArrayBoilerplateDescription in the
// constant pool, d8 does not print pool contents, and the inline annotation
// carries only the index -- so the normalised stream has nothing to compare.
import fs from 'node:fs';
import { dumpBytecode, normalizeFunction } from '../../src/verify/oracle.mjs';
import { findD8 } from '../../src/verify/mint.mjs';

const WORK = 'scratch/t3/work/probe';
fs.mkdirSync(WORK, { recursive: true });
const d8 = findD8();
const A = 'function f(a){var [x,y,z]=a; return [x,y,z];} f([1,2,3]);\n';
const B = 'function f(a){var [x,y,z]=a; return [x,y,z];} f([2,2,3]);\n';

for (const [label, src, engine] of [['d8 A', A, d8], ['d8 B', B, d8], ['node A', A, 'node'], ['node B', B, 'node']]) {
  const d = dumpBytecode({ engine, source: src, workDir: WORK, name: `pool_${label.replace(/\W/g, '')}`, filter: engine === 'node' ? '*' : undefined });
  const top = d.parsed.functions.find((f) => f.name === '') ?? d.parsed.functions[0];
  console.log(`--- ${label}: poolSize=${top.constantPoolSize} resolution=${top.constantPoolResolution}`);
  for (const i of top.instructions) {
    if (/Literal|Constant/.test(i.opcode)) console.log(`    raw: ${i.raw.trim()}`);
  }
  const n = normalizeFunction(top);
  console.log(`    normalised: ${n.perInstruction.filter((s) => /Literal|K\(/.test(s)).join(' ;; ')}`);
}
