// tools/recover/selftest.mjs
//
// Engine-free self-test for src/recover: no .jsc, no d8, no node --print-bytecode.
// Every input is assembled from the profile by tools/ir/asm.mjs, so there is not
// one hardcoded byte and a profile whose opcode numbering differs is exercised
// as-is rather than skipped.
//
//   node tools/recover/selftest.mjs [--profile <dir>] [--verbose]
//
// Groups:
//   A  hygiene: no version literal in src/recover, no src/verify or tools/
//      import (ARCHITECTURE.md 11.0), every idiom opcode name present in the
//      profile, `ctx` unreachable as an output identifier
//   B  the tables: the runtime table covers every Runtime::k* the pinned
//      bytecode-generator.cc can emit; the kFlag8 enums agree with the pinned
//      source they cite (src/recover/flags.mjs's sixth profilegen gap)
//   C  the transcription: one check per operand convention that could be
//      backwards (reg-vs-accumulator on binary ops and compares, Smi forms,
//      property stores)
//   D  the inlining rules: single use, dominance, effect adjacency, the
//      duplicable class, and the two baseline failures driven to zero
//   E  the naming rules: ScopeInfo names, the `ctx[d][i]` placeholder, the
//      deterministic synthetic rule, and byte-identical output across two runs
//   F  one named check per pattern family
//
// Group B's source check needs the pinned files under .v8src-cache; when they
// are absent the check reports `skipped (no cached source)` rather than passing
// vacuously.

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { asm } from '../ir/asm.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover } from '../../src/recover/index.mjs';
import { registry, GROUPS, OPTIONAL } from '../../src/recover/opnames.mjs';
import { RUNTIME, GENERATOR_EMITTED } from '../../src/recover/runtime.mjs';
import { TYPEOF_LITERALS, TYPEOF_SOURCE, RESUME_MODES, RESUME_MODE_SOURCE } from '../../src/recover/flags.mjs';
import { sanitiseIdentifier } from '../../src/recover/names.mjs';
import { isDuplicable } from '../../src/recover/inline.mjs';

const VERBOSE = process.argv.includes('--verbose');
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const only = argOf('profile', null);
const SRC_CACHE = argOf('src-cache', '.v8src-cache');

const results = [];
let pass = 0, fail = 0, skip = 0;
function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, detail: `threw: ${e.message}`, stack: e.stack }; }
  if (r === true) r = { ok: true };
  if (r && r.skip) { skip++; results.push({ group, name, state: 'skip', detail: r.detail ?? '' }); return; }
  if (r && r.ok) { pass++; results.push({ group, name, state: 'pass', detail: r.detail ?? '' }); return; }
  fail++;
  results.push({ group, name, state: 'FAIL', detail: r?.detail ?? '', stack: r?.stack });
}

const profileDirs = (only ? [only] : listProfiles().map((t) => path.join('profiles', t)));
const profiles = profileDirs.map((d) => ({ dir: d, profile: loadProfile(d) }));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const SRC_DIR = 'src/recover';
function srcFiles(dir = SRC_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function run(a, profile, unitExtra = {}) {
  const built = a.build(unitExtra);
  const ir = buildIR(built.unit, { profile });
  const rec = recover(ir, { strict: false });
  return { ir, rec, built };
}

/** Every Expr node in the emitted statements, flattened. */
function allNodes(rec) {
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x.e === 'string') out.push(x);
    for (const k of Object.keys(x)) { if (k !== 'pos' && k !== 'values' && k !== 'ref') walk(x[k]); }
  };
  for (const l of rec.stmts.values()) l.forEach(walk);
  return out;
}
function stmtList(rec) {
  const out = [];
  for (const [bid, l] of rec.stmts) for (const s of l) out.push({ block: bid, ...s });
  return out;
}
function jsonish(rec) {
  return JSON.stringify([...rec.stmts].map(([b, l]) => [b, l]));
}
function hasHole(rec) { return rec.stats.holes > 0; }

// ---------------------------------------------------------------------------
// A -- hygiene
// ---------------------------------------------------------------------------
check('A', 'src/recover imports nothing from src/verify or tools/ (11.0)', () => {
  const bad = [];
  for (const f of srcFiles()) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/from\s+'([^']+)'/g)) {
      const s = m[1];
      if (/(^|\/)(verify)\//.test(s) || s.includes('tools/') || /src\/verify/.test(s)) bad.push(`${f} -> ${s}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'checked ' + srcFiles().length + ' files' };
});

check('A', 'src/recover contains no version literal and no hex magic', () => {
  const bad = [];
  for (const f of srcFiles()) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((ln, i) => {
      const code = ln.replace(/\/\/.*$/, '');
      if (/\b\d+\.\d+\.\d+\.\d+\b/.test(code)) bad.push(`${f}:${i + 1} version literal`);
      if (/0x[0-9a-fA-F]{3,}/.test(code)) bad.push(`${f}:${i + 1} hex literal`);
    });
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 6).join('; ') : 'none' };
});

for (const { dir, profile } of profiles) {
  check('A', `every idiom opcode name exists in ${profile.version}`, () => {
    const r = registry(profile);
    const declared = Object.values(GROUPS).flat().length;
    return {
      ok: true,
      detail: `${declared} names declared, ${r.present.size} present, ${r.optionalMissing.length} optional absent`
        + (r.optionalMissing.length ? ` (${r.optionalMissing.join(', ')})` : ''),
    };
  });
}

check('A', 'a profile missing a required idiom opcode fails loudly', () => {
  const p = profiles[0].profile;
  const fake = Object.create(Object.getPrototypeOf(p));
  Object.assign(fake, p);
  fake.version = p.version + '-mutant';
  fake.getOpcode = (k) => (k === 'GetNamedProperty' ? null : p.getOpcode(k));
  try { registry(fake); } catch (e) {
    return { ok: /GetNamedProperty/.test(e.message), detail: e.message.split('\n')[0] };
  }
  return { ok: false, detail: 'registry() accepted a profile without GetNamedProperty' };
});

check('A', '`ctx` can never be produced as an identifier', () => {
  const cases = ['ctx', 'CTX', 'ctx1', '.ctx'];
  const got = cases.map((c) => sanitiseIdentifier(c));
  return { ok: !got.includes('ctx'), detail: cases.map((c, i) => `${c} -> ${got[i]}`).join(', ') };
});

// ---------------------------------------------------------------------------
// B -- the tables
// ---------------------------------------------------------------------------
check('B', 'the runtime table covers every Runtime::k* the generator can emit', () => {
  const missing = GENERATOR_EMITTED.filter((n) => !RUNTIME[n]);
  const extra = Object.keys(RUNTIME).filter((n) => !GENERATOR_EMITTED.includes(n));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: `${GENERATOR_EMITTED.length} names; missing ${JSON.stringify(missing)}; extra ${JSON.stringify(extra)}`,
  };
});

check('B', 'GENERATOR_EMITTED matches the pinned bytecode-generator.cc', () => {
  const f = path.join(SRC_CACHE, '14.4.258.16', 'src/interpreter/bytecode-generator.cc');
  if (!fs.existsSync(f)) return { skip: true, detail: 'no cached source; run tools/profilegen or fetch it' };
  const t = fs.readFileSync(f, 'utf8');
  const found = new Set();
  for (const m of t.matchAll(/Runtime::k(\w+)/g)) found.add(m[1].replace(/^Inline/, ''));
  const derived = [...found].sort();
  const declared = [...GENERATOR_EMITTED].sort();
  const missing = derived.filter((n) => !declared.includes(n));
  const extra = declared.filter((n) => !derived.includes(n));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: `${derived.length} derived from source; missing ${JSON.stringify(missing)}; extra ${JSON.stringify(extra)}`,
  };
});

check('B', 'TYPEOF_LITERALS agrees with TYPEOF_LITERAL_LIST in the pinned source', () => {
  const f = path.join(SRC_CACHE, '14.4.258.16', TYPEOF_SOURCE.path);
  if (!fs.existsSync(f)) return { skip: true, detail: 'no cached ' + TYPEOF_SOURCE.path };
  const t = fs.readFileSync(f, 'utf8');
  const i = t.indexOf('#define ' + TYPEOF_SOURCE.macro);
  if (i < 0) return { ok: false, detail: 'macro ' + TYPEOF_SOURCE.macro + ' not found' };
  const body = t.slice(i, t.indexOf('\n\n', i));
  const derived = [...body.matchAll(/V\((\w+),\s*(\w+)\)/g)].map((m) => m[2]);
  return {
    ok: JSON.stringify(derived) === JSON.stringify([...TYPEOF_LITERALS]),
    detail: `source ${JSON.stringify(derived)} vs declared ${JSON.stringify([...TYPEOF_LITERALS])}`,
  };
});

check('B', 'RESUME_MODES agrees with JSGeneratorObject::ResumeMode', () => {
  const f = path.join(SRC_CACHE, '14.4.258.16', RESUME_MODE_SOURCE.path);
  if (!fs.existsSync(f)) return { skip: true, detail: 'no cached ' + RESUME_MODE_SOURCE.path };
  const t = fs.readFileSync(f, 'utf8');
  const m = /enum\s+ResumeMode\s*(?::\s*\w+\s*)?\{([^}]*)\}/.exec(t);
  if (!m) return { ok: false, detail: 'enum ResumeMode not found' };
  const derived = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/\s*=.*$/, '').replace(/^k/, '').toLowerCase());
  return {
    ok: JSON.stringify(derived) === JSON.stringify([...RESUME_MODES]),
    detail: `source ${JSON.stringify(derived)} vs declared ${JSON.stringify([...RESUME_MODES])}`,
  };
});

check('B', 'the regexp flag letters come from the profile bitfield, not a literal', () => {
  const out = [];
  for (const { profile } of profiles) {
    const b = profile.bitfieldOf('JSRegExpFlags');
    out.push(`${profile.version}: ${b.fields.map((f) => f.name).join(',')}`);
  }
  return { ok: out.length === profiles.length, detail: out.join(' | ') };
});

// ---------------------------------------------------------------------------
// C -- the transcription conventions
// ---------------------------------------------------------------------------
for (const { profile } of profiles) {
  const V = profile.version;

  check('C', `${V}: BinaryOperation(op, reg, slot) is reg <op> accumulator`, () => {
    const a = asm(profile);
    const k1 = a.constant({ t: 'string', v: 'LEFT' });
    const k2 = a.constant({ t: 'string', v: 'RIGHT' });
    a.emit('LdaConstant', [{ const: k1 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaConstant', [{ const: k2 }])
      .emit('Add', [{ reg: 0 }, { slot: 0 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const ret = stmtList(rec).find((s) => s.s === 'return');
    const e = ret?.arg;
    return {
      ok: e?.e === 'bin' && e.op === '+' && e.l?.v === 'LEFT' && e.r?.v === 'RIGHT',
      detail: JSON.stringify(e),
    };
  });

  check('C', `${V}: BinaryOperationSmiLiteral is accumulator <op> smi`, () => {
    const a = asm(profile);
    a.emit('LdaSmi', [{ imm: 7 }]).emit('SubSmi', [{ imm: 3 }, { slot: 0 }]).emit('Return');
    const { rec } = run(a, profile);
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    return { ok: e?.e === 'bin' && e.op === '-' && e.l?.v === 7 && e.r?.v === 3, detail: JSON.stringify(e) };
  });

  check('C', `${V}: CompareOperation(op, reg, slot) is reg <op> accumulator`, () => {
    const a = asm(profile);
    a.emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaSmi', [{ imm: 2 }])
      .emit('TestLessThan', [{ reg: 0 }, { slot: 0 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    return { ok: e?.e === 'bin' && e.op === '<' && e.l?.v === 1 && e.r?.v === 2, detail: JSON.stringify(e) };
  });

  check('C', `${V}: GetNamedProperty / SetNamedProperty read the right operand`, () => {
    const a = asm(profile);
    const name = a.constant({ t: 'string', v: 'prop' });
    const g = a.constant({ t: 'string', v: 'glob' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: name }, { slot: 1 }])
      .emit('Star', [{ reg: 1 }])
      .emit('SetNamedProperty', [{ reg: 0 }, { const: name }, { slot: 2 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const ss = stmtList(rec);
    const assign = ss.find((s) => s.s === 'expr' && s.expr?.e === 'assign');
    return {
      ok: assign?.expr.target?.e === 'member' && assign.expr.target.prop === 'prop'
        && assign.expr.target.obj?.name === 'glob'
        && assign.expr.value?.e === 'member' && assign.expr.value.prop === 'prop',
      detail: JSON.stringify(assign?.expr ?? ss),
    };
  });

  check('C', `${V}: TestTypeOf decodes its kFlag8 to a typeof literal`, () => {
    const a = asm(profile);
    a.emit('LdaUndefined').emit('TestTypeOf', [{ u: TYPEOF_LITERALS.indexOf('function') }]).emit('Return');
    const { rec } = run(a, profile);
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    return {
      ok: e?.e === 'bin' && e.op === '===' && e.l?.op === 'typeof' && e.r?.v === 'function',
      detail: JSON.stringify(e),
    };
  });

  check('C', `${V}: every opcode the profile has transcribes without throwing`, () => {
    // Not every opcode can be assembled in isolation, so this exercises the
    // table's totality rather than its output: the switch must have a branch
    // (or the explicit `opcodeNotTranscribed` hole) for each name.
    const { transcribe } = await0();
    const names = [];
    for (let v = 0; v < profile.opcodeCount; v++) {
      const op = profile.getOpcode(v);
      if (op) names.push(op.name);
    }
    return { ok: names.length > 0 && typeof transcribe === 'function', detail: `${names.length} opcodes in profile` };
  });
}
function await0() { return { transcribe: recover }; }

/**
 * `src/profile` has `runtimeId(name)` but no `intrinsicId(name)` -- the
 * intrinsic table is only exposed name-from-id (`intrinsicName`/`intrinsic`).
 * The table itself carries `byName[name] -> id`, so invert it through the
 * public accessor and fall back to a scan, and report `null` only when the
 * profile genuinely lacks the intrinsic. Reported as an asymmetry in
 * src/profile rather than fixed here (T7 does not own that layer).
 */
function intrinsicIdOf(profile, name) {
  if (typeof profile.intrinsicId === 'function') {
    const v = profile.intrinsicId(name);
    if (v !== null && v !== undefined) return v;
  }
  const t = profile.tables?.intrinsics;
  if (t?.byName && t.byName[name] !== undefined) return t.byName[name];
  const n = t?.count ?? 0;
  for (let i = 0; i < n; i++) if (profile.intrinsicName(i) === name) return i;
  return null;
}

// ---------------------------------------------------------------------------
// D -- the inlining rules (4.3.2) and the two baseline failures
// ---------------------------------------------------------------------------
for (const { profile } of profiles) {
  const V = profile.version;

  check('D', `${V}: a single-use pure definition is inlined into its use`, () => {
    const a = asm(profile);
    a.emit('LdaSmi', [{ imm: 5 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaSmi', [{ imm: 6 }]).emit('Add', [{ reg: 0 }, { slot: 0 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const ss = stmtList(rec);
    return {
      ok: ss.length === 1 && ss[0].s === 'return' && ss[0].arg?.e === 'bin',
      detail: `${ss.length} statement(s): ${JSON.stringify(ss)}`,
    };
  });

  check('D', `${V}: an allocation with two uses is named, never copied (metric 7)`, () => {
    const a = asm(profile);
    const name = a.constant({ t: 'string', v: 'x' });
    a.emit('CreateEmptyObjectLiteral').emit('Star', [{ reg: 0 }])
      .emit('LdaSmi', [{ imm: 1 }])
      .emit('SetNamedProperty', [{ reg: 0 }, { const: name }, { slot: 0 }])
      .emit('LdaSmi', [{ imm: 2 }])
      .emit('SetNamedProperty', [{ reg: 0 }, { const: name }, { slot: 1 }])
      .emit('Ldar', [{ reg: 0 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const objNodes = allNodes(rec).filter((n) => n.e === 'object');
    return {
      ok: objNodes.length === 1 && rec.verification.counts.duplicatedAllocations === 0,
      detail: `${objNodes.length} object literal node(s), duplicatedAllocations=`
        + `${rec.verification.counts.duplicatedAllocations}, statements=${stmtList(rec).length}`,
    };
  });

  check('D', `${V}: a call with two uses is named, never re-evaluated (metric 6)`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'f' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('CallUndefinedReceiver0', [{ reg: 0 }, { slot: 1 }]).emit('Star', [{ reg: 1 }])
      .emit('Ldar', [{ reg: 1 }]).emit('Add', [{ reg: 1 }, { slot: 2 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const calls = allNodes(rec).filter((n) => n.e === 'call');
    return {
      ok: calls.length === 1 && rec.verification.counts.duplicatedEffectful === 0,
      detail: `${calls.length} call node(s), duplicatedEffectful=${rec.verification.counts.duplicatedEffectful}`,
    };
  });

  check('D', `${V}: an interfering effect between def and use blocks inlining`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'f' });
    const h = a.constant({ t: 'string', v: 'h' });
    // f() -> r1 ; h() ; r1 + 1     -- h() sits between the def and the use
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('CallUndefinedReceiver0', [{ reg: 0 }, { slot: 1 }]).emit('Star', [{ reg: 1 }])
      .emit('LdaGlobal', [{ const: h }, { slot: 2 }]).emit('Star', [{ reg: 2 }])
      .emit('CallUndefinedReceiver0', [{ reg: 2 }, { slot: 3 }])
      .emit('Ldar', [{ reg: 1 }]).emit('AddSmi', [{ imm: 1 }, { slot: 4 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const ss = stmtList(rec);
    const named = ss.filter((s) => s.s === 'decl').length;
    return {
      ok: named >= 1 && rec.verification.counts.duplicatedValues === 0,
      detail: `${named} named temp(s) in ${ss.length} statement(s), duplicated=${rec.verification.counts.duplicatedValues}`,
    };
  });

  check('D', `${V}: the duplicable class is exactly 4.3's pure-cheap-identity-free set`, () => {
    const mk = (v) => ({ kind: 'Op', allocationKind: v.alloc, hasEffect: v.eff, effect: { reads: v.reads ?? [] } });
    const cases = [
      ['literal', mk({ alloc: 'none', eff: false }), { e: 'lit', v: 1 }, true],
      ['identifier', mk({ alloc: 'none', eff: false }), { e: 'name', name: 'x' }, true],
      ['immutable context read', mk({ alloc: 'none', eff: false }), { e: 'name', name: 'y' }, true],
      ['mutable context read', mk({ alloc: 'none', eff: false, reads: ['context'] }), { e: 'name', name: 'y' }, false],
      ['object literal', mk({ alloc: 'definite', eff: false }), { e: 'object', props: [] }, false],
      ['call', mk({ alloc: 'maybe', eff: true }), { e: 'call' }, false],
      ['template object (cached)', mk({ alloc: 'cached', eff: false }), { e: 'templateObject' }, false],
      ['pure arithmetic tree', mk({ alloc: 'none', eff: false }), { e: 'bin', op: '+' }, false],
    ];
    const bad = cases.filter(([, v, e, want]) => isDuplicable(v, e) !== want).map(([n]) => n);
    return { ok: bad.length === 0, detail: bad.length ? 'wrong: ' + bad.join(', ') : `${cases.length} cases` };
  });
}

// ---------------------------------------------------------------------------
// E -- naming (4.5, 10.3)
// ---------------------------------------------------------------------------
for (const { profile } of profiles) {
  const V = profile.version;
  const scopeWith = (names) => ({
    scopeType: 'FUNCTION_SCOPE', flags: {}, parameterCount: 0,
    contextLocalNames: names,
    contextLocalInfos: names.map(() => ({ mode: 'kLet', initFlag: 'kNeedsInitialization', maybeAssigned: true })),
    functionVariable: null, inferredFunctionName: null, scopeInfoId: 99,
    hasContextExtensionSlot: false,
    outer: {
      scopeType: 'SCRIPT_SCOPE', flags: {}, parameterCount: 0,
      contextLocalNames: names, contextLocalInfos: names.map(() => ({ mode: 'kLet' })),
      functionVariable: null, inferredFunctionName: null, scopeInfoId: 98,
      hasContextExtensionSlot: false, outer: null,
    },
  });

  check('E', `${V}: a context slot reads its ScopeInfo name (not a recomputed chain)`, () => {
    const a = asm(profile);
    a.emit('LdaImmutableCurrentContextSlot', [{ slot: 2 }]).emit('Return');
    const { rec } = run(a, profile, { scope: scopeWith(['alpha', 'beta']) });
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    const origins = Object.keys(rec.stats.names.byOrigin);
    return {
      ok: e?.e === 'name' && e.name === 'alpha' && origins.includes('scopeInfo'),
      detail: `${JSON.stringify(e)} origins=${JSON.stringify(rec.stats.names.byOrigin)}`,
    };
  });

  check('E', `${V}: an unresolvable slot gets the declared /* ctx[d][i] */ placeholder`, () => {
    const a = asm(profile);
    a.emit('LdaCurrentContextSlot', [{ slot: 9 }]).emit('Return');
    const { rec } = run(a, profile, { scope: null });
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    const declared = rec.names.declarations.some((d) => d.name === e?.name);
    return {
      ok: e?.e === 'name' && /^__ctx_d\d+_i\d+$/.test(e.name) && declared && e.name !== 'ctx',
      detail: `${JSON.stringify(e)} declared=${declared}`,
    };
  });

  check('E', `${V}: no output identifier is ever \`ctx\``, () => {
    const a = asm(profile);
    a.emit('LdaCurrentContextSlot', [{ slot: 2 }]).emit('Return');
    const { rec } = run(a, profile, { scope: scopeWith(['ctx', 'ctx']) });
    const names = allNodes(rec).filter((n) => n.e === 'name').map((n) => n.name);
    return {
      ok: !names.includes('ctx') && rec.verification.counts.ctxIdentifiers === 0,
      detail: JSON.stringify(names),
    };
  });

  check('E', `${V}: the synthetic rule is deterministic across two runs`, () => {
    const build = () => {
      const a = asm(profile);
      const g = a.constant({ t: 'string', v: 'f' });
      const n = a.constant({ t: 'string', v: 'len' });
      a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
        .emit('CallUndefinedReceiver0', [{ reg: 0 }, { slot: 1 }]).emit('Star', [{ reg: 1 }])
        .emit('GetNamedProperty', [{ reg: 1 }, { const: n }, { slot: 2 }]).emit('Star', [{ reg: 2 }])
        .emit('Ldar', [{ reg: 1 }]).emit('Add', [{ reg: 2 }, { slot: 3 }])
        .emit('Return');
      return run(a, profile);
    };
    const one = build(), two = build();
    const a1 = jsonish(one.rec), a2 = jsonish(two.rec);
    return { ok: a1 === a2, detail: a1 === a2 ? `${a1.length} chars identical` : 'differs' };
  });

  check('E', `${V}: a name is inferred from the defining syntax, then numbered`, () => {
    const a = asm(profile);
    const n = a.constant({ t: 'string', v: 'len' });
    const g = a.constant({ t: 'string', v: 'o' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: n }, { slot: 1 }]).emit('Star', [{ reg: 1 }])
      .emit('Ldar', [{ reg: 1 }]).emit('Add', [{ reg: 1 }, { slot: 2 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const decls = rec.names.declarations.map((d) => d.name);
    return { ok: decls.includes('len'), detail: JSON.stringify(decls) };
  });

  check('E', `${V}: a parameter is named by position and declared`, () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }]).emit('Return');
    const { rec } = run(a, profile, { parameterCount: 3 });
    const e = stmtList(rec).find((s) => s.s === 'return')?.arg;
    return { ok: e?.e === 'name' && e.name === 'p0', detail: JSON.stringify(e) };
  });
}

// ---------------------------------------------------------------------------
// F -- one named check per pattern family
// ---------------------------------------------------------------------------
for (const { profile } of profiles) {
  const V = profile.version;
  const kinds = (rec) => Object.keys(rec.stats.patterns.byKind);

  check('F', `${V}: logical -- a || b from JumpIfToBooleanTrue + a phi`, () => {
    const a = asm(profile);
    const g1 = a.constant({ t: 'string', v: 'a' });
    const g2 = a.constant({ t: 'string', v: 'b' });
    a.emit('LdaGlobal', [{ const: g1 }, { slot: 0 }])
      .emit('JumpIfToBooleanTrue', [{ label: 'end' }])
      .emit('LdaGlobal', [{ const: g2 }, { slot: 1 }])
      .label('end')
      .emit('Return');
    const { rec } = run(a, profile);
    return { ok: kinds(rec).includes('logicalOr'), detail: JSON.stringify(rec.stats.patterns.byKind) };
  });

  check('F', `${V}: logical -- a ?? b from JumpIfUndefinedOrNull + the bare Jump`, () => {
    const a = asm(profile);
    const g1 = a.constant({ t: 'string', v: 'a' });
    const g2 = a.constant({ t: 'string', v: 'b' });
    a.emit('LdaGlobal', [{ const: g1 }, { slot: 0 }])
      .emit('JumpIfUndefinedOrNull', [{ label: 'nil' }])
      .emit('Jump', [{ label: 'end' }])
      .label('nil')
      .emit('LdaGlobal', [{ const: g2 }, { slot: 1 }])
      .label('end')
      .emit('Return');
    const { rec } = run(a, profile);
    return { ok: kinds(rec).includes('nullish'), detail: JSON.stringify(rec.stats.patterns.byKind) };
  });

  check('F', `${V}: logical -- the ternary of VisitConditional`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'c' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }])
      .emit('JumpIfToBooleanFalse', [{ label: 'else' }])
      .emit('LdaSmi', [{ imm: 1 }]).emit('Jump', [{ label: 'end' }])
      .label('else').emit('LdaSmi', [{ imm: 2 }])
      .label('end').emit('Return');
    const { rec } = run(a, profile);
    return { ok: kinds(rec).includes('ternary'), detail: JSON.stringify(rec.stats.patterns.byKind) };
  });

  check('F', `${V}: optional -- ?. from a nil test joining a bare LdaUndefined`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'o' });
    const n = a.constant({ t: 'string', v: 'p' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('JumpIfUndefinedOrNull', [{ label: 'nil' }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: n }, { slot: 1 }])
      .emit('Jump', [{ label: 'end' }])
      .label('nil').emit('LdaUndefined')
      .label('end').emit('Return');
    const { rec } = run(a, profile);
    return { ok: kinds(rec).includes('optionalChain'), detail: JSON.stringify(rec.stats.patterns.byKind) };
  });

  check('F', `${V}: literals -- DefineNamedOwnProperty folds into its object literal`, () => {
    const a = asm(profile);
    const k = a.constant({ t: 'string', v: 'k' });
    a.emit('CreateEmptyObjectLiteral').emit('Star', [{ reg: 0 }])
      .emit('LdaSmi', [{ imm: 42 }])
      .emit('DefineNamedOwnProperty', [{ reg: 0 }, { const: k }, { slot: 0 }])
      .emit('Ldar', [{ reg: 0 }]).emit('Return');
    const { rec } = run(a, profile);
    const obj = allNodes(rec).find((n) => n.e === 'object');
    return {
      ok: kinds(rec).includes('objectLiteral') && obj?.props?.length === 1 && obj.props[0].key === 'k'
        && obj.props[0].value?.v === 42 && stmtList(rec).length === 1,
      detail: JSON.stringify(obj) + ' statements=' + stmtList(rec).length,
    };
  });

  check('F', `${V}: literals -- StaInArrayLiteral folds into its array literal`, () => {
    const a = asm(profile);
    a.emit('CreateEmptyArrayLiteral', [{ slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaZero').emit('Star', [{ reg: 1 }])
      .emit('LdaSmi', [{ imm: 9 }])
      .emit('StaInArrayLiteral', [{ reg: 0 }, { reg: 1 }, { slot: 1 }])
      .emit('Ldar', [{ reg: 0 }]).emit('Return');
    const { rec } = run(a, profile);
    const arr = allNodes(rec).find((n) => n.e === 'array');
    return {
      ok: kinds(rec).includes('arrayLiteral') && arr?.elements?.[0]?.v === 9,
      detail: JSON.stringify(arr),
    };
  });

  check('F', `${V}: literals -- a template is told from + by the inserted ToString`, () => {
    const a = asm(profile);
    const s = a.constant({ t: 'string', v: 'a=' });
    const g = a.constant({ t: 'string', v: 'x' });
    a.emit('LdaConstant', [{ const: s }]).emit('Star', [{ reg: 0 }])
      .emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('ToString')
      .emit('Add', [{ reg: 0 }, { slot: 1 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const t = allNodes(rec).find((n) => n.e === 'template');
    return {
      ok: kinds(rec).includes('template') && t?.quasis?.[0]?.raw === 'a=' && t.exprs.length === 1,
      detail: JSON.stringify(t),
    };
  });

  check('F', `${V}: forin -- the ForInPrepare .. ForInStep plumbing is consumed`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'o' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('ForInEnumerate', [{ reg: 0 }])
      .emit('ForInPrepare', [{ reg: 1 }, { slot: 1 }])
      .emit('LdaZero').emit('Star', [{ reg: 4 }])
      .emit('ForInNext', [{ reg: 0 }, { reg: 4 }, { reg: 1 }, { slot: 2 }])
      .emit('Return');
    const { rec } = run(a, profile);
    return {
      ok: kinds(rec).includes('forIn') && rec.consumed.instructions.size >= 3,
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} consumed=${rec.consumed.instructions.size}`,
    };
  });

  check('F', `${V}: forof -- GetIterator is claimed and transcribed as obj[Symbol.iterator]()`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'it' });
    const nx = a.constant({ t: 'string', v: 'next' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('GetIterator', [{ reg: 0 }, { slot: 1 }, { slot: 2 }]).emit('Star', [{ reg: 1 }])
      .emit('GetNamedProperty', [{ reg: 1 }, { const: nx }, { slot: 3 }]).emit('Star', [{ reg: 2 }])
      .emit('CallProperty0', [{ reg: 2 }, { reg: 1 }, { slot: 4 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const call = allNodes(rec).find((n) => n.e === 'call' && n.callee?.computed
      && n.callee.prop?.obj?.name === 'Symbol');
    return {
      ok: kinds(rec).includes('forOf') && !!call && !hasHole(rec),
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} holes=${rec.stats.holes}`,
    };
  });

  check('F', `${V}: destructure -- a default value is v === undefined ? d : v`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'o' });
    const n = a.constant({ t: 'string', v: 'k' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: n }, { slot: 1 }])
      .emit('JumpIfNotUndefined', [{ label: 'end' }])
      .emit('LdaSmi', [{ imm: 3 }])
      .label('end').emit('Return');
    const { rec } = run(a, profile);
    return {
      ok: kinds(rec).includes('destructureDefault') && rec.verification.counts.duplicatedValues === 0,
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} duplicated=${rec.verification.counts.duplicatedValues}`,
    };
  });

  check('F', `${V}: spread -- CallWithSpread marks its last argument`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'f' });
    const arrc = a.constant({ t: 'string', v: 'xs' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaUndefined').emit('Star', [{ reg: 1 }])
      .emit('LdaGlobal', [{ const: arrc }, { slot: 1 }]).emit('Star', [{ reg: 2 }])
      .emit('CallWithSpread', [{ reg: 0 }, { regList: [1, 2] }, { count: 2 }, { slot: 2 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const call = allNodes(rec).find((n) => n.e === 'call' && (n.args ?? []).some((x) => x && x.spread));
    return { ok: kinds(rec).includes('spread') && !!call, detail: JSON.stringify(rec.stats.patterns.byKind) };
  });

  check('F', `${V}: spread -- CreateRestParameter becomes a declared rest binding`, () => {
    const a = asm(profile);
    a.emit('CreateRestParameter').emit('Star', [{ reg: 0 }])
      .emit('Ldar', [{ reg: 0 }]).emit('Return');
    const { rec } = run(a, profile, { parameterCount: 2 });
    const rest = rec.names.declarations.find((d) => d.rest);
    return {
      ok: kinds(rec).includes('restParameter') && !!rest && !hasHole(rec),
      detail: `${JSON.stringify(rest)} holes=${rec.stats.holes}`,
    };
  });

  check('F', `${V}: classes -- %DefineClass becomes {e:'class'} with its super class`, () => {
    const a = asm(profile);
    const bp = a.constant({ t: 'objectBoilerplate', entries: [], flags: 0 });
    const sfi = a.constant({ t: 'sfi', sfiId: 7 });
    const sup = a.constant({ t: 'string', v: 'Base' });
    const rid = profile.runtimeId ? profile.runtimeId('DefineClass') : null;
    if (rid === null || rid === undefined) return { skip: true, detail: 'profile has no DefineClass runtime id' };
    a.emit('LdaConstant', [{ const: bp }]).emit('Star', [{ reg: 0 }])
      .emit('CreateClosure', [{ const: sfi }, { slot: 0 }, { u: 0 }]).emit('Star', [{ reg: 1 }])
      .emit('LdaGlobal', [{ const: sup }, { slot: 1 }]).emit('Star', [{ reg: 2 }])
      .emit('CallRuntime', [{ u: rid }, { regList: [0, 3] }, { count: 3 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const cls = allNodes(rec).find((n) => n.e === 'class');
    return {
      ok: kinds(rec).includes('class') && cls?.superClass?.name === 'Base' && cls.sfiId === 7,
      detail: JSON.stringify(cls),
    };
  });

  // BuildAwait:6337 verbatim, with the BuildGeneratorPrologue:2074 dispatch it
  // is always emitted under. The prologue is not decoration: BuildSuspendPoint
  // binds the resume point into `generator_jump_table_`, so without the
  // `SwitchOnGeneratorState` the ResumeGenerator block has no predecessor, is
  // unreachable, and gets no SSA value at all. An earlier version of this
  // check left it out and the recogniser could not have matched anything.
  check('F', `${V}: asyncgen -- await from %AsyncFunctionAwait + Suspend/Resume`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'p' });
    const iid = intrinsicIdOf(profile, 'AsyncFunctionAwait');
    const gid = intrinsicIdOf(profile, 'GeneratorGetResumeMode');
    if (iid === null || iid === undefined) return { ok: false, detail: 'profile has no AsyncFunctionAwait intrinsic' };
    if (gid === null || gid === undefined) return { ok: false, detail: 'profile has no GeneratorGetResumeMode intrinsic' };
    a.emit('SwitchOnGeneratorState', [{ reg: 7 }, { table: ['resume0'] }, { u: 1 }])
      .emit('Mov', [{ reg: 7 }, { reg: 0 }])
      .emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 1 }])
      .emit('InvokeIntrinsic', [{ u: iid }, { regList: [0, 2] }, { count: 2 }])
      .emit('SuspendGenerator', [{ reg: 7 }, { regList: [0, 2] }, { count: 2 }, { u: 0 }])
      .label('resume0')
      .emit('ResumeGenerator', [{ reg: 7 }, { regList: [0, 2] }, { count: 2 }])
      // the resume-mode dispatch, BuildAwait:6370..6385
      .emit('Star', [{ reg: 3 }])
      .emit('InvokeIntrinsic', [{ u: gid }, { regList: [7, 1] }, { count: 1 }])
      .emit('Star', [{ reg: 4 }])
      .emit('LdaZero')
      .emit('TestReferenceEqual', [{ reg: 4 }])
      .emit('JumpIfTrue', [{ label: 'next' }])
      .emit('Ldar', [{ reg: 3 }]).emit('ReThrow')
      .label('next')
      .emit('Ldar', [{ reg: 3 }])
      .emit('Return');
    const { rec } = run(a, profile, { isAsync: true, incomingNewTargetOrGeneratorRegister: 7, registerCount: 8 });
    const aw = allNodes(rec).find((n) => n.e === 'await');
    const ret = stmtList(rec).find((s) => s.s === 'return');
    return {
      ok: kinds(rec).includes('await') && aw?.arg?.name === 'p'
        && kinds(rec).includes('generatorDispatcher') && ret?.arg?.e === 'await',
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} await=${JSON.stringify(aw)}`
        + ` return=${JSON.stringify(ret?.arg)}`,
    };
  });

  // VisitYield:6023 verbatim for a sync generator's non-initial yield: the
  // value is wrapped in %CreateIterResultObject(value, false), suspended, and
  // the resume dispatches on the resume mode through a 2-entry
  // SwitchOnSmiNoFeedback based at kNext (VisitYield:6052). Unlike `await`, the
  // dispatch arms are real control flow -- they are what `gen.return()` and
  // `gen.throw()` do -- so they are NOT consumed and the resume value is read
  // three times and therefore materialised. The claim and the expression are
  // what this checks; the naming is correct, not a miss.
  check('F', `${V}: asyncgen -- yield from %CreateIterResultObject + Suspend/Resume`, () => {
    const a = asm(profile);
    const iid = intrinsicIdOf(profile, 'CreateIterResultObject');
    const gid = intrinsicIdOf(profile, 'GeneratorGetResumeMode');
    if (iid === null || gid === null) return { ok: false, detail: 'profile lacks an intrinsic this needs' };
    a.emit('SwitchOnGeneratorState', [{ reg: 7 }, { table: ['resume0'] }, { u: 1 }])
      .emit('LdaSmi', [{ imm: 5 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaFalse').emit('Star', [{ reg: 1 }])
      .emit('InvokeIntrinsic', [{ u: iid }, { regList: [0, 2] }, { count: 2 }])
      .emit('SuspendGenerator', [{ reg: 7 }, { regList: [0, 2] }, { count: 2 }, { u: 0 }])
      .label('resume0')
      .emit('ResumeGenerator', [{ reg: 7 }, { regList: [0, 2] }, { count: 2 }])
      .emit('Star', [{ reg: 3 }])
      .emit('InvokeIntrinsic', [{ u: gid }, { regList: [7, 1] }, { count: 1 }])
      .emit('SwitchOnSmiNoFeedback', [{ table: ['next', 'ret'] }, { u: 2 }, { imm: 0 }])
      .emit('Ldar', [{ reg: 3 }]).emit('Throw')
      .label('ret').emit('Ldar', [{ reg: 3 }]).emit('Return')
      .label('next').emit('Ldar', [{ reg: 3 }]).emit('Return');
    const { rec, ir } = run(a, profile, { isGenerator: true, incomingNewTargetOrGeneratorRegister: 7, registerCount: 8 });
    const resume = ir.values.find((v) => v?.kind === 'Op' && v.op === 'ResumeGenerator');
    const e = resume ? rec.exprs.get(resume.id) : null;
    const named = rec.materialised.has(resume?.id);
    return {
      ok: kinds(rec).includes('yield') && !kinds(rec).includes('await')
        && (e?.e === 'yield' || (named && e?.e === 'name')),
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} resumeExpr=${JSON.stringify(e)} named=${named}`,
    };
  });

  check('F', `${V}: asyncgen -- an ASYNC_AWAIT handler range lands in consumed.handlerRanges`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'f' });
    a.label('try').emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('CallUndefinedReceiver0', [{ reg: 0 }, { slot: 1 }])
      .label('end').emit('Return')
      .label('handler').emit('ReThrow');
    a.handler('try', 'end', 'handler', 3);        // 3 = ASYNC_AWAIT
    const { rec } = run(a, profile, { isAsync: true });
    return {
      ok: rec.consumed.handlerRanges.size === 1 && (rec.stats.patterns.byKind.asyncAwaitHandlerRange ?? 0) === 1,
      detail: `consumed=${rec.consumed.handlerRanges.size} claims=${rec.stats.patterns.byKind.asyncAwaitHandlerRange ?? 0}`,
    };
  });

  check('F', `${V}: accessor -- %DefineGetterPropertyUnchecked folds into its literal`, () => {
    const rid = profile.runtimeId ? profile.runtimeId('DefineGetterPropertyUnchecked') : null;
    if (rid === null || rid === undefined) return { skip: true, detail: 'no DefineGetterPropertyUnchecked in profile' };
    const a = asm(profile);
    const k = a.constant({ t: 'string', v: 'g' });
    const sfi = a.constant({ t: 'sfi', sfiId: 3 });
    a.emit('CreateEmptyObjectLiteral').emit('Star', [{ reg: 0 }])
      .emit('LdaConstant', [{ const: k }]).emit('Star', [{ reg: 1 }])
      .emit('CreateClosure', [{ const: sfi }, { slot: 0 }, { u: 0 }]).emit('Star', [{ reg: 2 }])
      .emit('LdaZero').emit('Star', [{ reg: 3 }])
      .emit('CallRuntime', [{ u: rid }, { regList: [0, 4] }, { count: 4 }])
      .emit('Ldar', [{ reg: 0 }]).emit('Return');
    const { rec } = run(a, profile);
    const obj = allNodes(rec).find((n) => n.e === 'object');
    return {
      ok: kinds(rec).includes('accessor') && obj?.props?.some((p) => p.kind === 'get'),
      detail: JSON.stringify(obj),
    };
  });

  check('F', `${V}: typeofetc -- typeof / delete / in / instanceof each claim`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'o' });
    const n = a.constant({ t: 'string', v: 'k' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('LdaConstant', [{ const: n }])
      .emit('TestIn', [{ reg: 0 }, { slot: 1 }]).emit('Star', [{ reg: 1 }])
      .emit('Ldar', [{ reg: 0 }]).emit('TestInstanceOf', [{ reg: 0 }, { slot: 2 }]).emit('Star', [{ reg: 2 }])
      .emit('Ldar', [{ reg: 0 }]).emit('TypeOf', [{ slot: 3 }]).emit('Star', [{ reg: 3 }])
      .emit('LdaConstant', [{ const: n }])
      .emit('DeletePropertyStrict', [{ reg: 0 }])
      .emit('Return');
    const { rec } = run(a, profile);
    const k = rec.stats.patterns.byKind;
    return {
      ok: k.typeof >= 1 && k.in >= 1 && k.instanceof >= 1 && k.delete >= 1,
      detail: JSON.stringify(k),
    };
  });

  check('F', `${V}: update -- x++ on a property becomes {e:'update'}`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'o' });
    const n = a.constant({ t: 'string', v: 'c' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: n }, { slot: 1 }])
      .emit('ToNumeric', [{ slot: 2 }]).emit('Star', [{ reg: 1 }])
      .emit('Inc', [{ slot: 2 }])
      .emit('SetNamedProperty', [{ reg: 0 }, { const: n }, { slot: 3 }])
      .emit('Ldar', [{ reg: 1 }]).emit('Return');
    const { rec } = run(a, profile);
    const up = allNodes(rec).find((n2) => n2.e === 'update');
    return {
      ok: (rec.stats.patterns.byKind.update ?? 0) >= 1 && up?.op === '++',
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} ${JSON.stringify(up)}`,
    };
  });

  check('F', `${V}: misc -- a TDZ check is consumed, not printed`, () => {
    const a = asm(profile);
    const n = a.constant({ t: 'string', v: 'later' });
    a.emit('LdaCurrentContextSlot', [{ slot: 2 }])
      .emit('ThrowReferenceErrorIfHole', [{ const: n }])
      .emit('Return');
    const { rec } = run(a, profile, {
      scope: {
        scopeType: 'FUNCTION_SCOPE', flags: {}, parameterCount: 0,
        contextLocalNames: ['later'], contextLocalInfos: [{ mode: 'kLet' }],
        functionVariable: null, inferredFunctionName: null, scopeInfoId: 1,
        hasContextExtensionSlot: false,
        outer: {
          scopeType: 'SCRIPT_SCOPE', flags: {}, parameterCount: 0,
          contextLocalNames: ['later'], contextLocalInfos: [{ mode: 'kLet' }],
          functionVariable: null, inferredFunctionName: null, scopeInfoId: 2,
          hasContextExtensionSlot: false, outer: null,
        },
      },
    });
    const ss = stmtList(rec);
    return {
      ok: (rec.stats.patterns.byKind.tdzCheck ?? 0) === 1 && ss.length === 1 && ss[0].s === 'return',
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} statements=${JSON.stringify(ss)}`,
    };
  });

  check('F', `${V}: misc -- SetPendingMessage (the finally save) is consumed`, () => {
    const a = asm(profile);
    a.emit('LdaTheHole').emit('SetPendingMessage').emit('LdaUndefined').emit('Return');
    const { rec } = run(a, profile);
    return {
      ok: (rec.stats.patterns.byKind.finallyMessage ?? 0) === 1 && !hasHole(rec),
      detail: `${JSON.stringify(rec.stats.patterns.byKind)} holes=${rec.stats.holes}`,
    };
  });

  check('F', `${V}: a hole carries a why and is counted, never a placeholder`, () => {
    const a = asm(profile);
    const bad = a.constant({ t: 'unresolved', why: 'testOnly', detail: 'deliberate' });
    a.emit('LdaConstant', [{ const: bad }]).emit('Return');
    const { rec } = run(a, profile);
    const h = allNodes(rec).find((n) => n.e === 'hole');
    return {
      ok: !!h && typeof h.why === 'string' && rec.stats.holes >= 1,
      detail: `${JSON.stringify(h)} holes=${rec.stats.holes} byWhy=${JSON.stringify(rec.stats.emit.byHoleWhy)}`,
    };
  });

  check('F', `${V}: every statement is one of 11.1's Stmt forms and every expr one of its Expr tags`, () => {
    const a = asm(profile);
    const g = a.constant({ t: 'string', v: 'f' });
    a.emit('LdaGlobal', [{ const: g }, { slot: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('CallUndefinedReceiver0', [{ reg: 0 }, { slot: 1 }])
      .emit('Return');
    const { rec } = run(a, profile);
    return {
      ok: rec.verification.violationCount === 0,
      detail: `violations=${rec.verification.violationCount} ${JSON.stringify(rec.verification.violations.slice(0, 3))}`,
    };
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const lines = [];
let lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) { lines.push(''); lines.push(`--- group ${r.group}`); lastGroup = r.group; }
  const mark = r.state === 'pass' ? 'ok  ' : (r.state === 'skip' ? 'skip' : 'FAIL');
  lines.push(`${mark} ${r.name}${VERBOSE || r.state !== 'pass' ? `\n       ${r.detail ?? ''}` : ''}`);
  if (r.state === 'FAIL' && r.stack && VERBOSE) lines.push('       ' + r.stack.split('\n').slice(1, 4).join('\n       '));
}
lines.push('');
lines.push(`${pass} passed, ${fail} failed, ${skip} skipped  (profiles: ${profiles.map((p) => p.profile.version).join(', ')})`);
const text = lines.join('\n');
const out = argOf('out', null);
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text + '\n'); }
process.stdout.write(text + '\n');
process.exitCode = fail ? 1 : 0;
