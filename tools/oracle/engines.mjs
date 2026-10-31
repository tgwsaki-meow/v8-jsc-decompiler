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
