// src/cache/version-hash.mjs
//
// Reimplementation of V8's `Version::Hash()`, the value a `.jsc` header stores
// at `kVersionHashOffset`. It is the only header hash that can be checked
// against a profile from first principles, because it is a pure function of
// the four version numbers -- which the profile states -- and nothing else.
//
//   Version::Hash()                 src/utils/version.h
//     = base::hash_combine(major_, minor_, build_, patch_)
//     = Hasher::Combine(major, minor, build, patch)
//     = fold hash_combine(acc, hash<int>{}(n)) over the four numbers, acc = 0
//
//   hash<int>{}(n)                  src/base/hashing.h
//     = hash_value(signed int)  ->  hash_value(unsigned int)
//     ->  hash_value_unsigned_impl<uint32_t>   (Thomas Wang 32-bit mix)
//
//   hash_combine(seed, hash)        src/base/hashing.h, 64-bit host branch
//     (MurmurHash64A mix; the 32-bit-host branch is a different function, so
//      this reader is correct for 64-bit builds -- which is every build that
//      produces a .jsc we can read, and is asserted by the two-version check
//      in the self-test)
//
// ---------------------------------------------------------------------------
// THE ONE FILE UNDER src/cache + src/heap THAT CONTAINS NUMERIC CONSTANTS.
//
// They are mixing constants of two published hash functions (Thomas Wang's
// integer hash and MurmurHash64A). They are not V8 version data: they have not
// changed in the lifetime of src/base/hashing.h, and this module's correctness
// is established empirically rather than by assertion -- the self-test feeds it
// the version strings of both profiles and requires it to reproduce the
// `versionHash` field of a real `.jsc` produced by each. A version-dependent
// constant could not satisfy both at once.
// ---------------------------------------------------------------------------

const U64 = (1n << 64n) - 1n;

/** Thomas Wang 32-bit integer mix, zero-extended to 64 bits. */
function hashValueUint32(v) {
  let x = v >>> 0;
  x = (~x + (x << 15)) >>> 0;
  x = (x ^ (x >>> 12)) >>> 0;
  x = (x + (x << 2)) >>> 0;
  x = (x ^ (x >>> 4)) >>> 0;
  x = Number((BigInt(x) * 2057n) & 0xffffffffn); // v * 2057, 32-bit wraparound
  x = (x ^ (x >>> 16)) >>> 0;
  return BigInt(x);
}

/** MurmurHash64A-style combine, the 64-bit-host branch of base::hash_combine. */
function hashCombine64(seed, hash) {
  const m = 0xc6a4a7935bd1e995n;
  const r = 47n;
  let h = (hash * m) & U64;
  h ^= h >> r;
  h = (h * m) & U64;
  let s = seed ^ h;
  s = (s * m) & U64;
  return s;
}

/**
 * @param {number[]} parts  [major, minor, build, patch]
 * @returns {number} uint32
 */
export function versionHashFromParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`versionHashFromParts: expected integers, got ${JSON.stringify(parts)}`);
  }
  let acc = 0n;
  for (const n of parts) acc = hashCombine64(acc, hashValueUint32(n));
  return Number(acc & 0xffffffffn) >>> 0;
}

/**
 * `"14.4.258.16"` -> uint32. A trailing embedder suffix such as
 * node's `-node.40` is not part of the hashed numbers and is ignored.
 */
export function versionHashFromString(version) {
  const core = String(version).split('-')[0];
  const parts = core.split('.').map((s) => Number.parseInt(s, 10));
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`versionHashFromString: cannot parse ${JSON.stringify(version)}`);
  return versionHashFromParts(parts);
}

export default { versionHashFromParts, versionHashFromString };
