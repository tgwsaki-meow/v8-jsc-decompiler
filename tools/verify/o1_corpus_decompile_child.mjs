// tools/verify/o1_corpus_decompile_child.mjs
//
// One decompile, one process, for O1-on-corpus.
//
//   node --max-old-space-size=N tools/verify/o1_corpus_decompile_child.mjs \
//        <in.jsc> <out.js> <out.meta.json> [profileDir]
//
// Why not `src/verify/pipeline.mjs::decompileInChild`: that wrapper replaces
// the emitter's `perFunction` with the Babel-split one
// (`{index, name, bytes}`), which drops `sfiId`. O1-on-corpus needs
// sfiId -> emitted identifier, because that map is what makes the pairing an
// identity rather than a similarity guess (see
// `src/verify/o1_corpus.mjs::pairCorpusFunctions`). It also re-parses the whole
// emitted text with Babel, which on a multi-megabyte output costs more than
// the decompile.
//
// Writes the code to a file and the metadata to JSON; never writes to stdout.
// Executes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { decompile } from '../../src/emit/decompile.mjs';

const [jscPath, codePath, metaPath, profileDir] = process.argv.slice(2);

const t0 = Date.now();
const meta = { ok: false, jsc: jscPath, ms: 0, stage: null, error: null };
try {
  const r = decompile(jscPath, profileDir ? { profile: profileDir } : {});
  fs.mkdirSync(path.dirname(codePath), { recursive: true });
  fs.writeFileSync(codePath, r.code ?? '', 'utf8');
  const nameBySfi = {};
  for (const f of r.perFunction ?? []) {
    // the script unit is emitted with name '<script>'; V8 names the top-level
    // SFI '' and `pairCorpusFunctions` keys it off `isTopLevel`, so it is left
    // out rather than given a name it does not have in the listing.
    if (f.name && f.name !== '<script>') nameBySfi[f.sfiId] = f.name;
  }
  meta.ok = true;
  meta.stage = 'complete';
  meta.codeBytes = Buffer.byteLength(r.code ?? '', 'utf8');
  meta.nameBySfi = nameBySfi;
  meta.emittedFunctions = r.report?.functionsEmitted ?? null;
  meta.deserializedFunctions = r.report?.deserializedFunctions ?? null;
  meta.compiledUnits = r.report?.compiledUnits ?? null;
  meta.functionsFailed = r.report?.functionsFailed ?? null;
  meta.orphans = r.report?.orphans ?? null;
  meta.holes = r.report?.holes?.total ?? null;
  meta.failuresByStage = r.report?.failuresByStage ?? null;
} catch (e) {
  meta.stage = 'throw';
  meta.error = `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e)}`.slice(0, 500);
  meta.at = String(e?.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? null;
}
meta.ms = Date.now() - t0;
const cpu = process.cpuUsage();
meta.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
fs.mkdirSync(path.dirname(metaPath), { recursive: true });
fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
