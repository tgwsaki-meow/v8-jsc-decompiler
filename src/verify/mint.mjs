// Mint a .jsc (V8 code cache) from a JavaScript source, with a pluggable
// producing engine.
//
// Why this exists: O1/O2 need the *input* to the decompiler, and the corpus is
// source, not cache. `vm.Script(src, {produceCachedData:true})` is V8's own
// CodeSerializer, i.e. exactly the producer that made `extracted_jsc/`.
//
// Which engine mints matters, measurably:
//
//   engine                         V8            .jsc magic   versionHash
//   local node (process.execPath)  14.6.202.34   0xc0de06a9   0x97ffbd52
//   electron 40.0.0 (as node)      14.4.258.16   0xc0de0674   0x12819a30
//   the corpus (extracted_jsc/*)   ?             0xc0de0674   0x12819a30
//
// The Electron build is a bit-for-bit header match with the corpus, because
// Electron 40 ships V8 14.4.258.16 and the magic is 0xC0DE0000 ^
// ExternalReferenceTable::kSize. The local node's cache is a *different*
// serialization: six comparison bytecodes changed operand type between 14.4
// and 14.6 (ARCHITECTURE.md 1.3), so decoding it with the 14.4 tables
// desynchronises. Prefer electron; fall back to node and SAY SO in the row.
//
// Minting only COMPILES the source (no execution), so it is safe for any
// source. Nothing here executes anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

export const ELECTRON_CANDIDATES = [
  '.v8bin-cache/electron-v40.0.0-win32-x64/electron.exe',
  '.v8bin-cache/electron-v40.0.0-win32-x64/electron',
];
export const D8_CANDIDATES = [
  '.v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe',
  '.v8bin-cache/v8-linux64-rel-14.4.258.16/d8',
];

const CHILD = path.resolve('src/verify/mint_child.cjs');

export function findElectron() {
  for (const c of ELECTRON_CANDIDATES) if (fs.existsSync(c)) return path.resolve(c);
  return null;
}
export function findD8() {
  for (const c of D8_CANDIDATES) if (fs.existsSync(c)) return path.resolve(c);
  return null;
}

/** Decode the 32-byte code cache header (ARCHITECTURE.md 3.1). */
export function readJscHeader(buf) {
  if (buf.length < 32) return null;
  const sourceHash = buf.readUInt32LE(8);
  return {
    magic: '0x' + buf.readUInt32LE(0).toString(16),
    versionHash: '0x' + buf.readUInt32LE(4).toString(16),
    sourceLength: sourceHash & 0x1fffffff,
    hasWrappedArgs: Boolean((sourceHash >>> 29) & 1),
    isModule: Boolean((sourceHash >>> 30) & 1),
    flagHash: '0x' + buf.readUInt32LE(12).toString(16),
    readOnlySnapshotChecksum: '0x' + buf.readUInt32LE(16).toString(16),
    payloadLength: buf.readUInt32LE(20),
    checksum: '0x' + buf.readUInt32LE(24).toString(16),
    totalBytes: buf.length,
  };
}

/**
 * Resolve a minter spec.
 *   'auto'      -> electron if present, else local node
 *   'node'      -> this process's V8, in-process (no child)
 *   'electron'  -> the cached Electron build
 *   <path>      -> any node-compatible executable, run as a child
 */
export function resolveMinter(spec = 'auto') {
  if (spec === 'node') {
    return { kind: 'node', exe: process.execPath, label: `node ${process.version}`, v8: process.versions.v8, inProcess: true };
  }
  if (spec === 'auto' || spec === 'electron') {
    const e = findElectron();
    if (e) return { kind: 'electron', exe: e, label: path.basename(e), v8: '14.4.258.16', inProcess: false };
    if (spec === 'electron') throw new Error(`electron not found; looked in ${ELECTRON_CANDIDATES.join(', ')}`);
    return resolveMinter('node');
  }
  const exe = path.resolve(spec);
  if (!fs.existsSync(exe)) throw new Error(`minter not found: ${exe}`);
  return { kind: 'external', exe, label: path.basename(exe), v8: null, inProcess: false };
}

/** The `--print-bytecode` engine that matches a minter's V8 (for O1). */
export function matchingBytecodeEngine(minter) {
  if (minter.kind === 'node') return 'node';
  // Electron is V8 14.4.258.16; the cached d8 is 14.4.258.17 -- same minor, and
  // d8 prints only the script's own functions, where node (built with --no-lazy
  // in effect for its own internals) pollutes the listing with its bootstrap.
  const d8 = findD8();
  if (d8) return d8;
  return 'node';
}

function mintInProcess(source, outPath, isModule) {
  if (isModule) {
    // Modules need vm.SourceTextModule, which is behind a flag; the child path
    // handles it. In-process, report why instead of guessing.
    if (typeof vm.SourceTextModule !== 'function') {
      return { ok: false, error: 'vm.SourceTextModule unavailable (needs --experimental-vm-modules)' };
    }
  }
  try {
    if (isModule) {
      const m = new vm.SourceTextModule(source, { identifier: outPath });
      const cd = m.createCachedData();
      fs.writeFileSync(outPath, cd);
      return { ok: true, bytes: cd.length };
    }
    const s = new vm.Script(source, { filename: outPath, produceCachedData: true });
    const cd = s.cachedData ?? s.createCachedData();
    fs.writeFileSync(outPath, cd);
    return { ok: true, bytes: cd.length };
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

function mintInChild(minter, srcPath, outPath, isModule, timeoutMs) {
  const logPath = outPath + '.mintlog.txt';
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(minter.exe, ['--experimental-vm-modules', CHILD, srcPath, outPath, isModule ? 'module' : 'script'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: timeoutMs,
    });
  } finally {
    fs.closeSync(fd);
  }
  const log = fs.readFileSync(logPath, 'utf8');
  if (r.status === 0 && fs.existsSync(outPath)) {
    let info = {};
    const m = log.match(/\{[^\n]*\}/);
    if (m) { try { info = JSON.parse(m[0]); } catch { /* keep the raw log */ } }
    return { ok: true, bytes: fs.statSync(outPath).size, child: info };
  }
  return { ok: false, error: `minter exited ${r.status}${r.error ? ' ' + r.error.message : ''}: ${log.trim().slice(0, 300)}` };
}

/**
 * Compile `source` to a .jsc at `outPath`.
 * @returns {{ok, jscPath?, bytes?, header?, minter, error?}}
 */
export function mintJsc({ source, sourcePath, outPath, minter = 'auto', isModule = false, timeoutMs = 60_000 }) {
  const m = typeof minter === 'object' ? minter : resolveMinter(minter);
  const out = path.resolve(outPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let src = source;
  let spath = sourcePath;
  if (src === undefined) src = fs.readFileSync(sourcePath, 'utf8');
  if (!spath) {
    spath = out.replace(/\.jsc$/, '') + (isModule ? '.src.mjs' : '.src.js');
    fs.writeFileSync(spath, src, 'utf8');
  }
  fs.rmSync(out, { force: true });
  const r = m.inProcess ? mintInProcess(src, out, isModule)
                        : mintInChild(m, path.resolve(spath), out, isModule, timeoutMs);
  if (!r.ok) return { ok: false, minter: m, sourcePath: spath, error: r.error };
  const buf = fs.readFileSync(out);
  return {
    ok: true, jscPath: out, sourcePath: spath, bytes: buf.length,
    header: readJscHeader(buf), minter: m, child: r.child,
    sourceLengthMatches: readJscHeader(buf).sourceLength === src.length,
  };
}

/**
 * O2's negative control: V8 sets cachedDataRejected when the cached data does
 * not belong to the source it is handed. Only meaningful for cache minted by
 * THIS process's V8, so it is reported separately from the fixpoint result.
 */
export function cachedDataControl(source) {
  try {
    const s = new vm.Script(source, { produceCachedData: true });
    const cd = s.cachedData ?? s.createCachedData();
    const same = new vm.Script(source, { cachedData: cd });
    const mutated = new vm.Script(source + ' ', { cachedData: cd });
    return {
      ok: true,
      sameSourceRejected: same.cachedDataRejected,
      mutatedSourceRejected: mutated.cachedDataRejected,
      controlPasses: same.cachedDataRejected === false && mutated.cachedDataRejected === true,
    };
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${e.message}` };
  }
}
