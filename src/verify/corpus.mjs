// Loader for corpus/features/manifest.json + the execution safety policy.
//
// EXECUTION POLICY (enforced by assertExecutable, not just documented):
//
//   The only JavaScript this project is ever allowed to EXECUTE is code we
//   wrote ourselves -- corpus/features/** -- and the decompiler's output for
//   those same files, which lives in the O3 work directory. `extracted_jsc/`
//   and `decompiled_js/` are reverse-engineered third-party code from a chat
//   client: they are read, parsed, disassembled and compared, and never run.
//   O1 and O2 only ever COMPILE (vm.Script / --print-bytecode), which is also
//   all they need.
//
// Every entry point that can lead to execution calls assertExecutable() first.

import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_DIR = path.resolve('corpus/features');
export const MANIFEST = path.join(CORPUS_DIR, 'manifest.json');
/** Directories whose contents O3 may execute, in addition to CORPUS_DIR. */
export const WORK_ROOTS = [path.resolve('scratch/t3/work')];
/** Directories whose contents must never be executed. */
const FORBIDDEN = ['extracted_jsc', 'decompiled_js'].map((d) => path.resolve(d));

export class ExecutionPolicyError extends Error {}

/** Throw unless `p` is a file we are allowed to run. */
export function assertExecutable(p) {
  const abs = path.resolve(p);
  for (const bad of FORBIDDEN) {
    if (abs === bad || abs.startsWith(bad + path.sep)) {
      throw new ExecutionPolicyError(`refusing to execute ${abs}: ${path.basename(bad)}/ is third-party code and is never run`);
    }
  }
  const allowed = [CORPUS_DIR, ...WORK_ROOTS];
  if (!allowed.some((root) => abs === root || abs.startsWith(root + path.sep))) {
    throw new ExecutionPolicyError(`refusing to execute ${abs}: outside the corpus and the O3 work directory`);
  }
  return abs;
}

export function loadManifest(file = MANIFEST) {
  if (!fs.existsSync(file)) throw new Error(`corpus manifest not found: ${file} (run node scratch/t3/gen_corpus.mjs)`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of doc.entries) e.abs = path.resolve(e.file);
  return doc;
}

export function loadEntries(opts = {}) {
  const doc = loadManifest(opts.file);
  let entries = doc.entries;
  if (opts.groups) entries = entries.filter((e) => opts.groups.includes(e.group));
  if (opts.ids) entries = entries.filter((e) => opts.ids.includes(e.id));
  if (opts.kind) entries = entries.filter((e) => e.scriptOrModule === opts.kind);
  if (opts.grep) entries = entries.filter((e) => new RegExp(opts.grep).test(e.id));
  return entries;
}

/**
 * Deterministic stratified sample: walks the groups round-robin so a sample of
 * N covers as many feature families as possible, and is stable across runs.
 */
export function stratify(entries, n) {
  if (!n || n >= entries.length) return entries.slice();
  const byGroup = new Map();
  for (const e of entries) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, []);
    byGroup.get(e.group).push(e);
  }
  const groups = [...byGroup.keys()].sort();
  const out = [];
  for (let round = 0; out.length < n; round++) {
    let progressed = false;
    for (const g of groups) {
      const list = byGroup.get(g);
      if (round < list.length) {
        out.push(list[round]);
        progressed = true;
        if (out.length >= n) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export function readSource(entry) {
  return fs.readFileSync(entry.abs ?? path.resolve(entry.file), 'utf8');
}
