// src/cache/index.mjs
//
// `.jsc` -> header + slot-level object graph.
//
// Layering:
//   src/profile      profile tables (generated, version-specific data)
//   src/cache        this layer: header, byte source, deserializer loop
//   src/heap         typed views over the object graph, FunctionUnit
//
// Nothing in this layer knows what a BytecodeArray is. It knows the container
// format and nothing about the objects inside it.

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, loadProfileForVersion, listProfiles } from '../profile/index.mjs';
import { loadOverlay } from './overlay.mjs';
import { parseHeader, verifyHeader, verifyPayloadChecksum, formatHeader } from './header.mjs';
import { deserializePayload, Deserializer, RefKind } from './deserialize.mjs';
import { SnapshotByteSource, CacheFormatError, CacheVersionError, UnimplementedTagError } from './source.mjs';
import { versionHashFromString } from './version-hash.mjs';

export { parseHeader, verifyHeader, verifyPayloadChecksum, formatHeader };
export { deserializePayload, Deserializer, RefKind };
export { SnapshotByteSource, CacheFormatError, CacheVersionError, UnimplementedTagError };
export { versionHashFromString };
export { loadOverlay };

/**
 * A profile plus everything the front end needs alongside it.
 * Load once, reuse across files: the read-only table is ~1 MB of JSON.
 */
export class CacheEnvironment {
  constructor(profile, overlay, roHeap, roHeapFile) {
    this.profile = profile;
    this.overlay = overlay;
    this.roHeap = roHeap;
    this.roHeapFile = roHeapFile;
  }

  get version() { return this.profile.version; }

  summary() {
    return [
      this.profile.summary(),
      this.overlay.summary(),
      `read-only table ${this.roHeapFile}: ${Object.keys(this.roHeap?.objects ?? {}).length} objects, `
      + `${(this.roHeap?.pages ?? []).length} pages`,
    ].join('\n');
  }
}

/**
 * Load a profile directory, its build facts and its read-only table.
 *
 * @param {string} tagOrDir      '14.4.258.16' or 'profiles/14.4.258.16'
 * @param {{profilesRoot?: string, overlayFile?: string, roHeapFile?: string, strict?: boolean}} opts
 */
export function loadEnvironment(tagOrDir, opts = {}) {
  const profilesRoot = opts.profilesRoot ?? 'profiles';
  let profile;
  if (fs.existsSync(tagOrDir) && fs.existsSync(path.join(tagOrDir, 'meta.json'))) {
    profile = loadProfile(tagOrDir, { strict: opts.strict ?? true });
  } else {
    profile = loadProfileForVersion(tagOrDir, { root: profilesRoot, strict: opts.strict ?? true });
  }
  // The C++ enums, the FunctionKind groups and the code-cache header's content
  // come out of this same profile (they used to come from layouts-overlay/).
  // `overlayFile` reads a tools/layoutpatch file instead, which exists only to
  // compare the two independent derivations.
  const overlay = loadOverlay(profile.version, opts.overlayFile ? { file: opts.overlayFile } : { profile });

  // The authoritative read-only table. ARCHITECTURE.md 3.6: static-roots.json
  // is structurally the wrong instrument for kReadOnlyHeapRef, because
  // CodeSerializer emits kRootArray for anything that is a root, so a
  // kReadOnlyHeapRef is by construction never a root.
  const roFile = opts.roHeapFile ?? path.join(profile.dir, 'ro-heap.json');
  let roHeap = null;
  if (fs.existsSync(roFile)) {
    roHeap = JSON.parse(fs.readFileSync(roFile, 'utf8'));
  } else if (opts.requireRoHeap !== false) {
    throw new CacheVersionError(
      `read-only table not found at ${roFile}. Generate it with:\n`
      + `  node tools/oracle/gen_ro_heap.mjs --blob <v8_context_snapshot.bin> --static-roots <static-roots-*.h> --tag ${profile.version}\n`
      + 'Without it every kReadOnlyHeapRef is reported unresolved (counted, never guessed).');
  }
  return new CacheEnvironment(profile, overlay, roHeap, roHeap ? roFile : null);
}

/** Which profile tags are installed, for error messages. */
export function availableProfiles(root = 'profiles') { return listProfiles(root); }

/**
 * Read and decode one `.jsc`.
 *
 * @param {string|Buffer} fileOrBuffer
 * @param {CacheEnvironment} env
 * @param {{
 *   requireVersionMatch?: boolean,
 *   expectFlagHash?: number,
 *   expectExternalReferenceTableSize?: number,
 *   verifyPayloadChecksum?: boolean,
 *   maxObjects?: number,
 * }} opts
 */
export function readCache(fileOrBuffer, env, opts = {}) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const name = Buffer.isBuffer(fileOrBuffer) ? '<buffer>' : fileOrBuffer;
  const header = parseHeader(buf, env.profile, env.overlay);
  const verification = verifyHeader(header, env.profile, env.overlay, env.roHeap, {
    flagHash: opts.expectFlagHash,
    externalReferenceTableSize: opts.expectExternalReferenceTableSize,
  });

  if (verification.errors.length && opts.requireVersionMatch !== false) {
    const e = new CacheVersionError(
      `${name} was not produced by the V8 this profile describes:\n  ` + verification.errors.join('\n  '));
    e.header = header;
    e.verification = verification;
    throw e;
  }

  const payload = buf.subarray(header.headerSize, header.headerSize + header.payloadLength);
  const checksum = opts.verifyPayloadChecksum === false
    ? null
    : verifyPayloadChecksum(header, payload, env.overlay);
  if (checksum && checksum.present && checksum.ok === false) {
    verification.errors.push(
      `payload checksum mismatch: header says 0x${checksum.expected.toString(16)}, `
      + `recomputed 0x${checksum.actual.toString(16)}`);
  }

  // ARCHITECTURE.md 9.7: two builds of the same V8 version are not
  // interchangeable. With the sandbox off, a TrustedPointer field is a full
  // tagged word instead of a 4-byte handle and the serializer never emits
  // kIndirectPointerPrefix / kInitializeSelfIndirectPointer, so a cache from
  // the other configuration misdecodes somewhere deep in the object graph. The
  // header states the version but not the build, so the switches are stated
  // here up front, and if the deserialiser then fails they are named in the
  // error instead of leaving a tag number as the only clue.
  const build = env.profile.meta?.build ?? null;
  let graph;
  try {
    graph = deserializePayload(payload, env.profile, { maxObjects: opts.maxObjects });
  } catch (e) {
    const where = build
      ? `the profile describes a ${build.sandbox ? 'sandboxed' : 'non-sandboxed'}, `
        + `${build.pointerCompression ? 'pointer-compressed' : 'uncompressed'} build `
        + `(kTaggedSize=${build.taggedSize}, kTrustedPointerSize=${build.trustedPointerSize})`
      : 'the profile does not record its build configuration (regenerate it with profilegen >= 1.1.0)';
    e.message = `${name}: ${e.message}\n  ${where}.\n`
      + '  If the cache was produced by a build with different sandbox / pointer-compression '
      + 'settings, decoding cannot work: generate a profile for that configuration with '
      + '`node tools/profilegen/index.mjs --tag <v> --tagged-size <4|8>`.';
    e.build = build;
    e.header = header;
    throw e;
  }

  return { name, buffer: buf, header, verification, checksum, payload, graph, build };
}

export default {
  loadEnvironment, readCache, availableProfiles,
  parseHeader, verifyHeader, verifyPayloadChecksum, formatHeader,
  deserializePayload, Deserializer, RefKind,
  CacheFormatError, CacheVersionError, UnimplementedTagError,
  versionHashFromString, loadOverlay,
};
