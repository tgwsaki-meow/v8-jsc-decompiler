// tools/disasm/real_units.mjs
//
// Read a .jsc through T4's real pipeline (src/cache + src/heap) and hand
// src/disasm the FunctionUnits it produces.
//
// src/disasm is specified against ARCHITECTURE.md 8.1 and must consume T4's
// output with no adaptation at all. This module is how that is demonstrated:
// the oracle runs the SAME comparison twice on 14.4, once with
// src/disasm/adapter_legacy.mjs and once through here, and both must agree
// with V8 exactly. If the two input paths ever disagree, one of them is wrong
// about the contract and the oracle says which.
//
// Loaded lazily so that src/disasm and its tests keep working if src/cache or
// src/heap is absent or mid-refactor.

let mod = null;
let loadError = null;

async function load() {
  if (mod || loadError) return mod;
  try {
    const cache = await import('../../src/cache/index.mjs');
    const heap = await import('../../src/heap/index.mjs');
    if (typeof cache.loadEnvironment !== 'function' || typeof cache.readCache !== 'function'
      || typeof heap.buildUnits !== 'function') {
      throw new Error('src/cache or src/heap does not expose loadEnvironment/readCache/buildUnits');
    }
    mod = { cache, heap };
  } catch (e) {
    loadError = e;
  }
  return mod;
}

export async function haveRealCachePath() {
  return (await load()) !== null;
}

export function realCachePathError() { return loadError; }

const envCache = new Map();

/**
 * @param {string} file     a .jsc path
 * @param {string} tagOrDir the profile tag or directory
 * @returns {Promise<{units: Array, env: object}>}
 */
export async function unitsFromCache(file, tagOrDir) {
  const m = await load();
  if (!m) throw loadError;
  let env = envCache.get(tagOrDir);
  if (!env) {
    // requireRoHeap:false because only 14.4.258.16 ships ro-heap.json; an
    // unresolved read-only reference is then reported, never guessed.
    env = m.cache.loadEnvironment(tagOrDir, { requireRoHeap: false, strict: false });
    envCache.set(tagOrDir, env);
  }
  const read = m.cache.readCache(file, env);
  const built = m.heap.buildUnits(env, read.graph ?? read);
  const units = Array.isArray(built) ? built : (built.units ?? []);
  return { units, env, read, built };
}

export default { unitsFromCache, haveRealCachePath, realCachePathError };
