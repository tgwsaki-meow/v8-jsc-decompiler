// How far along are the two corpus scans, and how long is left?
//
// Extrapolating on file COUNT is wrong: the corpus is 104 MiB over 1039 files
// and the largest few are a big share of the total work, so a scan that has
// done the small ones looks much further along than it is. Cost tracks input
// bytes, so this measures bytes/second over the files this run has actually
// finished and reports the remaining bytes at that rate.
//
//   node scratch/scan_eta.mjs

import fs from 'node:fs';
import path from 'node:path';

const CORPUS = 'extracted_jsc';
const SCANS = [
  { name: 'T7 recover', work: 'scratch/t7/corpus', strip: (f) => f.replace(/\.json$/, '') },
  { name: 'T8 structure', work: 'scratch/t8/corpus', strip: (f) => f.replace(/\.json$/, '') },
];

const sizeOf = new Map();
let corpusBytes = 0;
for (const f of fs.readdirSync(CORPUS)) {
  if (!f.endsWith('.jsc')) continue;
  const n = fs.statSync(path.join(CORPUS, f)).size;
  sizeOf.set(f, n);
  corpusBytes += n;
}
const corpusFiles = sizeOf.size;
const MiB = (n) => (n / 1048576).toFixed(1);
const dur = (s) => {
  if (!isFinite(s) || s < 0) return 'n/a';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

console.log(`corpus: ${corpusFiles} files, ${MiB(corpusBytes)} MiB\n`);

for (const s of SCANS) {
  if (!fs.existsSync(s.work)) { console.log(`${s.name}: no work dir\n`); continue; }
  const entries = fs.readdirSync(s.work).filter((f) => f.endsWith('.json'))
    .map((f) => {
      const st = fs.statSync(path.join(s.work, f));
      return { jsc: s.strip(f), mtime: st.mtimeMs, bytes: sizeOf.get(s.strip(f)) ?? 0 };
    })
    .sort((a, b) => a.mtime - b.mtime);

  if (!entries.length) { console.log(`${s.name}: nothing done yet\n`); continue; }

  const doneBytes = entries.reduce((a, e) => a + e.bytes, 0);
  const doneFiles = entries.length;

  // A gap of more than 10 minutes between consecutive results means the scan
  // was stopped and restarted; only the current continuous run tells us the
  // rate the machine is managing right now.
  let runStart = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].mtime - entries[i - 1].mtime > 10 * 60 * 1000) runStart = i;
  }
  const run = entries.slice(runStart);
  const spanSec = (Date.now() - run[0].mtime) / 1000;
  const runBytes = run.reduce((a, e) => a + e.bytes, 0);

  const remainingFiles = corpusFiles - doneFiles;
  const remainingBytes = corpusBytes - doneBytes;
  const byteRate = runBytes / Math.max(1, spanSec);
  const fileRate = run.length / Math.max(1, spanSec);
  const sinceLast = (Date.now() - entries[entries.length - 1].mtime) / 1000;

  console.log(`${s.name}  (${s.work})`);
  console.log(`  done        ${doneFiles} / ${corpusFiles} files   ${MiB(doneBytes)} / ${MiB(corpusBytes)} MiB = ${(100 * doneBytes / corpusBytes).toFixed(1)}% of the bytes`);
  console.log(`  this run    ${run.length} files in ${dur(spanSec)}  (${MiB(runBytes)} MiB)`);
  console.log(`  rate        ${(byteRate / 1024).toFixed(1)} KiB/s   ${(fileRate * 60).toFixed(1)} files/min`);
  console.log(`  remaining   ${remainingFiles} files, ${MiB(remainingBytes)} MiB`);
  console.log(`  ETA         ${dur(remainingBytes / Math.max(1, byteRate))}   (by file count: ${dur(remainingFiles / Math.max(1e-9, fileRate))})`);
  console.log(`  last result ${sinceLast < 120 ? `${sinceLast.toFixed(0)} s ago` : `${(sinceLast / 60).toFixed(1)} min ago -- check it is still running`}`);
  console.log();
}

// The five files T8 called the hardest, so the tail is visible rather than a
// surprise at the end.
const biggest = [...sizeOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('largest 5 inputs (the tail of both scans):');
for (const [f, n] of biggest) {
  const t7 = fs.existsSync(path.join('scratch/t7/corpus', `${f}.json`));
  const t8 = fs.existsSync(path.join('scratch/t8/corpus', `${f}.json`));
  console.log(`  ${MiB(n).padStart(6)} MiB  ${f.padEnd(34)} T7:${t7 ? 'done' : ' -- '}  T8:${t8 ? 'done' : ' -- '}`);
}
console.log(`  these 5 = ${MiB(biggest.reduce((a, [, n]) => a + n, 0))} MiB = ${(100 * biggest.reduce((a, [, n]) => a + n, 0) / corpusBytes).toFixed(1)}% of the corpus`);
