// tools/verify/o1_corpus_worker.mjs
//
// One child process, one corpus `.jsc`: the whole O1 (+ O2) measurement for
// that file, written as one JSON result and nothing else. Never writes to
// stdout; the runner reads the file.
//
//   node --max-old-space-size=N tools/verify/o1_corpus_worker.mjs \
//        <file.jsc> <profileDir> <out.json> <workDir> <minterExe> \
//        <decompileTimeoutSec> <decompileHeapMB>
//
// This process does the decoding, normalising, pairing, comparing and
// classifying itself, and spawns three helpers:
//
//   1. the decompiler, in its own process, so a hang or an OOM on one file
//      costs that file's row and not the run, and so its peak heap is not
//      still resident while two normalised streams are held side by side;
//   2. Electron's node, compile-only, to mint stream B's `.jsc`;
//   3. the decompiler again, on that minted `.jsc`, which is O2's second
//      round and costs one decompile on top of O1.
//
// Nothing from the corpus or derived from it is ever executed:
// `src/verify/o1_corpus.mjs` asserts that on the argv of (2) and refuses to
// write into the tree `corpus.mjs` declares executable for O3.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { o1CorpusOne } from '../../src/verify/o1_corpus.mjs';

const [file, profileDir, outPath, workDir, minter, timeoutSec, heapMB] = process.argv.slice(2);
const DECOMPILE_TIMEOUT_MS = (Number(timeoutSec) || 1800) * 1000;
const DECOMPILE_HEAP = Number(heapMB) || 1400;
const CHILD = path.resolve('tools/verify/o1_corpus_decompile_child.mjs');

const id = path.basename(file).replace(/\.jsc$/, '');
fs.mkdirSync(workDir, { recursive: true });

/** Run the decompiler in its own process. Never throws. */
function decompileOne(jscPath, tag) {
  const codePath = path.join(workDir, `${id}.${tag}.js`);
  const metaPath = path.join(workDir, `${id}.${tag}.meta.json`);
  const logPath = path.join(workDir, `${id}.${tag}.log.txt`);
  fs.rmSync(metaPath, { force: true });
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(process.execPath, [
      `--max-old-space-size=${DECOMPILE_HEAP}`, CHILD,
      path.resolve(jscPath), codePath, metaPath, profileDir,
    ], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: DECOMPILE_TIMEOUT_MS });
  } finally { fs.closeSync(fd); }
  const wall = Date.now() - t0;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.codePath = fs.existsSync(codePath) ? codePath : null;
    meta.childWallMs = wall;
    if (meta.ok && !meta.codePath) { meta.ok = false; meta.stage = 'no-code'; meta.error = 'child reported ok but wrote no code file'; }
    fs.rmSync(logPath, { force: true });
    fs.rmSync(metaPath, { force: true });
    return meta;
  }
  const log = fs.readFileSync(logPath, 'utf8').trim();
  const killed = Boolean(r.signal) || wall >= DECOMPILE_TIMEOUT_MS - 50;
  fs.rmSync(logPath, { force: true });
  return {
    ok: false, stage: killed ? 'timeout' : 'crash', ms: wall, childWallMs: wall,
    error: killed ? `killed after ${DECOMPILE_TIMEOUT_MS} ms` : `child exited ${r.status}: ${log.slice(-300)}`,
    codePath: null,
  };
}

const t0 = Date.now();
let row;
try {
  row = o1CorpusOne(file, { profile: profileDir, workDir, minter, decompileOne });
} catch (e) {
  row = {
    file: path.basename(file), id, status: 'worker-threw',
    error: `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e)}`.slice(0, 500),
    at: String(e?.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? null,
  };
}
row.wallMs = Date.now() - t0;
const cpu = process.cpuUsage();
row.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
row.rssPeakMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(row));
