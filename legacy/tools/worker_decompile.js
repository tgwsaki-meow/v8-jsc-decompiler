import fs from 'fs';
import path from 'path';
import { V8Decompiler } from '../src/decompiler.js';

const decompiler = new V8Decompiler();

process.on('message', async (msg) => {
  if (msg.type === 'DECOMPILE') {
    const { inputPath, outputPath, filename } = msg;
    const t0 = Date.now();
    try {
      const res = decompiler.decompileFile(inputPath);
      fs.writeFileSync(outputPath, res.code, 'utf8');
      
      // Cleanup to free heap memory
      decompiler.fnCache.clear();
      decompiler.functionsById.clear();
      if (global.gc) {
        global.gc();
      }

      process.send({
        type: 'SUCCESS',
        filename,
        functions: res.totalFunctions,
        bytes: res.code.length,
        duration: Date.now() - t0
      });
    } catch (err) {
      process.send({
        type: 'ERROR',
        filename,
        error: err.message,
        duration: Date.now() - t0
      });
    }
  }
});
