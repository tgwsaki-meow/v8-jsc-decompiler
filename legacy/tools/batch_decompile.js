import fs from 'fs';
import path from 'path';
import { V8Decompiler } from '../src/decompiler.js';

const INPUT_DIR = path.resolve('extracted_jsc');
const OUTPUT_DIR = path.resolve('decompiled_js');

async function runBatch() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allFiles = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.jsc'));
  console.log(`=== Found ${allFiles.length} V8 Bytecode (.jsc) Modules in ${INPUT_DIR} ===`);
  console.log(`Target output directory: ${OUTPUT_DIR}\n`);

  const decompiler = new V8Decompiler();
  let successCount = 0;
  let skippedCount = 0;
  let failCount = 0;
  let totalFunctionsDecompiled = 0;
  const startTime = Date.now();

  console.log(`Resuming batch decompilation for remaining files...`);

  const force = process.argv.includes('--force');

  for (let i = 0; i < allFiles.length; i++) {
    const filename = allFiles[i];
    const inputPath = path.join(INPUT_DIR, filename);
    const outputPath = path.join(OUTPUT_DIR, filename.replace(/\.jsc$/, '.js'));

    const CANONICAL_EPOCH = new Date('2026-10-03T19:30:00+08:00').getTime();

    // Files processed after canonical roots deployment (19:30) are already pure
    if (!force && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.mtimeMs >= CANONICAL_EPOCH) {
        skippedCount++;
        if (skippedCount % 50 === 0) {
          const totalDone = successCount + skippedCount;
          const pct = ((totalDone / allFiles.length) * 100).toFixed(1);
          console.log(`[${totalDone}/${allFiles.length}] (${pct}%) Newly Decompiled: ${successCount} | Previously Validated: ${skippedCount}`);
        }
        continue;
      }
    }

    const fileStart = Date.now();
    try {
      const result = decompiler.decompileFile(inputPath);
      fs.writeFileSync(outputPath, result.code, 'utf8');
      successCount++;
      totalFunctionsDecompiled += result.totalFunctions;
      const fileDuration = Date.now() - fileStart;

      const totalDone = successCount + skippedCount;
      const pct = ((totalDone / allFiles.length) * 100).toFixed(1);
      if (totalDone % 10 === 0 || fileDuration > 2000 || i + 1 === allFiles.length) {
        console.log(`[${totalDone}/${allFiles.length}] (${pct}%) Decompiled ${filename} (${result.totalFunctions} fns, ${fileDuration}ms) | Total New: ${successCount} | Cached: ${skippedCount} | Failed: ${failCount}`);
      }
    } catch (err) {
      failCount++;
      console.error(`[Error] Failed to decompile ${filename}: ${err.message}`);
    }
  }

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n================ BATCH DECOMPILATION SUMMARY ================');
  console.log(`Total files scanned:      ${allFiles.length}`);
  console.log(`Newly decompiled:         ${successCount}`);
  console.log(`Previously completed:     ${skippedCount}`);
  console.log(`Total available:          ${successCount + skippedCount}/${allFiles.length} (${(((successCount + skippedCount) / allFiles.length) * 100).toFixed(1)}%)`);
  console.log(`Failed / Skipped:         ${failCount}`);
  console.log(`Elapsed time:             ${totalTimeSec}s`);
  console.log(`Output directory:         ${OUTPUT_DIR}`);
  console.log('=============================================================\n');
}

runBatch();
