import fs from 'fs';
import path from 'path';
import { V8Decompiler } from '../src/decompiler.js';

const inputPath = 'extracted_jsc/r_8878.jsc';
const outputPath = 'decompiled_js/r_8878.js';

console.log(`Starting isolated decompilation of ${inputPath}...`);
const t0 = Date.now();
const decompiler = new V8Decompiler();

try {
  const res = decompiler.decompileFile(inputPath);
  fs.writeFileSync(outputPath, res.code, 'utf8');
  console.log(`Successfully decompiled ${inputPath} in ${Date.now() - t0}ms!`);
  console.log(`Total functions: ${res.totalFunctions}`);
  console.log(`Output size: ${(res.code.length / 1024 / 1024).toFixed(2)} MB`);
} catch (err) {
  console.error(`Failed to decompile ${inputPath}:`, err);
  process.exit(1);
}
