import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';

const INPUT_DIR = path.resolve('extracted_jsc');
const OUTPUT_DIR = path.resolve('decompiled_js');
const WORKER_SCRIPT = path.resolve('tools/worker_decompile.js');

const CANONICAL_EPOCH = new Date('2026-10-03T19:30:00+08:00').getTime();

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allJsc = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.jsc'));
  const force = process.argv.includes('--force');

  const queue = [];
  let skippedCount = 0;

  for (const filename of allJsc) {
    const inputPath = path.join(INPUT_DIR, filename);
    const outputPath = path.join(OUTPUT_DIR, filename.replace(/\.jsc$/, '.js'));

    if (!force && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.mtimeMs >= CANONICAL_EPOCH) {
        skippedCount++;
        continue;
      }
    }

    const size = fs.statSync(inputPath).size;
    queue.push({ filename, inputPath, outputPath, size });
  }

  // Sort queue by size ASCENDING so 99% of files finish immediately
  queue.sort((a, b) => a.size - b.size);

  const numWorkers = Math.max(1, Math.min(os.cpus().length, 2));
  console.log(`=== Parallel V8 Bytecode Decompiler ===`);
  console.log(`Total files:         ${allJsc.length}`);
  console.log(`Already canonical:   ${skippedCount}`);
  console.log(`Files to decompile:  ${queue.length}`);
  console.log(`Worker processes:    ${numWorkers}`);
  console.log(`=========================================\n`);

  if (queue.length === 0) {
    console.log('All files are up to date with canonical pipeline!');
    return;
  }

  let completedCount = 0;
  let failedCount = 0;
  let nextQueueIdx = 0;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let activeWorkers = numWorkers;

    function spawnWorker(workerId) {
      const worker = fork(WORKER_SCRIPT, [], {
        execArgv: ['--max-old-space-size=8192', '--expose-gc']
      });

      let currentTask = null;

      const assignNext = () => {
        if (nextQueueIdx >= queue.length) {
          worker.kill();
          return;
        }

        currentTask = queue[nextQueueIdx++];
        worker.send({
          type: 'DECOMPILE',
          inputPath: currentTask.inputPath,
          outputPath: currentTask.outputPath,
          filename: currentTask.filename
        });
      };

      worker.on('message', (msg) => {
        if (msg.type === 'SUCCESS') {
          completedCount++;
          const totalDone = skippedCount + completedCount;
          const pct = ((totalDone / allJsc.length) * 100).toFixed(1);
          if (msg.duration > 1500 || totalDone % 25 === 0 || nextQueueIdx >= queue.length) {
            console.log(`[${totalDone}/${allJsc.length}] (${pct}%) [W${workerId}] Decompiled ${msg.filename} (${msg.functions} fns, ${(msg.bytes/1024).toFixed(1)} KB) in ${msg.duration}ms`);
          }
        } else if (msg.type === 'ERROR') {
          failedCount++;
          console.error(`[Error] [W${workerId}] Failed to decompile ${msg.filename}: ${msg.error}`);
        }
        currentTask = null;
        assignNext();
      });

      worker.on('exit', (code) => {
        if (nextQueueIdx < queue.length) {
          if (code !== 0) {
            console.warn(`[W${workerId}] Worker exited with code ${code}. Respawning worker...`);
            if (currentTask) {
              failedCount++;
              console.error(`[W${workerId}] Failed task on crash: ${currentTask.filename}`);
              currentTask = null;
            }
            spawnWorker(workerId);
          }
        } else {
          activeWorkers--;
          if (activeWorkers === 0) {
            resolve();
          }
        }
      });

      assignNext();
    }

    for (let w = 0; w < numWorkers; w++) {
      spawnWorker(w + 1);
    }
  }).then(() => {
    const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n================ PARALLEL BATCH SUMMARY ================');
    console.log(`Total files scanned:      ${allJsc.length}`);
    console.log(`Newly decompiled:         ${completedCount}`);
    console.log(`Previously validated:     ${skippedCount}`);
    console.log(`Failed:                   ${failedCount}`);
    console.log(`Total available:          ${completedCount + skippedCount}/${allJsc.length}`);
    console.log(`Elapsed time:             ${totalTimeSec}s`);
    console.log('========================================================\n');
  });
}

main().catch(err => {
  console.error('Fatal error in parallel batch:', err);
  process.exit(1);
});
