// src/emit/decompile.mjs
//
// The ARCHITECTURE.md 11.4 entry point: one `.jsc` -> one JavaScript file.
//
//   decompile(jscPath, opts) -> { code, map, ast, perFunction, report }
//
// This is the signature `src/verify/pipeline.mjs` already wraps, so with
//
//   V8D_PIPELINE=src/emit/decompile.mjs
//
// the three oracles and the whole metrics dashboard measure this pipeline with
// no change to any of them.
//
// Layering (11.0): inputs come through `src/load/index.mjs`, which is also the
// only source of `scopeInfoById` -- the names of the contexts a function
// builds itself (ARCHITECTURE.md 10.3). Nothing here imports `src/verify/` or
// `tools/`, and nothing spawns an engine: the decompilation path has to be
// engine-independent by construction.
//
// Why the extra exports:
//
//   decompileFile   `pipeline.mjs` accepts `decompileFile` / `decompile` /
//                   `default`, so all three are exported and are the same
//                   function.
//   V8Decompiler    the richer branch of `pipeline.mjs::loadPipeline` only
//                   engages for a module exporting a `V8Decompiler` class, and
//                   that is the branch that fills in
//                   `deserializedFunctions` -- the DENOMINATOR of metric 6
//                   (functions emitted / functions deserialized). Without it
//                   the dashboard has nothing to divide by and metric 6 reads
//                   `null` for any pipeline that is not the retired one. The
//                   unit list is memoised per path, so answering the question
//                   twice costs one load.

import fs from 'node:fs';
import path from 'node:path';
import { loadUnits, loadUnitsFromAnyProfile } from '../load/index.mjs';
import { buildIR } from '../ir/index.mjs';
import { recover } from '../recover/index.mjs';
import { structure } from '../structure/index.mjs';
import { emit } from './index.mjs';

/**
 * Load one .jsc with whichever profile its header agrees with.
 * @param {string} jscPath
 * @param {{profile?: string}} opts
 */
/** How much of a failure message and of its top frame is kept in `failures[]`. */
const MAX_ERROR = 300;
const MAX_FRAME = 200;

export function loadFor(jscPath, opts = {}) {
  return opts.profile
    ? loadUnits(jscPath, opts.profile, { scopeInfos: opts.scopeInfos !== false })
    : loadUnitsFromAnyProfile(jscPath, { scopeInfos: opts.scopeInfos !== false });
}

/**
 * The whole back end for one file: units -> IR -> (values, graph) -> text.
 *
 * A unit that throws anywhere in the chain becomes a `failures[]` row and an
 * emitted stub, never an exception: ARCHITECTURE.md 11.5 wants every function
 * in the output, and a function that cannot be recovered is still a function
 * whose absence would have to be explained.
 */
export function decompile(jscPath, opts = {}) {
  const t0 = process.hrtime.bigint();
  const loaded = loadFor(jscPath, opts);
  const { units, profile, scopeInfoById } = loaded;
  const recs = [];
  const sfs = [];
  const failures = [];
  const stages = { ir: 0, recover: 0, structure: 0 };
  const limit = opts.maxUnits ?? Infinity;

  let n = 0;
  for (const u of units) {
    if (!u.bytecode) continue;
    if (++n > limit) break;
    let ir = null;
    try {
      const a = process.hrtime.bigint();
      ir = buildIR(u, { profile, scopeInfoById });
      stages.ir += Number(process.hrtime.bigint() - a) / 1e6;
    } catch (e) {
      failures.push(failureRow(u, 'ir', e));
      continue;
    }
    let rec = null;
    try {
      const a = process.hrtime.bigint();
      rec = recover(ir, { verify: opts.verifyInputs === true });
      stages.recover += Number(process.hrtime.bigint() - a) / 1e6;
    } catch (e) {
      failures.push(failureRow(u, 'recover', e));
      continue;
    }
    let sf = null;
    try {
      const a = process.hrtime.bigint();
      sf = structure(ir, { profile, verify: opts.verifyInputs === true });
      stages.structure += Number(process.hrtime.bigint() - a) / 1e6;
    } catch (e) {
      failures.push(failureRow(u, 'structure', e));
      continue;
    }
    recs.push(rec);
    sfs.push(sf);
  }

  const out = emit(recs, sfs, {
    ...opts,
    file: jscPath,
    units,
    failures,
  });
  out.report.inputBytes = fs.existsSync(jscPath) ? fs.statSync(jscPath).size : null;
  out.report.deserializedFunctions = units.filter((u) => u.bytecode).length;
  out.report.unitsInTheFile = units.length;
  out.report.failures = failures;
  out.report.failuresByStage = failures.reduce((a, f) => { a[f.stage] = (a[f.stage] ?? 0) + 1; return a; }, {});
  out.report.stageMs = {
    ir: +stages.ir.toFixed(1), recover: +stages.recover.toFixed(1),
    structure: +stages.structure.toFixed(1),
    emit: +(out.report.elapsedMs ?? 0).toFixed(1),
    total: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1),
  };
  out.report.profile = profile?.version ?? null;
  // `pipeline.mjs` reads `totalFunctions` off the result; keeping the name it
  // expects is what makes the oracles work with no change to them.
  out.totalFunctions = out.report.deserializedFunctions;
  out.header = loaded.read?.header ?? null;
  return out;
}

function failureRow(u, stage, e) {
  return {
    sfiId: u.sfiId, unit: u.bytecodeId ?? null, name: u.name ?? null, stage,
    error: `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, MAX_ERROR)}`,
    at: String(e?.stack ?? '').split('\n')[1]?.trim().slice(0, MAX_FRAME) ?? null,
  };
}

export const decompileFile = decompile;

/**
 * The shape `src/verify/pipeline.mjs` recognises as "a decompiler with its own
 * deserializer". Only this branch populates `deserializedFunctions`, which is
 * metric 6's denominator.
 */
export class V8Decompiler {
  constructor(opts = {}) {
    this.opts = opts;
    this.cache = new Map();
    this.deserializer = {
      deserializeFile: (p) => {
        const key = path.resolve(p);
        let loaded = this.cache.get(key);
        if (!loaded) { loaded = loadFor(p, this.opts); this.cache.set(key, loaded); }
        return {
          functions: loaded.units.filter((u) => u.bytecode),
          units: loaded.units,
          header: loaded.read?.header ?? null,
        };
      },
    };
  }

  decompileFile(p) {
    const r = decompile(p, this.opts);
    return {
      code: r.code, map: r.map, ast: r.ast, perFunction: r.perFunction,
      report: r.report, totalFunctions: r.totalFunctions, header: r.header,
    };
  }
}

export default decompile;
