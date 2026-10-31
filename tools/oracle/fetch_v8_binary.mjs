#!/usr/bin/env node
// Fetch an official V8 build archive from the `chromium-v8` GCS bucket and
// cache it under .v8bin-cache/.
//
// The bucket layout was established empirically from the XML listing API:
//
//   https://storage.googleapis.com/chromium-v8/?prefix=official/&delimiter=/
//     -> CommonPrefixes official/<major>.<minor>/      (5.7 .. 15.8)
//   https://storage.googleapis.com/chromium-v8/?prefix=official/14.4/&delimiter=/
//     -> Contents official/14.4/v8-<platform>-<channel>-<a.b.c[.d]>.zip
//
//   platform-channel values seen at 14.4:
//     android-arm32{,-libs}-rel  android-arm64{,-libs}-rel
//     linux-arm32{,-libs}-rel    linux-arm64{,-libs}-rel
//     linux32{-libs}-rel  linux32-dbg  linux64{-libs}-rel  linux64-dbg
//     mac64{-libs}-rel    mac64-dbg    mac-arm64{,-libs}-rel  mac-arm64-dbg
//     win32{-libs}-rel    win32-dbg    win64{-libs}-rel      win64-dbg
//
//   There is no "-pgo" twin in this bucket; `-pgo` only exists as a git *tag*
//   suffix (refs/tags/14.4.258.16-pgo), not as an archive name.
//
// Usage:
//   node tools/oracle/fetch_v8_binary.mjs --list 14.4
//   node tools/oracle/fetch_v8_binary.mjs --head linux64-rel 14.4.258.16
//   node tools/oracle/fetch_v8_binary.mjs --get  linux64-rel 14.4.258.16
//   node tools/oracle/fetch_v8_binary.mjs --get  linux64-rel 14.4.258.16 --unzip

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BUCKET = 'https://storage.googleapis.com/chromium-v8';
const CACHE = path.resolve('.v8bin-cache');

function keyFor(platform, version) {
  const minor = version.split('.').slice(0, 2).join('.');
  return `official/${minor}/v8-${platform}-${version}.zip`;
}

async function listMinor(minor) {
  const url = `${BUCKET}/?prefix=official/${minor}/&delimiter=/`;
  const res = await fetch(url);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<Key>(.*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
    out.push({ key: m[1], size: +m[2] });
  }
  return { status: res.status, entries: out };
}

async function head(platform, version) {
  const url = `${BUCKET}/${keyFor(platform, version)}`;
  const res = await fetch(url, { method: 'HEAD' });
  return {
    url,
    status: res.status,
    size: res.headers.get('content-length') ? +res.headers.get('content-length') : null,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

async function get(platform, version, { unzip = false } = {}) {
  const key = keyFor(platform, version);
  const url = `${BUCKET}/${key}`;
  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, path.basename(key));

  if (!fs.existsSync(zipPath)) {
    const h = await head(platform, version);
    if (h.status !== 200) throw new Error(`HEAD ${url} -> ${h.status}`);
    console.log(`downloading ${url}`);
    console.log(`  size: ${h.size} bytes (${(h.size / 1048576).toFixed(1)} MiB)  etag=${h.etag}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
  } else {
    console.log(`cached ${zipPath}`);
  }

  const buf = fs.readFileSync(zipPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`  ${zipPath}`);
  console.log(`  bytes=${buf.length} sha256=${sha}`);

  let dir = null;
  if (unzip) {
    dir = zipPath.replace(/\.zip$/, '');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      // Windows 10+ ships bsdtar as C:\Windows\system32\tar.exe; it reads zip.
      execFileSync('tar.exe', ['-xf', zipPath, '-C', dir], { stdio: 'inherit' });
    }
    console.log(`  unpacked -> ${dir}`);
    for (const f of walk(dir)) {
      const st = fs.statSync(f);
      console.log(`    ${String(st.size).padStart(12)}  ${path.relative(dir, f)}`);
    }
  }
  return { zipPath, sha256: sha, size: buf.length, dir };
}

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const argv = process.argv.slice(2);
const mode = argv[0];
if (mode === '--list') {
  const { status, entries } = await listMinor(argv[1]);
  console.log(`status=${status} objects=${entries.length}`);
  for (const e of entries) console.log(`${String(e.size).padStart(12)}  ${e.key}`);
} else if (mode === '--head') {
  console.log(JSON.stringify(await head(argv[1], argv[2]), null, 2));
} else if (mode === '--get') {
  await get(argv[1], argv[2], { unzip: argv.includes('--unzip') });
} else {
  console.log('usage: --list <minor> | --head <platform> <version> | --get <platform> <version> [--unzip]');
  process.exitCode = 2;
}
