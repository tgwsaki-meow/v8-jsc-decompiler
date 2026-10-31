#!/usr/bin/env node
// Fetch an Electron release archive and extract the V8 snapshot blobs, and
// optionally the executable itself.
//
// Why: the corpus's .jsc headers carry readOnlySnapshotChecksum = 0x4be885e,
// which is adler32-with-seed-0 of the read-only section of whichever
// snapshot blob the producing isolate used. An official V8 `d8` archive does
// NOT reproduce it (its read-only heap differs: different build tree, and no
// embedder-interned strings), so the only artifact that can *prove* a match is
// the embedder's own blob. Electron 40.0.0 ships V8 14.4.258.16 exactly
// (releases.electronjs.org/releases.json).
//
// `--binary` additionally unpacks the whole archive, which is what O1 on the
// corpus needs: stream B is our own output compiled back to a .jsc, and it has
// to be compiled by the corpus's own V8 or the comparison measures the
// difference between two V8 versions instead of measuring the decompiler
// (docs/O1.md 1). The executable cannot be unpacked on its own -- run as a
// node it still loads the snapshot blobs and its bundled shared libraries from
// its own directory -- so this mode takes the archive whole.
//
// Usage: node tools/oracle/fetch_electron.mjs 40.0.0 win32-x64 [--binary]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extractZip } from './unzip.mjs';

const version = process.argv[2] ?? '40.0.0';
const platform = process.argv[3] ?? 'win32-x64';
const WANT_BINARY = process.argv.includes('--binary');
const CACHE = path.resolve('.v8bin-cache');
const name = `electron-v${version}-${platform}.zip`;
const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;
const zipPath = path.join(CACHE, name);

fs.mkdirSync(CACHE, { recursive: true });

if (!fs.existsSync(zipPath)) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const size = Number(head.headers.get('content-length'));
  console.log(`GET ${url}`);
  console.log(`  size: ${size} bytes (${(size / 1048576).toFixed(1)} MiB)`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const tmp = zipPath + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, lastLog = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (got - lastLog > 16 * 1048576) { lastLog = got; console.log(`  ${(got / 1048576).toFixed(0)} / ${(size / 1048576).toFixed(0)} MiB`); }
  }
  out.end();
  await new Promise((r) => out.on('close', r));
  fs.renameSync(tmp, zipPath);
}

const buf = fs.readFileSync(zipPath);
console.log(`cached ${zipPath}`);
console.log(`  bytes=${buf.length} sha256=${crypto.createHash('sha256').update(buf).digest('hex')}`);

// Extract only the two snapshot blobs; both extractors take member names as
// trailing operands. See tools/oracle/unzip.mjs for why this is not just `tar`.
// `--binary` passes no members, which means the whole archive.
const dir = zipPath.replace(/\.zip$/, '');
fs.mkdirSync(dir, { recursive: true });
if (WANT_BINARY) {
  const by = extractZip(zipPath, dir, []);
  console.log(`  unpacked the whole archive with ${by}`);
}
for (const member of ['v8_context_snapshot.bin', 'snapshot_blob.bin']) {
  try {
    if (!WANT_BINARY) extractZip(zipPath, dir, [member]);
    const p = path.join(dir, member);
    const b = fs.readFileSync(p);
    console.log(`  ${member}: ${b.length} bytes sha256=${crypto.createHash('sha256').update(b).digest('hex')}`);
  } catch (e) {
    console.log(`  ${member}: NOT FOUND in archive (${String(e.message).slice(0, 120)})`);
  }
}
console.log(`unpacked -> ${dir}`);

if (WANT_BINARY) {
  // The zip carries a POSIX mode, but not every extractor applies it, and an
  // electron with no execute bit fails as ENOENT-looking EACCES much later, in
  // the minter, one file at a time. Set it here and say what happened.
  const exe = ['electron.exe', 'electron'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!exe) {
    console.error(`::error::no electron executable in ${dir} after unpacking ${name}`);
    process.exit(2);
  }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  const st = fs.statSync(exe);
  console.log(`  executable: ${exe} (${st.size} bytes, mode ${(st.mode & 0o777).toString(8)})`);

  // Prove it runs HERE, before anything depends on it. On a Linux runner the
  // electron binary links against a long list of system libraries even when it
  // is only going to act as a node, so "the download succeeded" and "the
  // minter works" are different facts. This also pins the V8 version from the
  // binary itself rather than from a string written down in mint.mjs.
  const r = spawnSync(exe, ['-p', 'JSON.stringify(process.versions)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(`::error::${path.basename(exe)} as a node exited ${r.status}: `
      + `${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 500)}`);
    process.exit(3);
  }
  let v = {};
  try { v = JSON.parse(String(r.stdout).trim()); } catch { /* reported raw below */ }
  console.log(`  runs as a node: v8 ${v.v8 ?? String(r.stdout).trim().slice(0, 120)}, `
    + `node ${v.node ?? '?'}, electron ${v.electron ?? '?'}`);
}
