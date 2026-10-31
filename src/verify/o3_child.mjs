// Run ONE program in an isolated vm context with the instrumented global, and
// write its observable trace as JSON. One program per process, so a hang, an
// infinite loop or an OOM costs one row.
//
// EXECUTION POLICY: this is the only file in the project that executes
// JavaScript under test, and it refuses to run anything that is not ours --
// see assertExecutable() in corpus.mjs. corpus/features/** and the decompiled
// output of corpus/features/** only. Never extracted_jsc/, never
// decompiled_js/.
//
// argv: <codePath> <outJsonPath> <script|module> [--invoke-main] [--timeout=ms]
//
// --invoke-main is an accommodation for the current emitter, which wraps the
// whole script body in `function main(){...}` and never calls it. Without it
// every decompiled trace is empty for a packaging reason rather than a
// semantic one. It only fires when the trace is otherwise empty, and the row
// records that it fired.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRecorder, ser } from './trace.mjs';
import { assertExecutable, CORPUS_DIR } from './corpus.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [codePath, outPath, kind] = args.filter((a) => !a.startsWith('--'));
const invokeMain = flags.includes('--invoke-main');
const timeoutMs = Number((flags.find((f) => f.startsWith('--timeout=')) ?? '--timeout=4000').slice(10));

const result = { codePath, kind, invokeMain: false, status: 'ok', records: [], durationMs: 0 };
const t0 = Date.now();

function finish(code = 0) {
  result.durationMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result), 'utf8');
  process.exit(code);
}

let rec;
try {
  assertExecutable(codePath);
  const source = fs.readFileSync(codePath, 'utf8');
  rec = createRecorder();
  const sandbox = { ...rec.globals };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { name: 'o3', codeGeneration: { strings: true, wasm: false } });

  process.on('unhandledRejection', (e) => { rec.note('throw', { value: 'unhandledRejection ' + ser(e) }); });
  process.on('uncaughtException', (e) => { rec.note('throw', { value: 'uncaught ' + ser(e) }); finish(0); });

  if (kind === 'module') {
    if (typeof vm.SourceTextModule !== 'function') {
      result.status = 'module-unsupported';
      result.error = 'vm.SourceTextModule unavailable (run node with --experimental-vm-modules)';
      finish(0);
    }
    const cache = new Map();
    const load = (spec, referrer) => {
      const abs = path.resolve(path.dirname(referrer.identifier), spec);
      assertExecutable(abs);
      if (cache.has(abs)) return cache.get(abs);
      const m = new vm.SourceTextModule(fs.readFileSync(abs, 'utf8'), { identifier: abs, context,
        initializeImportMeta(meta) { meta.url = 'file:///' + abs.replace(/\\/g, '/'); } });
      cache.set(abs, m);
      return m;
    };
    const mod = new vm.SourceTextModule(source, { identifier: path.resolve(codePath), context,
      initializeImportMeta(meta) { meta.url = 'file:///' + path.resolve(codePath).replace(/\\/g, '/'); },
      importModuleDynamically: (spec, ref) => { const m = load(spec, ref); return m.link(load).then(() => m.evaluate()).then(() => m); } });
    await mod.link(load);
    const v = await mod.evaluate({ timeout: timeoutMs });
    rec.note('done', { completion: ser(v) });
  } else {
    const script = new vm.Script(source, { filename: path.resolve(codePath) });
    try {
      const v = script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
      rec.note('done', { completion: ser(v) });
    } catch (e) {
      rec.note('throw', { value: ser(e) });
    }
    if (invokeMain && rec.records.filter((r) => r.k !== 'done' && r.k !== 'throw').length === 0) {
      const main = sandbox.main ?? (typeof sandbox.main === 'function' ? sandbox.main : undefined);
      if (typeof main === 'function') {
        result.invokeMain = true;
        try {
          const v = vm.runInContext('main()', context, { timeout: timeoutMs });
          rec.note('done', { completion: 'main() -> ' + ser(v) });
        } catch (e) {
          rec.note('throw', { value: 'main() threw ' + ser(e) });
        }
      }
    }
  }

  // Let promise jobs and queued continuations run. Stop as soon as the trace
  // stops growing, so a synchronous file costs one tick.
  let stable = 0, last = rec.records.length;
  const deadline = Date.now() + Math.min(timeoutMs, 3000);
  while (stable < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
    if (rec.records.length === last) stable++; else { stable = 0; last = rec.records.length; }
  }
  result.records = rec.records;
  finish(0);
} catch (e) {
  result.status = 'harness-error';
  result.error = `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`;
  result.records = rec ? rec.records : [];
  finish(0);
}
