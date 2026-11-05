// tests/t4/selftest.mjs
//
//   node tests/t4/selftest.mjs [--profile 14.4.258.16] [--second 14.6.202.34]
//
// Checks that do not need V8 to run: the no-version-literal rule, the header
// hash reimplementation, the encodings, and the tag-coverage contract.
//
// The acceptance oracle (tests/t4/acceptance.mjs) answers "is the decode
// right?". This answers "is the decoder still version-pluggable, and does it
// still refuse rather than guess?".

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { loadOverlay } from '../../src/cache/overlay.mjs';
import { SnapshotByteSource, CacheFormatError, UnimplementedTagError } from '../../src/cache/source.mjs';
import { versionHashFromString } from '../../src/cache/version-hash.mjs';
import { adler32, parseHeader, verifyHeader } from '../../src/cache/header.mjs';
import { Deserializer } from '../../src/cache/deserialize.mjs';
import { loadEnvironment, readCache } from '../../src/cache/index.mjs';
import { LayoutResolver } from '../../src/heap/layout.mjs';
import { HandlerTableDecoder } from '../../src/heap/handlertable.mjs';
import { SourcePositionTableDecoder } from '../../src/heap/sourceposition.mjs';
import { buildUnits, contextSlotNamingStats } from '../../src/heap/index.mjs';

const results = [];
function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, detail: `threw: ${(e.message ?? String(e)).split('\n')[0]}` }; }
  results.push({ group, name, ok: r.ok, detail: r.detail });
}

function parseArgs(argv) {
  const o = { profile: '14.4.258.16', second: '14.6.202.34', corpusFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') o.profile = argv[++i];
    else if (argv[i] === '--second') o.second = argv[++i];
    else if (argv[i] === '--corpus-file') o.corpusFile = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return o;
}

const o = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- (a) literals

/**
 * The version-pluggability rule, applied the way tools/profilegen/selftest.mjs
 * applies it to src/profile/: after comments are stripped, no hexadecimal
 * literal and no 3-or-more-digit decimal literal may appear in src/cache/ or
 * src/heap/, because any such number would be a fact about one V8 build that
 * belongs in a profile.
 *
 * One file is exempt, by name, with its justification checked below:
 *
 *   src/cache/version-hash.mjs  the mixing constants of Thomas Wang's integer
 *       hash and MurmurHash64A, reproduced from src/base/hashing.h. They are
 *       not version data, and check (b) proves it by requiring the same code to
 *       reproduce the versionHash of two different V8 releases.
 */
const LITERAL_ALLOWLIST = new Set(['src/cache/version-hash.mjs']);

/** The marker a line must carry to keep a numeric literal. */
const JUSTIFIED = 'VERSION-FREE:';

/**
 * The files T4 owns. `src/cli/` is shared with the other waves, so only this
 * task's entry point is listed rather than the whole directory.
 */
function sourceFiles() {
  const out = [];
  for (const dir of ['src/cache', 'src/heap']) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.mjs')) out.push(`${dir}/${f}`);
  }
  if (fs.existsSync('src/cli/dump-cache.mjs')) out.push('src/cli/dump-cache.mjs');
  return out.sort();
}

/**
 * Read a source file for analysis, with line endings normalised to LF.
 *
 * Not cosmetic. JavaScript's `.` does not match `\r`, so on a CRLF checkout
 * `line.replace(/\/\/.*$/, '')` fails to match at all -- `.*` stops before the
 * `\r` and then `$` cannot be satisfied -- and the line comment is NOT
 * stripped. Every numeric literal inside a header comment then gets flagged as
 * unjustified. Measured: this check passed on ubuntu-latest and failed on
 * windows-latest in the same CI run, reporting 7 literals in
 * `src/cache/deserialize.mjs`, `header.mjs`, `handlertable.mjs` and
 * `roref.mjs` that are all inside comments.
 *
 * `.gitattributes` now normalises the working tree as well, which stops this
 * happening to the next reader; this function is the half that does not depend
 * on a checkout being configured correctly.
 */
function readSource(rel) {
  return fs.readFileSync(rel, 'utf8').replace(/\r\n?/g, '\n');
}

/** Lines with code, block comments removed, line comments kept for the marker. */
function codeLines(rel) {
  return readSource(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n');
}

function flaggedLiterals(line) {
  const code = line.replace(/\/\/.*$/, '');
  return [
    ...[...code.matchAll(/0x[0-9a-fA-F]+n?/g)].map((m) => m[0]),
    ...[...code.matchAll(/(?<![\w.$])\d{3,}n?(?![\w.$])/g)].map((m) => m[0]),
  ];
}

check('literals', 'every numeric literal in src/cache, src/heap, src/cli is justified', () => {
  const offenders = [];
  let scanned = 0;
  let justified = 0;
  for (const rel of sourceFiles()) {
    if (LITERAL_ALLOWLIST.has(rel)) continue;
    scanned++;
    const lines = codeLines(rel);
    lines.forEach((line, i) => {
      const found = flaggedLiterals(line);
      if (!found.length) return;
      // The justification may be on the line itself or in the comment block
      // immediately above it.
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (near.includes(JUSTIFIED)) { justified += found.length; return; }
      offenders.push(`${rel}:${i + 1} ${found.join(',')}`);
    });
  }
  return {
    ok: offenders.length === 0,
    detail: offenders.length
      ? offenders.join(' | ')
      : `${scanned} file(s) scanned, ${justified} literal(s) carry a ${JUSTIFIED} justification; `
        + `allowlisted: ${[...LITERAL_ALLOWLIST].join(', ')}`,
  };
});

check('literals', 'the allowlisted file contains nothing but hash mixing constants', () => {
  const rel = 'src/cache/version-hash.mjs';
  const nums = codeLines(rel).flatMap(flaggedLiterals);
  // MurmurHash64A's multiplier, Thomas Wang's 32-bit multiplier, and 32-bit masks.
  const expected = new Set(['0xc6a4a7935bd1e995n', '2057n', '0xffffffffn', '0xffffffff']);
  const unexpected = nums.filter((n) => !expected.has(n));
  return {
    ok: unexpected.length === 0,
    detail: unexpected.length ? `unexpected constants: ${unexpected.join(',')}` : `constants: ${[...new Set(nums)].join(', ')}`,
  };
});

check('literals', 'no file reaches into profiles/ or layouts-overlay/ by name', () => {
  const bad = [];
  for (const rel of sourceFiles()) {
    const text = readSource(rel);
    // A version tag spelled out in code would defeat the whole arrangement.
    const tags = [...text.matchAll(/(?<![\w.])\d+\.\d+\.\d+\.\d+(?![\w.])/g)].map((m) => m[0]);
    const inComment = (tag) => text.split('\n').filter((l) => l.includes(tag)).every((l) => /^\s*(\/\/|\*|\/\*)/.test(l));
    const real = tags.filter((t) => !inComment(t));
    if (real.length) bad.push(`${rel}: ${real.join(',')}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(' | ') : 'no V8 version tag outside comments' };
});

// ------------------------------------------------------------ (b) header hashes

check('header', 'Version::Hash() reproduces for every installed profile', () => {
  // Values taken from a real .jsc produced by each build, recorded here as the
  // oracle for the reimplementation (not as an input to it).
  const known = {
    '14.4.258.16': 0x12819a30,   // corpus headers, extracted_jsc/*.jsc
    '14.6.202.34': 0x97ffbd52,   // vm.Script#createCachedData() on the local node
  };
  const rows = [];
  let bad = 0;
  for (const tag of listProfiles('profiles')) {
    const got = versionHashFromString(tag);
    const want = known[tag];
    if (want === undefined) { rows.push(`${tag}=0x${got.toString(16)} (no recorded header to compare)`); continue; }
    if (got !== want) { bad++; rows.push(`${tag}: got 0x${got.toString(16)}, header says 0x${want.toString(16)}`); }
    else rows.push(`${tag}=0x${got.toString(16)} ok`);
  }
  return { ok: bad === 0 && rows.length >= 2, detail: rows.join('; ') };
});

check('header', 'adler32 is correct, and seeded with 0 the way V8 seeds it', () => {
  // The textbook adler32 of "Wikipedia" (seed 1) is 0x11E60398. Seeding with 0
  // instead -- which is what src/snapshot/snapshot-utils.cc does -- lowers the
  // low half by 1 and the high half by the byte count, because the only
  // difference is the initial a = 1 carried through every b accumulation.
  const s = Buffer.from('Wikipedia', 'latin1');
  const seed1 = adler32(s, 1);
  const seed0 = adler32(s, 0);
  const a1 = seed1 & 0xffff;
  const b1 = (seed1 >>> 16) & 0xffff;
  const want0 = ((((b1 - s.length) % 65521) << 16) | ((a1 - 1) % 65521)) >>> 0;
  return {
    ok: seed1 === 0x11e60398 && seed0 === want0,
    detail: `seed1=0x${seed1.toString(16)} (textbook 0x11e60398), seed0=0x${seed0.toString(16)} (derived 0x${want0.toString(16)})`,
  };
});

// ----------------------------------------------------------- (c) byte encodings

check('encoding', 'GetUint30 round-trips every encodable width', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const u32 = profile.constants.sizes.kUInt32Size;
  const encode = (v) => {
    // PutUint30 from src/snapshot/snapshot-source-sink.h
    let x = v * 4;
    let bytes = 1;
    if (x > 0xff) bytes = 2;
    if (x > 0xffff) bytes = 3;
    if (x > 0xffffff) bytes = 4;
    x += bytes - 1;
    const out = [];
    for (let i = 0; i < bytes; i++) out.push((x >>> (8 * i)) & 0xff);
    return Buffer.from(out);
  };
  const values = [0, 1, 2, 3, 62, 63, 64, 255, 256, 16383, 16384, 4194303, 4194304, (1 << 30) - 1];
  const bad = [];
  for (const v of values) {
    const buf = Buffer.concat([encode(v), Buffer.alloc(u32)]);
    const src = new SnapshotByteSource(buf, { uint32Size: u32 });
    const got = src.getUint30();
    if (got !== v) bad.push(`${v} -> ${got}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(', ') : `${values.length} values round-tripped` };
});

check('encoding', 'the source position table round-trips through its own encoder', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const overlay = loadOverlay(profile.version);
  const dec = new SourcePositionTableDecoder(profile, overlay);
  const sp = overlay.data.cppLayouts.SourcePosition;

  // Re-implement the writer from src/codegen/source-position-table.cc.
  const encodeUInt = (out, v) => {
    let x = v;
    for (;;) {
      const more = x > 0x7f;
      out.push((more ? 0x80 : 0) | (x & 0x7f));
      x = Math.floor(x / 128);
      if (!more) break;
    }
  };
  const encodeInt = (out, v) => encodeUInt(out, v < 0 ? (-v) * 2 - 1 : v * 2);
  const rawOf = (scriptOffset) => (scriptOffset + sp.scriptOffsetBias) * 2 ** sp.fields.scriptOffset.offset;

  const entries = [
    { codeOffset: -1, sourcePosition: 12, isStatement: false, isBreakable: true },
    { codeOffset: 0, sourcePosition: 21, isStatement: true, isBreakable: true },
    { codeOffset: 2, sourcePosition: 30, isStatement: false, isBreakable: true },
    { codeOffset: 97, sourcePosition: 21, isStatement: true, isBreakable: false },
    { codeOffset: 70000, sourcePosition: 1000000, isStatement: true, isBreakable: true },
  ];
  const bytes = [];
  let prevCode = dec.functionEntryOffset;
  let prevRaw = 0;
  for (const e of entries) {
    const dCode = e.codeOffset - prevCode;
    encodeUInt(bytes, dCode * 4 + (e.isBreakable ? 2 : 0) + (e.isStatement ? 1 : 0));
    encodeInt(bytes, rawOf(e.sourcePosition) - prevRaw);
    prevCode = e.codeOffset;
    prevRaw = rawOf(e.sourcePosition);
  }
  const got = dec.decode(Buffer.from(bytes));
  const same = got.entries.length === entries.length && entries.every((e, i) => {
    const g = got.entries[i];
    return g.codeOffset === e.codeOffset && g.sourcePosition === e.sourcePosition
      && g.isStatement === e.isStatement && g.isBreakable === e.isBreakable;
  });
  return {
    ok: same && got.warnings.length === 0,
    detail: same ? `${entries.length} entries, including one at kFunctionEntryBytecodeOffset`
      : `decoded ${JSON.stringify(got.entries.map((g) => [g.codeOffset, g.sourcePosition, g.isStatement, g.isBreakable]))}`,
  };
});

check('encoding', 'the handler table keeps prediction, wasUsed and the offset apart', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const dec = new HandlerTableDecoder(profile);
  const spec = profile.constants.handlerTable;
  const rows = [
    { rangeStart: 5, rangeEnd: 39, handlerOffset: 39, prediction: spec.catchPrediction.CAUGHT, wasUsed: true, data: 3 },
    { rangeStart: 0, rangeEnd: 7, handlerOffset: 0x0fffffff, prediction: spec.catchPrediction.ASYNC_AWAIT, wasUsed: false, data: -1 },
    { rangeStart: 1, rangeEnd: 2, handlerOffset: 1, prediction: spec.catchPrediction.UNCAUGHT_ASYNC_AWAIT, wasUsed: true, data: 0 },
  ];
  const stride = dec.entryBytes;
  const buf = Buffer.alloc(rows.length * stride);
  rows.forEach((r, i) => {
    const base = i * stride;
    const put = (idx, v) => buf.writeInt32LE(v | 0, base + idx * spec.entryFieldSize);
    const bits = (r.prediction << spec.bitFields.HandlerPredictionField.offset)
      | ((r.wasUsed ? 1 : 0) << spec.bitFields.HandlerWasUsedField.offset)
      | (r.handlerOffset << spec.bitFields.HandlerOffsetField.offset);
    put(spec.rangeStartIndex, r.rangeStart);
    put(spec.rangeEndIndex, r.rangeEnd);
    put(spec.rangeHandlerIndex, bits);
    put(spec.rangeDataIndex, r.data);
  });
  const got = dec.decode(buf);
  const bad = [];
  rows.forEach((r, i) => {
    const g = got.entries[i];
    for (const k of ['rangeStart', 'rangeEnd', 'handlerOffset', 'prediction', 'wasUsed', 'data']) {
      if (g[k] !== r[k]) bad.push(`row ${i} ${k}: ${g[k]} != ${r[k]}`);
    }
    if (g.predictionName === null) bad.push(`row ${i} prediction ${g.prediction} has no name`);
  });
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${rows.length} rows, predictions ${got.entries.map((e) => e.predictionName).join('/')}` };
});

// --------------------------------------------------------- (d) tag completeness

check('tags', 'every serializer tag the profile names is handled', () => {
  const text = fs.readFileSync('src/cache/deserialize.mjs', 'utf8');
  const profile = loadProfile(path.join('profiles', o.profile));
  const names = Object.keys(profile.tables.serializerTags.tags);
  const missing = names.filter((n) => !text.includes(n));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `not mentioned in the loop: ${missing.join(', ')}` : `${names.length} tags all referenced`,
  };
});

check('tags', 'the two tags that cannot be executed throw and name themselves', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const d = new Deserializer(Buffer.alloc(16), profile);
  const bad = [];
  for (const name of ['kEmbedderFieldsData', 'kApiWrapperFieldsData']) {
    const byte = profile.serializerTag(name);
    try {
      d.readSingleBytecodeData(byte, null, 0, null);
      bad.push(`${name} did not throw`);
    } catch (e) {
      if (!(e instanceof UnimplementedTagError)) bad.push(`${name} threw ${e.constructor.name}, not UnimplementedTagError`);
      else if (!e.message.includes(name)) bad.push(`${name}: error does not name the tag (${e.message})`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'kEmbedderFieldsData and kApiWrapperFieldsData both refuse by name' };
});

check('tags', 'an unused byte is refused rather than skipped', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const d = new Deserializer(Buffer.alloc(16), profile);
  // 0x30..0x3f is in V8's UNUSED_SERIALIZER_BYTE_CODES range for both 14.4 and 14.6.
  const unused = [...Array(256).keys()].find((b) => !d.tagByByte.has(b) && d.rangeByByte[b] === null);
  if (unused === undefined) return { ok: false, detail: 'the profile claims every byte is a tag' };
  try {
    d.readSingleBytecodeData(unused, null, 0, null);
    return { ok: false, detail: `byte 0x${unused.toString(16)} was accepted` };
  } catch (e) {
    return {
      ok: e instanceof CacheFormatError && /not a serializer tag/.test(e.message),
      detail: `byte 0x${unused.toString(16)}: ${e.message.slice(0, 110)}`,
    };
  }
});

// ------------------------------------------------------------- (e) layout walk

/**
 * This check used to assert the opposite: that `layouts-overlay/<tag>.json`
 * *recovered* three ScopeInfo fields the profile had dropped. T10 back-ported
 * the derivations into profilegen (ARCHITECTURE.md 9.9), so the profile now
 * declares all three itself and there is nothing to recover. What has to hold
 * instead is that they are in the profile, that nothing patches a field
 * program any more, and -- where a layoutpatch file is still on disk -- that
 * the second, independent derivation agrees field for field.
 */
check('layout', 'every profile declares ScopeInfo\'s full field program, unpatched', () => {
  const bad = [];
  const rows = [];
  const want = [
    ['context_local_names', 'indexed'],
    ['context_local_names_hashtable', 'conditional'],
    ['function_variable_info', 'conditional'],
  ];
  for (const tag of listProfiles('profiles')) {
    const profile = loadProfile(path.join('profiles', tag));
    const overlay = loadOverlay(profile.version, { profile });
    const fields = profile.layoutOf('ScopeInfo').fields;
    const byName = new Map(fields.map((f) => [f.name, f]));
    for (const [name, shape] of want) {
      const f = byName.get(name);
      if (!f) { bad.push(`${tag}: ${name} missing from layouts.json`); continue; }
      if (shape === 'indexed' && (f.indexed !== true || !f.count?.ast)) bad.push(`${tag}: ${name} is not an indexed region with a parsed count`);
      if (shape === 'conditional' && (f.present !== 'conditional' || !f.condition?.ast)) bad.push(`${tag}: ${name} is not conditional with a parsed condition`);
    }
    // the overlay view must patch nothing: the field program is layouts.json's
    for (const cls of Object.keys(profile.tables.layouts.classes)) {
      if (overlay.classFields(cls)) bad.push(`${tag}: ${cls} is still patched by the overlay view`);
    }
    rows.push(`${tag}: ${fields.length} fields, 0 patched`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(' | ') : rows.join('; ') };
});

check('layout', 'the independent layoutpatch derivation agrees with the profile, where it is on disk', () => {
  const rows = [];
  const bad = [];
  for (const tag of listProfiles('profiles')) {
    const file = path.join('layouts-overlay', `${tag}.json`);
    if (!fs.existsSync(file)) { rows.push(`${tag}: no layoutpatch file (not required)`); continue; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const profile = loadProfile(path.join('profiles', tag));
    let compared = 0;
    for (const [name, cls] of Object.entries(data.classes ?? {})) {
      const issues = cls.crossCheck?.issues ?? [];
      if (issues.length) bad.push(`${tag} ${name}: ${issues.join('; ')}`);
      const mine = new Map(profile.layoutOf(name).fields.map((f) => [f.name, f]));
      for (const f of cls.fields ?? []) {
        if (f.present === false) continue;      // gated out by the build config
        const p = mine.get(f.name);
        if (!p) { bad.push(`${tag} ${name}.${f.name}: layoutpatch derives it, the profile does not`); continue; }
        compared++;
        if (p.kind !== f.kind) bad.push(`${tag} ${name}.${f.name}: kind ${p.kind} vs ${f.kind}`);
        const pCond = p.present === 'conditional';
        if (pCond !== f.conditional) bad.push(`${tag} ${name}.${f.name}: conditional ${pCond} vs ${f.conditional}`);
        if ((p.indexed === true) !== f.indexed) bad.push(`${tag} ${name}.${f.name}: indexed ${p.indexed === true} vs ${f.indexed}`);
      }
    }
    for (const [name, e] of Object.entries(data.enums ?? {})) {
      const mine = profile.tables.layouts.enums?.[name];
      if (!mine) { bad.push(`${tag}: profile has no enum ${name}`); continue; }
      for (const [member, value] of Object.entries(e.members)) {
        if (mine.members[member] === undefined) { bad.push(`${tag}: enums.${name} has no ${member}`); continue; }
        compared++;
        if (mine.members[member] !== value) bad.push(`${tag}: enums.${name}.${member} profile ${mine.members[member]} vs layoutpatch ${value}`);
      }
    }
    const cc = profile.constants.codeCacheHeader;
    compared++;
    if (cc.magicBase !== data.codeCache.magicBase) bad.push(`${tag}: magicBase ${cc.magicBase} vs ${data.codeCache.magicBase}`);
    for (const k of Object.keys(data.codeCache.sourceHash)) {
      compared++;
      const a = cc.sourceHash?.[k];
      const b = data.codeCache.sourceHash[k];
      if (!a || a.offset !== b.offset || a.width !== b.width) bad.push(`${tag}: sourceHash.${k} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    rows.push(`${tag}: ${compared} value(s) agree`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 6).join(' | ') : rows.join('; ') };
});

check('layout', 'the static prefix of a walk matches the offsets layouts.json states', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const overlay = loadOverlay(profile.version);
  const resolver = new LayoutResolver(profile, overlay);
  const bad = [];
  let compared = 0;
  for (const className of Object.keys(profile.tables.layouts.classes)) {
    let prog;
    try { prog = resolver.program(className); } catch { continue; }
    for (const rec of prog.staticFields.values()) {
      if (!rec.present) continue;
      const declared = (profile.layoutOf(className).allFields ?? []).find((f) => f.name === rec.name);
      if (!declared || typeof declared.offset !== 'number') continue;
      compared++;
      if (declared.offset !== rec.offset) bad.push(`${className}.${rec.name}: walk ${rec.offset} vs layouts.json ${declared.offset}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 6).join('; ') : `${compared} static field offsets agree` };
});

// `decodeClassBoilerplate` reaches eleven fields by name across three classes
// and five values out of `cppLayouts.ClassBoilerplate`. A walk that returns no
// such field does not throw -- `fields.get(name)` is `undefined` and the
// decoder reports a refusal -- so without this check a profile that stopped
// carrying any of them would turn every class into a counted hole and look like
// a corpus with no classes in it.
check('layout', 'every field decodeClassBoilerplate reads by name is in the walk', () => {
  const bad = [];
  const rows = [];
  for (const tag of listProfiles('profiles')) {
    const profile = loadProfile(path.join('profiles', tag));
    const resolver = new LayoutResolver(profile, loadOverlay(profile.version, { profile }));
    for (const [className, want] of [
      ['ClassBoilerplate', ['arguments_count',
        'static_properties_template', 'static_elements_template', 'static_computed_properties',
        'instance_properties_template', 'instance_elements_template', 'instance_computed_properties']],
      // The member list is read through the StrongDescriptorArray map the
      // corpus actually uses, not through the base class.
      ['StrongDescriptorArray', ['number_of_descriptors', 'number_of_all_descriptors', 'descriptors']],
      ['AccessorPair', ['getter', 'setter']],
    ]) {
      let prog;
      try { prog = resolver.program(className); } catch (e) { bad.push(`${tag}: no ${className} (${e.message})`); continue; }
      for (const f of want) if (!prog.byName.has(f)) bad.push(`${tag}: ${className} has no ${f}`);
    }
    const de = profile.tables.layouts.structs?.DescriptorEntry;
    if (!de) bad.push(`${tag}: no DescriptorEntry struct`);
    else for (const f of ['key', 'details', 'value']) {
      if (!de.fields.some((x) => x.name === f)) bad.push(`${tag}: DescriptorEntry has no ${f}`);
    }
    const facts = profile.tables.layouts.cppLayouts?.ClassBoilerplate;
    if (!facts) bad.push(`${tag}: no cppLayouts.ClassBoilerplate`);
    else {
      // kData is 0, so `??` rather than a truthiness test.
      for (const k of ['kData', 'kGetter', 'kSetter']) {
        if ((facts.valueKind?.[k] ?? null) === null) bad.push(`${tag}: no ValueKind::${k}`);
      }
      if ((facts.argumentIndices?.kFirstDynamicArgumentIndex ?? null) === null) {
        bad.push(`${tag}: no kFirstDynamicArgumentIndex`);
      }
      if (!facts.computedEntryFlags?.fields?.keyIndex?.width) bad.push(`${tag}: no ComputedEntryFlags.keyIndex`);
      rows.push(`${tag}: DescriptorEntry ${de.packedSize}B, ValueKind kGetter=${facts.valueKind.kGetter}, `
        + `kFirstDynamicArgumentIndex=${facts.argumentIndices.kFirstDynamicArgumentIndex}, `
        + `keyIndex ${facts.computedEntryFlags.fields.keyIndex.width} bits at ${facts.computedEntryFlags.fields.keyIndex.offset}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 6).join('; ') : rows.join('; ') };
});

check('layout', 'the enum values the overlay corrects really do disagree with layouts.json', () => {
  const profile = loadProfile(path.join('profiles', o.profile));
  const overlay = loadOverlay(profile.version);
  const d = overlay.data.enumDisagreements ?? [];
  // LanguageMode and ElementsKind: Torque states names only for an `extern
  // enum`; the values are C++'s. If this ever becomes empty, either the overlay
  // stopped extracting them or V8 reordered the Torque declarations to match.
  const enums = new Set(d.map((x) => x.enum));
  return {
    ok: enums.has('LanguageMode') && enums.has('ElementsKind'),
    detail: `${d.length} disagreement(s) across ${[...enums].join(', ') || 'nothing'}; `
      + `C++ LanguageMode = ${JSON.stringify(overlay.enumMembers('LanguageMode'))}`,
  };
});

// -------------------------------------------------------- (f) end to end, real

const corpusFile = o.corpusFile ?? (fs.existsSync('extracted_jsc')
  ? path.join('extracted_jsc', fs.readdirSync('extracted_jsc').filter((f) => f.endsWith('.jsc')).sort()[0] ?? '')
  : null);

if (corpusFile && fs.existsSync(corpusFile)) {
  let env = null;
  let decoded = null;
  check('corpus', `${path.basename(corpusFile)} decodes with a clean header check`, () => {
    env = loadEnvironment(o.profile);
    decoded = readCache(corpusFile, env);
    return {
      ok: decoded.verification.errors.length === 0,
      detail: `${decoded.verification.checks.filter((c) => c.ok === true).length} checks pass, `
        + `${decoded.verification.warnings.length} warning(s), ${decoded.verification.errors.length} error(s)`,
    };
  });

  check('corpus', 'the payload ends in Serializer::Pad\'s kNop padding', () => ({
    ok: decoded.graph.trailingAllNop && decoded.graph.trailingWithinPadBudget,
    detail: `${decoded.graph.trailingBytes} trailing byte(s), all kNop: ${decoded.graph.trailingAllNop}, `
      + `within budget: ${decoded.graph.trailingWithinPadBudget}`,
  }));

  check('corpus', 'every forward reference is resolved', () => ({
    ok: decoded.graph.unresolvedForwardRefs === 0,
    detail: `${decoded.graph.unresolvedForwardRefs} unresolved`,
  }));

  check('corpus', 'units carry names, positions and scopes', () => {
    const built = buildUnits(env, decoded.graph);
    const naming = contextSlotNamingStats(built.units);
    const withName = built.units.filter((u) => typeof u.name === 'string').length;
    const withPos = built.units.filter((u) => u.startPosition !== null && u.endPosition !== null).length;
    return {
      ok: built.units.length > 0 && withPos === built.units.length,
      detail: `${built.units.length} units, ${withName} with a name, ${withPos} with a source range, `
        + `${naming.namedSlots}/${naming.contextSlots} context slots named`,
    };
  });

  // The decoder on real objects. Every assertion is a property of
  // ClassBoilerplate::New rather than of this corpus file: a member's argument
  // index is a real register of the %DefineClass call, the four descriptors V8
  // adds itself are told from members by their value and not by their name, and
  // every descriptor read is accounted for as one or the other or as a refusal.
  check('corpus', 'every ClassBoilerplate decodes to a member list that fits its argument list', () => {
    const built = buildUnits(env, decoded.graph);
    const bad = [];
    let boilerplates = 0;
    let members = 0;
    let refusals = 0;
    let synthesised = 0;
    const kinds = new Set();
    for (const u of built.units) {
      for (const c of u.constants ?? []) {
        if (c?.t !== 'classBoilerplate') continue;
        boilerplates++;
        members += c.entries.length;
        refusals += c.refusals.length;
        synthesised += c.synthesised.length;
        if (c.argumentsCount === null) { bad.push(`sfi ${u.sfiId}: no arguments_count`); continue; }
        if (c.firstDynamicArgumentIndex === null) { bad.push(`sfi ${u.sfiId}: no kFirstDynamicArgumentIndex`); continue; }
        for (const e of c.entries) {
          kinds.add(`${e.side}/${e.kind}/${e.keyKind}`);
          if (e.valueIndex < c.firstDynamicArgumentIndex || e.valueIndex >= c.argumentsCount) {
            bad.push(`sfi ${u.sfiId}: ${e.key} -> args[${e.valueIndex}] outside [${c.firstDynamicArgumentIndex}, ${c.argumentsCount})`);
          }
          if (e.keyKind === 'computed' && e.keyIndex !== e.valueIndex - 1) {
            bad.push(`sfi ${u.sfiId}: computed key args[${e.keyIndex}] is not args[${e.valueIndex}] - 1`);
          }
        }
        // ObjectDescriptor::AddConstant is called four times for the static
        // side and once for the instance side, and nowhere else.
        if (c.synthesised.length > 5) bad.push(`sfi ${u.sfiId}: ${c.synthesised.length} entries attributed to V8 itself`);
        if (c.descriptorsRead !== c.synthesised.length + c.entries.filter((e) => e.keyKind !== 'computed').length
          && !c.entries.some((e) => e.kind === 'getter' || e.kind === 'setter')) {
          // An accessor pair is one descriptor and up to two entries, so the
          // identity only holds when there is no accessor.
          bad.push(`sfi ${u.sfiId}: ${c.descriptorsRead} descriptors vs ${c.entries.length} entries + ${c.synthesised.length} V8's`);
        }
      }
    }
    return {
      ok: bad.length === 0 && boilerplates > 0,
      detail: bad.length ? bad.slice(0, 4).join('; ')
        : `${boilerplates} boilerplate(s), ${members} member(s), ${synthesised} added by V8, `
          + `${refusals} refusal(s); kinds ${[...kinds].sort().join(' ') || 'none'}`,
    };
  });

  check('corpus', 'a wrong profile is refused with an actionable message', () => {
    const other = listProfiles('profiles').find((t) => t !== o.profile);
    if (!other) return { ok: false, detail: 'only one profile installed; cannot test refusal' };
    try {
      const wrong = loadEnvironment(other, { requireRoHeap: false });
      readCache(corpusFile, wrong);
      return { ok: false, detail: `decoding with profile ${other} was accepted` };
    } catch (e) {
      const m = e.message ?? String(e);
      return {
        ok: /versionHash mismatch/.test(m) && /profilegen/.test(m) && /layoutpatch/.test(m),
        detail: m.split('\n').slice(0, 2).join(' / ').slice(0, 170),
      };
    }
  });
}

// --------------------------------------------------------------------- report

const groups = [...new Set(results.map((r) => r.group))];
const lines = [];
let failed = 0;
for (const g of groups) {
  lines.push(`-- ${g} ${'-'.repeat(Math.max(0, 66 - g.length))}`);
  for (const r of results.filter((x) => x.group === g)) {
    if (!r.ok) failed++;
    lines.push(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.name}`);
    lines.push(`         ${r.detail}`);
  }
}
lines.push('');
lines.push(`${results.length - failed}/${results.length} checks pass`);
process.stdout.write(lines.join('\n') + '\n');
if (failed) process.exitCode = 1;
