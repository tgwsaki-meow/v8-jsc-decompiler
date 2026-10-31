#!/usr/bin/env node
// Fetch an Electron release archive and extract just the V8 snapshot blobs.
//
// Why: the corpus's .jsc headers carry readOnlySnapshotChecksum = 0x4be885e,
// which is adler32-with-seed-0 of the read-only section of whichever
// snapshot blob the producing isolate used. An official V8 `d8` archive does
// NOT reproduce it (its read-only heap differs: different build tree, and no
// embedder-interned strings), so the only artifact that can *prove* a match is
// the embedder's own blob. Electron 40.0.0 ships V8 14.4.258.16 exactly
// (releases.electronjs.org/releases.json).
//
// Usage: node tools/oracle/fetch_electron.mjs 40.0.0 win32-x64

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const version = process.argv[2] ?? '40.0.0';
const platform = process.argv[3] ?? 'win32-x64';
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

// Extract only the two snapshot blobs (bsdtar can select members).
const dir = zipPath.replace(/\.zip$/, '');
fs.mkdirSync(dir, { recursive: true });
for (const member of ['v8_context_snapshot.bin', 'snapshot_blob.bin']) {
  try {
    execFileSync('tar.exe', ['-xf', zipPath, '-C', dir, member], { stdio: 'inherit' });
    const p = path.join(dir, member);
    const b = fs.readFileSync(p);
    console.log(`  ${member}: ${b.length} bytes sha256=${crypto.createHash('sha256').update(b).digest('hex')}`);
  } catch (e) {
    console.log(`  ${member}: NOT FOUND in archive (${String(e.message).slice(0, 120)})`);
  }
}
console.log(`unpacked -> ${dir}`);
