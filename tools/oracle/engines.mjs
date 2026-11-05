// Engine-pluggable `--print-bytecode` runner.
//
//   --engine node          -> the node on PATH (its own V8; 14.6.202.34 here)
//   --engine <path-to-d8>  -> any V8 shell, e.g. the 14.4 d8 under .v8bin-cache
//
// Both accept the same V8 flags. Two details matter:
//
//  * Output is ALWAYS captured through a file, never a pipe. The agent terminal
//    on this machine drops piped stdout, and `--print-bytecode` output is large.
//  * `--no-lazy` forces inner functions to be compiled so they get printed;
//    `--no-enable-lazy-source-positions` makes V8 build the source position
//    table during the initial compile, which is what puts the `NN S>` / `NN E>`
//    markers in the listing. Without it the listing has no source positions at
//    all (verified on d8 14.4.258.17).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const DEFAULT_FLAGS = [
  '--print-bytecode',
  '--no-lazy',
  '--no-enable-lazy-source-positions',
];

// ------------------------------------------------- finding a cached engine
//
// A hard-coded `.v8bin-cache/<something>-win32-x64/<exe>` is a measurement
// that only runs on one developer's machine. docs/DISASM.md 10's dual-reader
// agreement was exactly that: `oracle_agreement.mjs` named
// `electron-v40.0.0-win32-x64/electron.exe` and `v8-win64-rel-14.4.258.17/
// d8.exe`, so on the ubuntu runner both 14.4 modes printed
// `SKIP: cache engine missing` and the job went green having measured only
// 14.6. The platform in a cache directory's name is the DOWNLOADER's, and the
// downloader on CI is the runner -- the same mistake
// `src/verify/mint.mjs::electronCandidates` already has a comment about.
//
// So scan, and scan for THIS HOST ONLY. Unlike a snapshot blob, an executable
// is not portable: a Windows cache can hold a Linux runner's ELF beside its
// own .exe, and preferring-but-accepting a foreign one just moves the failure
// into `spawn`. A foreign build is not a candidate.

const BIN_CACHE = path.resolve('.v8bin-cache');

/** How this host spells itself in each archive's directory name. */
const HOST = {
  // Electron publishes `electron-v<version>-<platform>-<arch>`.
  electron: process.platform,
  // chromium-v8's bucket publishes `v8-<platform><bits>-<channel>-<version>`.
  d8: { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform] ?? process.platform,
};

const EXE = (stem) => (process.platform === 'win32' ? `${stem}.exe` : stem);

/** Is this a file this host can actually execute? */
function runnable(p) {
  if (!fs.existsSync(p)) return false;
  if (process.platform === 'win32') return true;
  // A zip extractor that drops the POSIX mode leaves a file that exists and
  // cannot be run, which then fails as an EACCES that reads like ENOENT.
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function cacheDirs(re) {
  let ents;
  try { ents = fs.readdirSync(BIN_CACHE, { withFileTypes: true }); } catch { return []; }
  // sorted, so the choice never depends on readdir order
  return ents.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort();
}

/**
 * Every unpacked engine of `kind` for this host whose version starts with
 * `versionPrefix`, newest version first.
 *
 * @param {'d8'|'electron'} kind
 * @param {string} versionPrefix e.g. '14.4.258.' or '40.'
 */
export function engineCandidates(kind, versionPrefix = '') {
  const stem = kind === 'd8' ? 'd8' : 'electron';
  const re = kind === 'd8'
    ? /^v8-(.+)-([a-z]+)-([0-9][0-9.]*)$/
    : /^electron-v([0-9][0-9.]*)-([a-z0-9]+)-([a-z0-9]+)$/;
  const out = [];
  for (const name of cacheDirs(re)) {
    const m = re.exec(name);
    const version = kind === 'd8' ? m[3] : m[1];
    const platform = kind === 'd8' ? m[1] : m[2];
    if (!version.startsWith(versionPrefix)) continue;
    if (!platform.startsWith(HOST[kind])) continue;
    const exe = path.join(BIN_CACHE, name, EXE(stem));
    out.push({ kind, dir: name, version, platform, exe, runnable: runnable(exe) });
  }
  return out.sort((a, b) => cmpVersion(b.version, a.version));
}

function cmpVersion(a, b) {
  const xs = String(a).split('.').map(Number), ys = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const d = (xs[i] ?? 0) - (ys[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The cached engine to use, or `null` with every path that was considered.
 * Never throws: the caller decides whether a miss is a skip or a failure, and
 * `oracle_agreement.mjs` decides it is a failure.
 */
export function findCachedEngine(kind, versionPrefix = '') {
  const cands = engineCandidates(kind, versionPrefix);
  const hit = cands.find((c) => c.runnable);
  return {
    found: hit ?? null,
    considered: cands.map((c) => `${c.exe}${c.runnable ? '' : ' (present but not executable)'}`),
    why: cands.length
      ? `${cands.length} ${kind} director${cands.length === 1 ? 'y' : 'ies'} for ${HOST[kind]} matched `
        + `${versionPrefix || 'any version'}, none runnable`
      : `no ${kind} directory for this host (${HOST[kind]}) matching ${versionPrefix || 'any version'} `
        + `under ${BIN_CACHE}/ -- fetch it with `
        + (kind === 'd8'
          ? 'tools/oracle/fetch_v8_binary.mjs --get <platform>-rel <version> --unzip'
          : 'tools/oracle/fetch_electron.mjs <version> <platform> --binary'),
  };
}

export function resolveEngine(spec) {
  if (!spec || spec === 'node') {
    return { kind: 'node', exe: process.execPath, cwd: process.cwd(), label: `node ${process.version} (v8 ${process.versions.v8})` };
  }
  const exe = path.resolve(spec);
  if (!fs.existsSync(exe)) throw new Error(`engine not found: ${exe}`);
  // d8 needs snapshot_blob.bin / icudtl.dat next to it, so run it from its own
  // directory and hand it an absolute script path.
  return { kind: 'd8', exe, cwd: path.dirname(exe), label: path.basename(exe) };
}

export function engineVersion(engine) {
  if (engine.kind === 'node') return process.versions.v8;
  const tmp = path.join(os.tmpdir(), `v8ver-${process.pid}.js`);
  fs.writeFileSync(tmp, 'print(version());\n');
  const out = path.join(os.tmpdir(), `v8ver-${process.pid}.txt`);
  try {
    runCaptured(engine, [], tmp, out);
    return fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).pop();
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(out, { force: true });
  }
}

/** Run the engine with stdout+stderr redirected into `outFile` (never a pipe). */
function runCaptured(engine, flags, scriptPath, outFile) {
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(engine.exe, [...flags, path.resolve(scriptPath)], {
      cwd: engine.cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      maxBuffer: 1 << 28,
    });
    return r.status;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compile `source` with the engine and return the raw `--print-bytecode` text.
 * @param {object} engine from resolveEngine()
 * @param {string} source JavaScript source
 * @param {object} opts {filter, flags, workDir, keep}
 */
export function printBytecode(engine, source, opts = {}) {
  const work = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'o1-oracle-'));
  fs.mkdirSync(work, { recursive: true });
  // The repo's own package.json declares "type": "module", so a .js file
  // written anywhere under the workspace would be loaded by node as an ES
  // module -- i.e. in STRICT MODE -- while d8 runs the same file as a classic
  // sloppy script. That single difference changes emitted bytecode (e.g.
  // `delete o[k]` becomes DeletePropertyStrict instead of DeletePropertySloppy),
  // which would show up as a bogus cross-engine divergence. Pin the work
  // directory to commonjs so both engines see a sloppy classic script.
  const pkg = path.join(work, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{"type":"commonjs"}\n');
  const srcPath = path.join(work, (opts.name ?? 'snippet') + '.js');
  const outPath = path.join(work, (opts.name ?? 'snippet') + '.bytecode.txt');
  fs.writeFileSync(srcPath, source, 'utf8');

  const flags = [...(opts.flags ?? DEFAULT_FLAGS)];
  if (opts.filter) flags.push(`--print-bytecode-filter=${opts.filter}`);

  const status = runCaptured(engine, flags, srcPath, outPath);
  const text = fs.readFileSync(outPath, 'utf8');
  return { text, status, srcPath, outPath, workDir: work, flags };
}

/** Same, for a source file already on disk. */
export function printBytecodeFile(engine, filePath, opts = {}) {
  return printBytecode(engine, fs.readFileSync(filePath, 'utf8'), {
    ...opts, name: opts.name ?? path.basename(filePath, path.extname(filePath)),
  });
}

export { runCaptured };
