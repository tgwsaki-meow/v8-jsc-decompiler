// src/profile/index.mjs
//
// Load, validate and query a generated profile directory.
//
// Contract: this file contains no version-specific value. Every number it
// returns comes out of profiles/<tag>/*.json, which tools/profilegen derives
// from pinned V8 sources. The only literals here are JSON key names, structural
// expectations (a profile has eight tables) and the arithmetic of the decoding
// rules the profile itself states:
//
//   operand size   size(type, scale) = scalable ? baseSize * scale : baseSize
//                  -- operands.json: sizeRule
//   read-only ref  Tagged_t = (chunkIndex << pageSizeBits) + chunkOffset + kHeapObjectTag
//                  -- constants.json: readOnlyPage.addressFormula
//
// Both shifts and tags are read from the profile, never assumed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILES = {
  meta: 'meta.json',
  bytecodes: 'bytecodes.json',
  operands: 'operands.json',
  serializerTags: 'serializer-tags.json',
  roots: 'roots.json',
  staticRoots: 'static-roots.json',
  layouts: 'layouts.json',
  runtime: 'runtime.json',
  intrinsics: 'intrinsics.json',
  constants: 'constants.json',
};

/** Structural schema: required key paths and their expected JS types. */
const SCHEMA = {
  meta: [
    ['generator.name', 'string'], ['generator.version', 'string'],
    ['generatedAt', 'string'], ['v8Version', 'string'], ['variant', 'string'],
    ['taggedSize', 'number'], ['sources', 'array'], ['counts', 'object'],
    ['acceptance', 'object'], ['unresolved', 'object'],
  ],
  bytecodes: [['totalOpcodes', 'number'], ['byValue', 'object'], ['byName', 'object'], ['prefixes', 'object']],
  operands: [['operandTypes', 'object'], ['operandScales', 'object'], ['operandTypeOrder', 'array']],
  serializerTags: [['tags', 'object'], ['rangedTags', 'object'], ['kNumberOfSnapshotSpaces', 'number']],
  roots: [['byIndex', 'object'], ['readOnlyCount', 'number'], ['totalCount', 'number']],
  staticRoots: [['byCompressedAddress', 'object'], ['orderedTable', 'array'], ['entriesCount', 'number']],
  layouts: [['classes', 'object'], ['bitfields', 'object'], ['sizes', 'object'], ['taggedSize', 'number']],
  runtime: [['byId', 'object'], ['byName', 'object'], ['count', 'number']],
  intrinsics: [['byId', 'object'], ['byName', 'object'], ['count', 'number']],
  constants: [['sizes', 'object'], ['tagging', 'object'], ['readOnlyPage', 'object'],
    ['handlerTable', 'object'], ['sourcePositionTable', 'object'], ['codeCacheHeader', 'object']],
};

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function dig(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export class ProfileError extends Error {}

export class Profile {
  constructor(dir, tables) {
    this.dir = dir;
    this.tables = tables;
    this.meta = tables.meta;
    this.version = tables.meta.v8Version;
    this.variant = tables.meta.variant;
    this.taggedSize = tables.meta.taggedSize;
    this.constants = tables.constants;
    this.validation = { errors: [], warnings: [], sourceHashes: null };
  }

  // ---------------------------------------------------------------- opcodes

  /** Opcode by byte value or by name. */
  getOpcode(key) {
    const b = this.tables.bytecodes;
    if (typeof key === 'number') return b.byValue[String(key)] ?? null;
    const v = b.byName[key];
    return v === undefined ? null : b.byValue[String(v)];
  }

  get opcodeCount() { return this.tables.bytecodes.totalOpcodes; }
  get illegalOpcode() { return this.tables.bytecodes.illegalValue; }
  get shortStarRange() { return this.tables.bytecodes.shortStarRange; }

  /** `Wide` / `ExtraWide` -> the operand scale they select. */
  prefixScale(opcodeNameOrValue) {
    const op = this.getOpcode(opcodeNameOrValue);
    if (!op) return null;
    const p = this.tables.bytecodes.prefixes[op.name];
    return p ? p.scale : null;
  }

  // --------------------------------------------------------------- operands

  /** Bytes occupied by an operand of `type` at `scale` (1, 2 or 4). */
  operandSize(type, scale = 1) {
    const t = this.tables.operands.operandTypes[type];
    if (!t) throw new ProfileError(`${this.version}: unknown operand type ${type}`);
    return t.scalable ? t.baseSize * scale : t.baseSize;
  }

  operandType(type) {
    const t = this.tables.operands.operandTypes[type];
    if (!t) throw new ProfileError(`${this.version}: unknown operand type ${type}`);
    return t;
  }

  isRegisterOperand(type) {
    return this.tables.operands.registerOperandTypes.includes(type);
  }

  /** Total encoded length of one instruction at a given scale, prefix excluded. */
  instructionLength(opcodeNameOrValue, scale = 1) {
    const op = this.getOpcode(opcodeNameOrValue);
    if (!op) throw new ProfileError(`${this.version}: unknown opcode ${opcodeNameOrValue}`);
    let n = 1;
    for (const o of op.operands) n += this.operandSize(o, scale);
    return n;
  }

  // ------------------------------------------------------- serializer tags

  serializerTag(name) {
    const v = this.tables.serializerTags.tags[name];
    if (v === undefined) throw new ProfileError(`${this.version}: unknown serializer tag ${name}`);
    return v;
  }

  /** Decode a ranged serializer tag byte: value = byte - base + minValue. */
  decodeRangedTag(byte) {
    for (const [name, r] of Object.entries(this.tables.serializerTags.rangedTags)) {
      if (byte >= r.base && byte <= r.end) return { tag: name, value: byte - r.base + r.minValue };
    }
    return null;
  }

  // ------------------------------------------------------------------ roots

  /** Root by serialized index, or by C++ name. */
  getRoot(key) {
    const r = this.tables.roots;
    if (typeof key === 'number') return r.byIndex[String(key)] ?? null;
    for (const e of Object.values(r.byIndex)) if (e.cppName === key || e.camelName === key) return e;
    return null;
  }

  get rootCount() { return this.tables.roots.totalCount; }
  get readOnlyRootCount() { return this.tables.roots.readOnlyCount; }

  /** Resolve a compressed read-only address (Tagged_t) to its root. */
  resolveStaticRoot(taggedT) {
    return this.tables.staticRoots.byCompressedAddress[String(taggedT)] ?? null;
  }

  /**
   * (chunkIndex, chunkOffset) -> Tagged_t, using the shift and tag the profile
   * reports rather than a hardcoded page size.
   */
  roRefAddress(chunkIndex, chunkOffset) {
    const bits = this.constants.readOnlyPage.pageSizeBits;
    const tag = this.constants.tagging.kHeapObjectTag;
    if (bits === null || bits === undefined || tag === null || tag === undefined) {
      throw new ProfileError(`${this.version}: profile does not carry readOnlyPage.pageSizeBits / tagging.kHeapObjectTag`);
    }
    return (chunkIndex << bits) + chunkOffset + tag;
  }

  /** Resolve a read-only reference given as (chunkIndex, chunkOffset). */
  resolveRoRef(chunkIndex, chunkOffset) {
    const addr = this.roRefAddress(chunkIndex, chunkOffset);
    const hit = this.resolveStaticRoot(addr);
    return hit ? { address: addr, ...hit } : { address: addr, unresolved: true };
  }

  // ---------------------------------------------------------------- layouts

  /** The layout program for a class. */
  layoutOf(className) {
    const c = this.tables.layouts.classes[className];
    if (!c) throw new ProfileError(`${this.version}: no layout for ${className}`);
    return c;
  }

  /** Absolute offset of a fixed field, or null when it is data-dependent. */
  fieldOffset(className, fieldName) {
    const c = this.layoutOf(className);
    const f = (c.fields ?? []).find((x) => x.name === fieldName);
    if (!f) throw new ProfileError(`${this.version}: ${className} has no field ${fieldName}`);
    return f.offset;
  }

  /** A bitfield struct: LSB-first fields with offset, width and mask. */
  bitfieldOf(name) {
    const b = this.tables.layouts.bitfields[name];
    if (!b) throw new ProfileError(`${this.version}: no bitfield struct ${name}`);
    return b;
  }

  /** Extract one bitfield member from a raw integer. */
  readBitfield(structName, fieldName, raw) {
    const b = this.bitfieldOf(structName);
    const f = b.fields.find((x) => x.name === fieldName);
    if (!f) throw new ProfileError(`${this.version}: ${structName} has no field ${fieldName}`);
    const mask = f.width >= 32 ? (-1 >>> 0) : (1 << f.width) - 1;
    return (raw >>> f.offset) & mask;
  }

  /** A Torque enum (name -> ordinal). */
  enumOf(name) {
    const e = this.tables.layouts.enums[name];
    if (!e) throw new ProfileError(`${this.version}: no enum ${name}`);
    return e.members;
  }

  // ------------------------------------------------------- runtime/intrinsics

  /** CallRuntime's operand is a runtime function id; this names it. */
  runtimeName(id) {
    const e = this.tables.runtime.byId[String(id)];
    return e ? e.name : null;
  }

  runtimeFunction(id) { return this.tables.runtime.byId[String(id)] ?? null; }
  runtimeId(name) { const v = this.tables.runtime.byName[name]; return v === undefined ? null : v; }

  /** InvokeIntrinsic's operand is an intrinsic id; this names it. */
  intrinsicName(id) {
    const e = this.tables.intrinsics.byId[String(id)];
    return e ? e.name : null;
  }

  intrinsic(id) { return this.tables.intrinsics.byId[String(id)] ?? null; }

  // ---------------------------------------------------------------- reporting

  /** Everything the generator could not derive, for the caller to surface. */
  get unresolved() { return this.meta.unresolved ?? {}; }

  /** The generator's own acceptance results. */
  get acceptance() { return this.meta.acceptance ?? {}; }

  summary() {
    const c = this.meta.counts ?? {};
    return [
      `profile ${this.version} (${this.variant}, kTaggedSize=${this.taggedSize})`,
      `  opcodes ${c.opcodes}  operandTypes ${c.operandTypes}  serializerTags ${c.serializerTags}`,
      `  roots ${c.roots} (${c.readOnlyRoots} read-only, static table ${c.staticRoots})`,
      `  layouts ${c.layoutClasses}  bitfields ${c.bitfieldStructs}`,
      `  runtime ${c.runtimeFunctions}  intrinsics ${c.intrinsics}`,
      `  root order agreement ${this.acceptance.roots?.agreement ?? 'n/a'}`,
      `  unresolved keys: ${Object.keys(this.unresolved).join(', ') || '(none)'}`,
    ].join('\n');
  }
}

/** Structural validation. Returns a list of error strings. */
export function validateProfile(profile) {
  const errors = [];
  for (const [table, rules] of Object.entries(SCHEMA)) {
    const obj = profile.tables[table];
    if (!obj) { errors.push(`missing table ${table} (${FILES[table]})`); continue; }
    for (const [key, want] of rules) {
      const got = dig(obj, key);
      if (got === undefined) { errors.push(`${FILES[table]}: missing ${key}`); continue; }
      if (typeOf(got) !== want) errors.push(`${FILES[table]}: ${key} is ${typeOf(got)}, expected ${want}`);
    }
  }
  if (!errors.length) {
    // cross-table consistency
    const b = profile.tables.bytecodes;
    if (Object.keys(b.byValue).length !== b.totalOpcodes) {
      errors.push(`bytecodes.json: byValue has ${Object.keys(b.byValue).length} entries but totalOpcodes is ${b.totalOpcodes}`);
    }
    for (const op of Object.values(b.byValue)) {
      for (const o of op.operands) {
        if (!profile.tables.operands.operandTypes[o]) {
          errors.push(`operands.json: ${op.name} uses operand type ${o}, which is not in operandTypes`);
        }
      }
    }
    const r = profile.tables.roots;
    if (Object.keys(r.byIndex).length !== r.totalCount) {
      errors.push(`roots.json: byIndex has ${Object.keys(r.byIndex).length} entries but totalCount is ${r.totalCount}`);
    }
    if (profile.tables.staticRoots.entriesCount !== r.readOnlyCount) {
      errors.push(`static-roots.json: ${profile.tables.staticRoots.entriesCount} entries vs roots.json readOnlyCount ${r.readOnlyCount}`);
    }
    if (profile.tables.layouts.taggedSize !== profile.meta.taggedSize) {
      errors.push(`layouts.json: taggedSize ${profile.tables.layouts.taggedSize} != meta taggedSize ${profile.meta.taggedSize}`);
    }
  }
  return errors;
}

/**
 * Verify meta.json's sha256 list against a source cache, when one is present.
 * Returns {checked, ok, mismatches, missing} -- a missing cache is not an error.
 */
export function verifySources(profile, cacheRoot = '.v8src-cache') {
  const dir = path.join(cacheRoot, profile.version.replace(/[\\/:]/g, '_'));
  if (!fs.existsSync(dir)) return { cachePresent: false, checked: 0, ok: 0, mismatches: [], missing: [] };
  const mismatches = [];
  const missing = [];
  let ok = 0;
  for (const s of profile.meta.sources ?? []) {
    const local = path.join(dir, ...s.path.split('/'));
    if (!fs.existsSync(local)) { missing.push(s.path); continue; }
    const text = fs.readFileSync(local, 'utf8');
    const got = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (got === s.sha256) ok++;
    else mismatches.push({ path: s.path, expected: s.sha256, got });
  }
  return { cachePresent: true, checked: (profile.meta.sources ?? []).length, ok, mismatches, missing };
}

/**
 * Load a profile directory.
 *
 * @param {string} dir  e.g. 'profiles/14.4.258.16'
 * @param {{validate?: boolean, verifySources?: boolean, cacheRoot?: string, strict?: boolean}} opts
 */
export function loadProfile(dir, opts = {}) {
  const { validate = true, verifySources: doVerify = true, cacheRoot = '.v8src-cache', strict = true } = opts;
  if (!fs.existsSync(dir)) throw new ProfileError(`profile directory not found: ${dir}`);
  const tables = {};
  for (const [key, file] of Object.entries(FILES)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      if (strict) throw new ProfileError(`profile ${dir} is missing ${file}`);
      continue;
    }
    try { tables[key] = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { throw new ProfileError(`profile ${dir}: ${file} is not valid JSON: ${e.message}`); }
  }
  if (!tables.meta) throw new ProfileError(`profile ${dir} has no meta.json`);

  const profile = new Profile(dir, tables);
  if (validate) {
    profile.validation.errors = validateProfile(profile);
    if (strict && profile.validation.errors.length) {
      throw new ProfileError(`profile ${dir} failed validation:\n  ${profile.validation.errors.join('\n  ')}`);
    }
  }
  if (doVerify) {
    profile.validation.sourceHashes = verifySources(profile, cacheRoot);
    if (profile.validation.sourceHashes.mismatches.length) {
      const m = profile.validation.sourceHashes.mismatches;
      profile.validation.warnings.push(`${m.length} cached source file(s) do not match meta.json sha256 (first: ${m[0].path})`);
      if (strict) {
        throw new ProfileError(`profile ${dir}: cached sources disagree with meta.json sha256:\n  ${m.map((x) => x.path).join('\n  ')}`);
      }
    }
  }
  return profile;
}

/** List the profiles available under a root. */
export function listProfiles(root = 'profiles') {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'meta.json')))
    .map((e) => e.name)
    .sort();
}

/** Load the profile whose versionHash / v8Version matches, by tag. */
export function loadProfileForVersion(tag, opts = {}) {
  const root = opts.root ?? 'profiles';
  const dir = path.join(root, tag);
  if (!fs.existsSync(dir)) {
    const have = listProfiles(root);
    throw new ProfileError(
      `no profile for V8 ${tag}. Available: ${have.join(', ') || '(none)'}. `
      + `Generate one with: node tools/profilegen/index.mjs --tag ${tag} --variant intl+wasm --tagged-size 4 --out ${root}/`);
  }
  return loadProfile(dir, opts);
}

export default { loadProfile, loadProfileForVersion, listProfiles, validateProfile, verifySources, Profile, ProfileError };
