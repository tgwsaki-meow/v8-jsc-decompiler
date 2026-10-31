// src/cache/header.mjs
//
// The `.jsc` code-cache header: `SerializedCodeData` on top of `SerializedData`
// (src/snapshot/code-serializer.h, src/snapshot/snapshot-data.h).
//
// Every field offset comes from the profile's constants.codeCacheHeader; the
// magic base and the SourceHash bit widths come from the overlay. There is no
// offset, width or magic number written in this file.
//
// Field meanings, and what each one can be checked against:
//
//   magic      0xC0DE0000 ^ ExternalReferenceTable::kSize. kSize is a property
//              of the *build*, not of the V8 version, so the magic cannot be
//              predicted from a profile. It is decoded to recover kSize, which
//              is then comparable across artifacts of the same build -- the
//              check that tied the corpus to Electron's snapshot blob
//              (both 1652).
//   versionHash  Version::Hash(). A pure function of the four version numbers,
//              so it IS predictable from the profile -> hard pre-check.
//   sourceHash   source character count | hasWrappedArguments<<29 | isModule<<30.
//              Not a hash despite the name. Gives the original source length.
//   flagHash     FlagList::Hash() over the *runtime* flag values. Nothing in a
//              profile can predict it; it is reported, and compared against a
//              caller-supplied expectation when one is given.
//   readOnlySnapshotChecksum  adler32(seed 0) of the producing isolate's
//              read-only snapshot section. Compared against the provenance of
//              the read-only table actually in use.
//   payloadLength  bytes after the header.
//   checksum     adler32(seed 0) of the payload, but only when the producer ran
//              with --verify-snapshot-checksum; otherwise 0.

import { CacheFormatError, CacheVersionError } from './source.mjs';
import { versionHashFromString } from './version-hash.mjs';

/**
 * adler32, with the seed V8 passes (0, not the conventional 1).
 *
 * VERSION-FREE: 65521 is adler32's modulus (the largest prime below 2^16) and
 * 5552 is the longest run of bytes for which the accumulators cannot overflow
 * 32 bits. Both are properties of adler32, which the profile names as the
 * algorithm; neither depends on any V8 version. 0xffff masks a 16-bit half.
 */
export function adler32(buf, seed = 0) {
  const MOD = 65521;                                 // VERSION-FREE: adler32 modulus
  let a = seed & 0xffff;                             // VERSION-FREE: 16-bit half
  let b = (seed >>> 16) & 0xffff;                    // VERSION-FREE: 16-bit half
  for (let i = 0; i < buf.length;) {
    const end = Math.min(i + 5552, buf.length);      // VERSION-FREE: adler32 overflow-free block
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function bitField(raw, spec) {
  // VERSION-FREE: 0xffffffff is an all-ones 32-bit mask for a full-width field.
  const mask = spec.width >= 32 ? 0xffffffff : ((1 << spec.width) - 1) >>> 0;
  return (raw >>> spec.offset) & mask;
}

/**
 * Decode the header of a `.jsc` buffer.
 *
 * @param {Buffer} buf
 * @param {import('../profile/index.mjs').Profile} profile
 * @param {import('./overlay.mjs').Overlay} overlay
 */
export function parseHeader(buf, profile, overlay) {
  const h = profile.constants.codeCacheHeader;
  if (!h) throw new CacheFormatError('profile constants.json has no codeCacheHeader');
  if (buf.length < h.kHeaderSize) {
    throw new CacheFormatError(
      `file is ${buf.length} bytes, shorter than the ${h.kHeaderSize}-byte code-cache header this profile describes`);
  }

  const u32 = (off) => buf.readUInt32LE(off);
  const magic = u32(h.kMagicNumberOffset);
  const versionHash = u32(h.kVersionHashOffset);
  const sourceHashRaw = u32(h.kSourceHashOffset);
  const flagHash = u32(h.kFlagHashOffset);
  const readOnlySnapshotChecksum = u32(h.kReadOnlySnapshotChecksumOffset);
  const payloadLength = u32(h.kPayloadLengthOffset);
  const checksum = u32(h.kChecksumOffset);

  const sh = overlay.codeCache.sourceHash;
  const sourceHash = {
    raw: sourceHashRaw,
    sourceLength: bitField(sourceHashRaw, sh.length),
    hasWrappedArguments: bitField(sourceHashRaw, sh.hasWrappedArguments) === 1,
    isModule: bitField(sourceHashRaw, sh.isModule) === 1,
  };
  // Any bit above the three documented fields would mean the layout changed.
  const knownBits = (sh.length.width + sh.hasWrappedArguments.width + sh.isModule.width);
  const spare = knownBits >= 32 ? 0 : (sourceHashRaw >>> knownBits);
  sourceHash.unknownHighBits = spare >>> 0;

  const externalReferenceTableSize = (magic ^ overlay.codeCache.magicBase) >>> 0;

  return {
    headerSize: h.kHeaderSize,
    magic,
    externalReferenceTableSize,
    versionHash,
    sourceHash,
    flagHash,
    readOnlySnapshotChecksum,
    payloadLength,
    checksum,
    fileLength: buf.length,
    payloadLengthFromFile: buf.length - h.kHeaderSize,
  };
}

/**
 * Pre-flight the header against the profile.
 *
 * Returns `{errors, warnings, checks}`. `errors` being non-empty means the
 * cache was produced by a build this profile does not describe and decoding it
 * would silently produce wrong answers.
 *
 * @param {object} header            from parseHeader
 * @param {object} profile
 * @param {object} overlay
 * @param {object} roHeap            the read-only table in use, for provenance
 * @param {{flagHash?: number, externalReferenceTableSize?: number}} expect
 */
export function verifyHeader(header, profile, overlay, roHeap, expect = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];

  // ---- versionHash: fully predictable from the profile's version string.
  const want = versionHashFromString(profile.version);
  const ok = want === header.versionHash;
  checks.push({
    name: 'versionHash',
    ok,
    expected: want,
    actual: header.versionHash,
    basis: `Version::Hash() recomputed from profile v8Version ${profile.version}`,
  });
  if (!ok) {
    errors.push(
      `versionHash mismatch: this cache stores 0x${header.versionHash.toString(16)}, `
      + `but V8 ${profile.version} (the profile loaded from ${profile.dir}) hashes to 0x${want.toString(16)}.\n`
      + '  This cache was produced by a different V8. Identify it and generate a matching profile:\n'
      + '    node tools/profilegen/index.mjs --tag <X.Y.Z.W> --variant intl+wasm '
      + `--tagged-size ${profile.taggedSize} --out profiles/\n`
      + '  That one profile is all this layer needs; an independent cross-check of its build '
      + 'facts is available as `node tools/layoutpatch/index.mjs --tag <X.Y.Z.W>`.');
  }

  // ---- payload length must agree with the file size.
  const lenOk = header.payloadLength === header.payloadLengthFromFile;
  checks.push({
    name: 'payloadLength',
    ok: lenOk,
    expected: header.payloadLengthFromFile,
    actual: header.payloadLength,
    basis: 'file size minus header size',
  });
  if (!lenOk) {
    errors.push(`payloadLength is ${header.payloadLength} but the file holds ${header.payloadLengthFromFile} bytes after the header`);
  }

  // ---- sourceHash: nothing to compare against, but spare bits must be zero.
  checks.push({
    name: 'sourceHash.unknownHighBits',
    ok: header.sourceHash.unknownHighBits === 0,
    expected: 0,
    actual: header.sourceHash.unknownHighBits,
    basis: 'bits above SourceHash\'s three documented fields (src/snapshot/code-serializer.cc)',
  });
  if (header.sourceHash.unknownHighBits !== 0) {
    warnings.push(
      `sourceHash has bits set above the three fields this V8 declares (0x${header.sourceHash.unknownHighBits.toString(16)} `
      + 'above the length/hasWrappedArguments/isModule fields); the field layout may have changed');
  }

  // ---- flagHash: no profile-derivable truth. Report; compare if asked.
  if (expect.flagHash !== undefined) {
    const fOk = (expect.flagHash >>> 0) === header.flagHash;
    checks.push({ name: 'flagHash', ok: fOk, expected: expect.flagHash >>> 0, actual: header.flagHash, basis: 'caller-supplied expectation' });
    if (!fOk) {
      errors.push(
        `flagHash mismatch: cache stores 0x${header.flagHash.toString(16)}, caller expected `
        + `0x${(expect.flagHash >>> 0).toString(16)}. FlagList::Hash() covers the producer's runtime flags, `
        + 'so a mismatch means the cache was produced under different V8 flags.');
    }
  } else {
    checks.push({
      name: 'flagHash',
      ok: null,
      actual: header.flagHash,
      basis: 'FlagList::Hash() over the producer\'s runtime flag values; not derivable from any profile',
    });
  }

  const prov = roHeap?.provenance ?? null;
  const tableChecksum = prov?.snapshotHeader?.readOnlySnapshotChecksum ?? null;
  const tableRefTableSize = prov?.snapshotHeader?.externalReferenceTableSize ?? null;

  // ---- externalReferenceTableSize: build identity, comparable across artifacts.
  const wantRefTable = expect.externalReferenceTableSize ?? tableRefTableSize;
  if (wantRefTable != null) {
    const eOk = wantRefTable === header.externalReferenceTableSize;
    const fromCaller = expect.externalReferenceTableSize !== undefined;
    checks.push({
      name: 'externalReferenceTableSize',
      ok: eOk,
      expected: wantRefTable,
      actual: header.externalReferenceTableSize,
      basis: fromCaller
        ? 'magic ^ codeCache.magicBase vs caller-supplied expectation'
        : 'magic ^ codeCache.magicBase vs the blob the read-only table was built from',
    });
    if (!eOk) {
      const msg = `ExternalReferenceTable::kSize is ${header.externalReferenceTableSize} in this cache but `
        + `${wantRefTable} in ${fromCaller ? 'the caller-supplied expectation' : 'the blob behind the read-only table'}: `
        + 'a different build configuration, not just a different V8 version. Read-only references resolved against '
        + 'that table would land on the wrong objects.';
      if (fromCaller) errors.push(msg); else warnings.push(msg);
    }
  } else {
    checks.push({
      name: 'externalReferenceTableSize',
      ok: null,
      actual: header.externalReferenceTableSize,
      basis: 'magic ^ codeCache.magicBase; a build-config identity, not predictable from V8 sources',
    });
  }

  // ---- readOnlySnapshotChecksum against the provenance of the RO table used.
  if (tableChecksum != null) {
    const rOk = (tableChecksum >>> 0) === header.readOnlySnapshotChecksum;
    checks.push({
      name: 'readOnlySnapshotChecksum',
      ok: rOk,
      expected: tableChecksum >>> 0,
      actual: header.readOnlySnapshotChecksum,
      basis: `stored checksum of the blob the read-only table was built from (${prov?.blob?.path ?? 'unknown blob'})`,
    });
    if (!rOk) {
      warnings.push(
        `readOnlySnapshotChecksum mismatch: cache stores 0x${header.readOnlySnapshotChecksum.toString(16)}, `
        + `the read-only table in use came from a blob storing 0x${(tableChecksum >>> 0).toString(16)}. `
        + 'Read-only references are resolved by (page, offset) against that table, so this is a layout-matches '
        + 'but not bit-identical situation. See profiles/<tag>/RO-HEAP-PROVENANCE.md. '
        + 'Every resolved value is still reported, and unresolved ones are counted rather than guessed.');
    }
  } else {
    checks.push({
      name: 'readOnlySnapshotChecksum',
      ok: null,
      actual: header.readOnlySnapshotChecksum,
      basis: 'the read-only table carries no stored checksum to compare against',
    });
  }

  return { errors, warnings, checks };
}

/**
 * Verify the payload checksum when the producer wrote one.
 * V8 writes 0 unless --verify-snapshot-checksum was on, so 0 means "not
 * written" rather than "zero checksum".
 */
export function verifyPayloadChecksum(header, payload, overlay) {
  const spec = overlay.codeCache.checksum;
  if (header.checksum === 0) {
    return { present: false, ok: null, note: spec.onlyWrittenWhen };
  }
  if (spec.algorithm !== 'adler32') {
    return { present: true, ok: null, note: `profile build uses ${spec.algorithm}, which this reader does not compute` };
  }
  const got = adler32(payload, spec.seed);
  return { present: true, ok: got === header.checksum, expected: header.checksum, actual: got, note: spec.note };
}

export function formatHeader(header) {
  const hx = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  const s = header.sourceHash;
  return [
    `magic                      ${hx(header.magic)}  (ExternalReferenceTable::kSize = ${header.externalReferenceTableSize})`,
    `versionHash                ${hx(header.versionHash)}`,
    `sourceHash                 ${hx(s.raw)}  sourceLength=${s.sourceLength} chars, hasWrappedArguments=${s.hasWrappedArguments}, isModule=${s.isModule}`,
    `flagHash                   ${hx(header.flagHash)}`,
    `readOnlySnapshotChecksum   ${hx(header.readOnlySnapshotChecksum)}`,
    `payloadLength              ${header.payloadLength}  (file ${header.fileLength} - header ${header.headerSize} = ${header.payloadLengthFromFile})`,
    `checksum                   ${hx(header.checksum)}${header.checksum === 0 ? '  (not written: producer ran without --verify-snapshot-checksum)' : ''}`,
  ].join('\n');
}

export default { parseHeader, verifyHeader, verifyPayloadChecksum, formatHeader, adler32 };
