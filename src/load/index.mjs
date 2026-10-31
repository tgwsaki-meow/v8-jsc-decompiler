// src/load/index.mjs
//
// One .jsc file + one profile -> everything the back end needs:
//
//   loadUnits(file, tagOrDir) -> { units, env, read, graph, ctx,
//                                  scopeInfoById, profile }
//
// This is a composition layer over T1/T4 only. It spawns nothing, downloads
// nothing and contains no version literal; `tagOrDir` selects the profile and
// readCache() refuses a cache whose versionHash disagrees with it.
//
// Why it exists, and why it is in src/ rather than tools/:
//
// An 8.1 FunctionUnit carries `scope`, the function's own ScopeInfo with its
// `outer` chain, which resolves every Lda/StaContextSlot whose base is the
// incoming context. It does NOT resolve a slot of a context the function
// builds itself -- CreateBlockContext, CreateCatchContext, CreateWithContext
// and the function-context forms name their ScopeInfo through a constant-pool
// operand, and 8.1 renders that entry as `{t:'scopeInfo', scopeInfoId}`: an id
// with no names attached. Those ScopeInfos are in the deserialized graph, so
// they are decoded here with src/heap's own decoder and handed over as a Map
// keyed by the same id. src/ir treats the map as optional and reports
// `createdContextScopeInfoNotDecoded` when it is absent, so nothing is
// invented either way.
//
// It started life as tools/ir/units.mjs, with the note that it belonged in
// src/heap but could not go there while src/heap was being built. It is here
// now because src/cli/ and the W3 layers need it, and `src/` importing from
// `tools/` is the wrong direction (ARCHITECTURE.md 11.0). tools/ir/units.mjs
// re-exports this module, so every existing caller keeps working.

import path from 'node:path';
import { loadEnvironment, readCache } from '../cache/index.mjs';
import { buildUnits, HeapContext } from '../heap/index.mjs';
import { decodeScopeInfo } from '../heap/objects.mjs';
import { listProfiles } from '../profile/index.mjs';

const envCache = new Map();

/** Load (and memoise) a profile environment by tag or by profile directory. */
export function environmentFor(tagOrDir) {
  let env = envCache.get(tagOrDir);
  if (!env) {
    // requireRoHeap:false because only 14.4.258.16 ships ro-heap.json; an
    // unresolved read-only reference is reported, never guessed.
    env = loadEnvironment(tagOrDir, { requireRoHeap: false, strict: false });
    envCache.set(tagOrDir, env);
  }
  return env;
}

/**
 * @param {string|Buffer} file
 * @param {string} tagOrDir
 * @param {{scopeInfos?: boolean}} opts
 */
export function loadUnits(file, tagOrDir, opts = {}) {
  const env = environmentFor(tagOrDir);
  const read = readCache(file, env);
  const graph = read.graph ?? read;
  const ctx = new HeapContext(env, graph, {});
  const built = buildUnits(env, graph, { ctx });
  const units = Array.isArray(built) ? built : (built.units ?? []);

  let scopeInfoById = null;
  if (opts.scopeInfos !== false) {
    scopeInfoById = new Map();
    for (const rec of graph.objects) {
      let cls = null;
      try { cls = ctx.classifyObject(rec); } catch { continue; }
      if (cls?.className !== 'ScopeInfo') continue;
      let s = ctx.scopeInfoCache.get(rec.id);
      if (s === undefined) {
        try { s = decodeScopeInfo(rec, ctx); } catch { continue; }
      }
      if (s && !s.failed) scopeInfoById.set(rec.id, s);
    }
  }
  return { units, env, read, graph, ctx, scopeInfoById, profile: env.profile };
}

/**
 * Read a cache without being told which V8 produced it: try every profile
 * under profiles/ and keep the one whose versionHash the header agrees with.
 * readCache does that check itself and throws a CacheVersionError naming both
 * hashes, so this is "ask each in turn", not a guess.
 */
export function loadUnitsFromAnyProfile(file, opts = {}) {
  const tags = listProfiles();
  const tried = [];
  for (const tag of tags) {
    try {
      return loadUnits(file, path.join('profiles', tag), opts);
    } catch (e) {
      tried.push(`${tag}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`no profile under profiles/ can read ${file}:\n  ${tried.join('\n  ')}`);
}

export default { loadUnits, loadUnitsFromAnyProfile, environmentFor };
