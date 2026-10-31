// Split the corpus into N shards for a parallel CI scan.
//
//   node tools/ci/shard_corpus.mjs --corpus extracted_jsc --shards 12 --index 0 \
//        --out /tmp/shard
//
// Writes symlinks (or copies, on a filesystem that will not link) for this
// shard's files into --out, so the existing scanners need no new flag: they
// already take `--corpus <dir>`.
//
// **Balanced by bytes, not by file count.** The corpus is 104 MiB over 1039
// files and the largest five are 27.4% of it (`r_8878.jsc` alone is 10.2 MiB),
// so an even split by count gives one shard several times the work of another
// and the whole matrix waits on it. Longest-processing-time-first: sort
// descending by size, then repeatedly give the next file to whichever shard has
// the least assigned so far. That is Graham's LPT rule, which is within 4/3 of
// optimal for this scheduling problem and costs one sort.
//
// `--plan` prints the whole assignment without writing anything, which is how
// the balance is checked before burning CI minutes.

import fs from 'node:fs';
import path from 'node:path';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(`--${n}`);

const CORPUS = argOf('corpus', 'extracted_jsc');
const SHARDS = Number(argOf('shards', '1'));
const INDEX = Number(argOf('index', '0'));
const OUT = argOf('out', '/tmp/shard');
const EXT = argOf('ext', '.jsc');

if (!Number.isInteger(SHARDS) || SHARDS < 1) throw new Error(`--shards must be >= 1, got ${SHARDS}`);
if (!Number.isInteger(INDEX) || INDEX < 0 || INDEX >= SHARDS) {
  throw new Error(`--index must be in [0,${SHARDS}), got ${INDEX}`);
}
if (!fs.existsSync(CORPUS)) throw new Error(`corpus directory ${CORPUS} does not exist`);

const files = fs.readdirSync(CORPUS)
  .filter((f) => f.endsWith(EXT))
  .map((f) => ({ name: f, size: fs.statSync(path.join(CORPUS, f)).size }))
  .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

if (!files.length) throw new Error(`no ${EXT} files in ${CORPUS}`);

// LPT: biggest first, each to the currently-lightest shard. Deterministic, so
// every job in the matrix computes the same assignment from the same input and
// no coordination is needed.
const bins = Array.from({ length: SHARDS }, (_, i) => ({ i, bytes: 0, files: [] }));
for (const f of files) {
  let best = bins[0];
  for (const b of bins) if (b.bytes < best.bytes || (b.bytes === best.bytes && b.i < best.i)) best = b;
  best.bytes += f.size;
  best.files.push(f);
}

const MiB = (n) => (n / 1048576).toFixed(1);

if (flag('plan')) {
  const total = files.reduce((a, f) => a + f.size, 0);
  const max = Math.max(...bins.map((b) => b.bytes));
  const min = Math.min(...bins.map((b) => b.bytes));
  console.log(`${files.length} files, ${MiB(total)} MiB, ${SHARDS} shards`);
  console.log(`balance: largest shard ${MiB(max)} MiB, smallest ${MiB(min)} MiB, spread ${(100 * (max - min) / (total / SHARDS)).toFixed(1)}% of the mean`);
  console.log(`a perfectly even split would be ${MiB(total / SHARDS)} MiB per shard`);
  console.log();
  for (const b of bins) {
    console.log(`shard ${String(b.i).padStart(2)}  ${String(b.files.length).padStart(4)} files  ${MiB(b.bytes).padStart(6)} MiB   biggest: ${b.files[0]?.name ?? '-'}`);
  }
  process.exit(0);
}

const mine = bins[INDEX];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let linked = 0, copied = 0;
for (const f of mine.files) {
  const src = path.resolve(CORPUS, f.name);
  const dst = path.join(OUT, f.name);
  try { fs.symlinkSync(src, dst); linked++; }
  catch { fs.copyFileSync(src, dst); copied++; }
}

// Also carry the manifest across when there is one: it names the V8 version the
// corpus was produced by, and a scanner that reports it is easier to trust.
for (const extra of ['manifest.json']) {
  const src = path.join(CORPUS, extra);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, extra));
}

console.log(`shard ${INDEX}/${SHARDS}: ${mine.files.length} files, ${MiB(mine.bytes)} MiB -> ${OUT} (${linked} linked, ${copied} copied)`);
