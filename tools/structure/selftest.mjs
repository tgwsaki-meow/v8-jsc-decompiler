// tools/structure/selftest.mjs
//
// Unit-level self-test for src/structure/. No engine, no corpus, both
// profiles.
//
//   A  layering     ARCHITECTURE.md 11.0: src/structure imports neither
//                   src/verify/ nor tools/, holds no version literal, and
//                   compares no opcode by value
//   B  facts        src/structure/facts.mjs is total over BOTH profiles: every
//                   conditional jump has a normalised predicate, every named
//                   opcode exists, and exactly one non-generator switch
//   C  shapes       assembled bytecode (tools/ir/asm.mjs, profile-driven, not
//                   one hardcoded byte) through buildIR and structure(), on
//                   both profiles: while / test-below-the-header while /
//                   do-while / for / if-else chain / jump-table switch /
//                   compare-chain switch / try-catch / try-finally token /
//                   generator dispatcher / await inside a loop / an
//                   irreducible graph that must fall back honestly
//   D  real .jsc    the minted fixtures in tests/t8/fixtures, one named check
//                   per source construct, against the real V8 14.4.258.16
//                   bytecode the corpus is compiled with
//   E  invariants   every shape and every fixture through
//                   src/structure/verify.mjs with 0 violations
//
// The fixtures were minted with the Electron 40 shipped V8 14.4.258.16 (the
// corpus's own version) by `scratch/t8/mint.mjs`, from the sources in
// `corpus/features/`. They are checked in as bytecode so this self-test never
// spawns an engine. Nothing from `extracted_jsc/` is involved.
//
// Usage: node tools/structure/selftest.mjs [--verbose]

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { structure } from '../../src/structure/index.mjs';
import { structureFacts } from '../../src/structure/facts.mjs';
import { summarise, walkRegions } from '../../src/structure/verify.mjs';
import { asm } from '../ir/asm.mjs';

const TAGS = listProfiles();
const FIXTURES = 'tests/t8/fixtures';
const FIXTURE_TAG = '14.4.258.16';
const VERBOSE = process.argv.includes('--verbose');
const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let pass = 0, fail = 0;
const failures = [];
function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) {
    r = { ok: false, detail: `threw: ${e.message} ${String(e.stack).split('\n')[1] ?? ''}` };
  }
  if (r.ok) pass++; else { fail++; failures.push(`${group} / ${name}: ${r.detail ?? ''}`); }
  say(`| ${group} | ${name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${(r.detail ?? '').replace(/\|/g, '\\|').slice(0, 220)} |`);
}

say('# src/structure self-test');
say('');
say(`profiles: ${TAGS.join(', ')}`);
say('');
say('| group | check | result | detail |');
say('|---|---|---|---|');

// =========================================================== A  layering
check('A', 'src/structure imports nothing from src/verify/ or tools/', () => {
  const bad = [];
  for (const f of fs.readdirSync('src/structure')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/structure', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (/(^|\/)verify\/|\btools\//.test(spec) && !spec.endsWith('src/structure/verify.mjs')) {
        bad.push(`${f} -> ${spec}`);
      }
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'only src/ir, src/profile, src/disasm' };
});

check('A', 'every import of src/structure resolves inside the allowed layers', () => {
  const allowed = /^(\.\/|\.\.\/(ir|profile|disasm|listing)\/)/;
  const bad = [];
  for (const f of fs.readdirSync('src/structure')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/structure', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      if (m[1].startsWith('node:')) continue;
      if (!allowed.test(m[1])) bad.push(`${f} -> ${m[1]}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'all imports are ./ or ../{ir,profile,disasm,listing}/' };
});

check('A', 'no version literal, hex literal or 3+-digit number in src/structure', () => {
  const offenders = [];
  for (const f of fs.readdirSync('src/structure')) {
    if (!f.endsWith('.mjs')) continue;
    const stripped = fs.readFileSync(path.join('src/structure', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // a named module-scope budget is allowed: it is a property of this
      // implementation, not of a V8 version
      .replace(/^const [A-Z][A-Z_0-9]* = \d+;$/gm, '');
    const hex = [...stripped.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0]);
    const big = [...stripped.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)].map((m) => m[0]);
    const ver = [...stripped.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
    if (hex.length || big.length || ver.length) {
      offenders.push(`${f}: hex[${hex}] big[${big}] version[${ver}]`);
    }
  }
  return { ok: offenders.length === 0, detail: offenders.length ? offenders.join('; ') : 'clean' };
});

check('A', 'no opcode compared by value, and every named opcode is checked against the profile', () => {
  const bad = [];
  const named = new Set();
  for (const f of fs.readdirSync('src/structure')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/structure', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/opcodeValue\s*[=!]==?\s*(\d+)/g)) bad.push(`${f}: opcodeValue === ${m[1]}`);
    for (const m of src.matchAll(/getOpcode\(\s*(\d+)\s*\)/g)) bad.push(`${f}: getOpcode(${m[1]})`);
    // an opcode name used outside facts.mjs must go through facts.op.*
    if (f !== 'facts.mjs') {
      for (const m of src.matchAll(/'(Lda\w+|Sta\w+|Test\w+|Jump\w*|Call\w+|ForIn\w+|Switch\w+|Suspend\w+|Resume\w+|Create\w+)'/g)) {
        bad.push(`${f}: bare opcode name '${m[1]}'`);
      }
    } else {
      for (const m of src.matchAll(/:\s*'([A-Z]\w+)'/g)) named.add(m[1]);
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.join('; ') : `facts.mjs names ${named.size} opcodes, nothing else names any`,
  };
});

// ============================================================== B  facts
for (const tag of TAGS) {
  check('B', `${tag}: structureFacts is total (predicates, named opcodes, one Smi switch)`, () => {
    const p = loadProfile(path.join('profiles', tag));
    const f = structureFacts(p);                       // throws when not total
    const missing = [];
    for (const v of f.cfg.conditionalJumps) if (!f.predicateOf(v)) missing.push(p.getOpcode(v).name);
    const smi = [...f.cfg.facts.switchRoles.keys()].filter((v) => !f.isGeneratorDispatch(v));
    if (smi.length !== 1) missing.push(`${smi.length} non-generator switch opcodes`);
    const ops = Object.keys(f.op).length;
    return {
      ok: missing.length === 0,
      detail: missing.length ? missing.join(', ')
        : `${f.cfg.conditionalJumps.size} conditional jumps all have a predicate, ${ops} named opcodes present`,
    };
  });
  check('B', `${tag}: canThrow agrees with src/ir/cfg.mjs's own exception-edge test`, () => {
    const p = loadProfile(path.join('profiles', tag));
    const f = structureFacts(p);
    const bad = [];
    for (let v = 0; v < p.opcodeCount; v++) {
      const o = p.getOpcode(v);
      if (!o) continue;
      const s = f.sem.of(o.name);
      const want = !s || !s.effect || s.effect.throws || s.effect.callsUserCode;
      if (f.canThrow(o.name) !== want) bad.push(o.name);
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.join(',') : 'identical on every opcode' };
  });
}

// ============================================================= C  shapes
const FB = { slot: 0 };

/** while (r0 < r1) { r0++ } */
const whileShape = (a) => {
  a.emit('LdaZero').emit('Star', [{ reg: 0 }])
    .label('head')
    .emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 1 }, FB])
    .emit('JumpIfFalse', [{ label: 'done' }])
    .emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
    .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
    .label('done')
    .emit('Ldar', [{ reg: 0 }]).emit('Return');
};

/**
 * The same loop with the whole body inside an ASYNC_AWAIT protected range,
 * which is what an `async` function is. docs/IR.md section 3's leader rule
 * ends a block after every potentially-throwing instruction inside a range,
 * so `TestLessThan` ends the header and the `JumpIfFalse` lands in the block
 * after it -- the shape that made `async-await-in-loop` come out as `forever`
 * with the wrong follow.
 */
const whileSplitShape = (a) => {
  a.emit('LdaZero').emit('Star', [{ reg: 0 }])
    .label('rs')
    .label('head')
    .emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 1 }, FB])
    .emit('JumpIfFalse', [{ label: 'done' }])
    .emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
    .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
    .label('done')
    .emit('LdaUndefined').emit('Star', [{ reg: 2 }])
    .label('re')
    .emit('Ldar', [{ reg: 0 }]).emit('Return')
    .label('h')
    .emit('Star', [{ reg: 3 }]).emit('Ldar', [{ reg: 3 }]).emit('ReThrow');
  a.handler('rs', 're', 'h', 3);                 // ASYNC_AWAIT
};

/**
 * do { g(); r0++ } while (r0 < r1)
 *
 * V8 emits no backward conditional jump -- every loop closes with `JumpLoop`
 * -- so a `do/while` puts the body and the test ahead of the back edge. The
 * call in the body is what stops this from reading as a `while`: the test
 * chain carries a statement, so `while (test)` would drop it.
 */
const doWhileShape = (a) => {
  a.emit('LdaZero').emit('Star', [{ reg: 0 }])
    .label('head')
    .emit('LdaGlobal', [{ const: a.constant({ t: 'string', v: 'g' }) }, FB])
    .emit('Star', [{ reg: 2 }])
    .emit('CallUndefinedReceiver0', [{ reg: 2 }, FB])
    .emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
    .emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 1 }, FB])
    .emit('JumpIfFalse', [{ label: 'done' }])
    .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
    .label('done')
    .emit('Ldar', [{ reg: 0 }]).emit('Return');
};

/** for (;r0 < r1;r0++) { if (r2) continue; r3 = 0 } -- a dedicated update block */
const forShape = (a) => {
  a.emit('LdaZero').emit('Star', [{ reg: 0 }])
    .label('head')
    .emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 1 }, FB])
    .emit('JumpIfFalse', [{ label: 'done' }])
    .emit('Ldar', [{ reg: 2 }])
    .emit('JumpIfToBooleanFalse', [{ label: 'upd' }])
    .emit('LdaZero').emit('Star', [{ reg: 3 }])
    .label('upd')
    .emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
    .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
    .label('done')
    .emit('Ldar', [{ reg: 0 }]).emit('Return');
};

/** if (r0) a else if (r2) b else c */
const ifChainShape = (a) => {
  a.emit('Ldar', [{ reg: 0 }]).emit('JumpIfToBooleanFalse', [{ label: 'e1' }])
    .emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('e1')
    .emit('Ldar', [{ reg: 2 }]).emit('JumpIfToBooleanFalse', [{ label: 'e2' }])
    .emit('LdaSmi', [{ imm: 2 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('e2')
    .emit('LdaSmi', [{ imm: 3 }]).emit('Star', [{ reg: 1 }])
    .label('join')
    .emit('Ldar', [{ reg: 1 }]).emit('Return');
};

/** switch (r0) { case 0..2: ...; default: } as a jump table */
const jumpTableShape = (a) => {
  a.emit('Ldar', [{ reg: 0 }])
    .emit('SwitchOnSmiNoFeedback', [{ table: ['c0', 'c1', 'c2'] }, { u: 3 }, { imm: 0 }])
    .emit('Jump', [{ label: 'dflt' }])
    .label('c0').emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('c1').emit('LdaSmi', [{ imm: 2 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('c2').emit('LdaSmi', [{ imm: 3 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('dflt').emit('LdaZero').emit('Star', [{ reg: 1 }])
    .label('join').emit('Ldar', [{ reg: 1 }]).emit('Return');
};

/**
 * The same `switch` as a compare chain, which ARCHITECTURE.md 9.3 measures as
 * 99.65% of all switches. Note the direction: `JumpIfTrue` to the body, fall
 * through to the next comparison. An `if`/`else if` chain is the other way
 * round, and switches.mjs requires this one.
 */
const compareChainShape = (a) => {
  a.emit('LdaSmi', [{ imm: 1 }]).emit('TestEqualStrict', [{ reg: 0 }, { u: 0 }])
    .emit('JumpIfTrue', [{ label: 'c0' }])
    .emit('LdaSmi', [{ imm: 2 }]).emit('TestEqualStrict', [{ reg: 0 }, { u: 0 }])
    .emit('JumpIfTrue', [{ label: 'c1' }])
    .emit('LdaSmi', [{ imm: 3 }]).emit('TestEqualStrict', [{ reg: 0 }, { u: 0 }])
    .emit('JumpIfTrue', [{ label: 'c2' }])
    .emit('Jump', [{ label: 'dflt' }])
    .label('c0').emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('c1').emit('LdaSmi', [{ imm: 2 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('c2').emit('LdaSmi', [{ imm: 3 }]).emit('Star', [{ reg: 1 }]).emit('Jump', [{ label: 'join' }])
    .label('dflt').emit('LdaZero').emit('Star', [{ reg: 1 }])
    .label('join').emit('Ldar', [{ reg: 1 }]).emit('Return');
};

/** try { f() } catch (e) { r1 = e } */
const tryCatchShape = (a) => {
  a.emit('LdaUndefined').emit('Star', [{ reg: 1 }])
    .label('ts')
    .emit('LdaGlobal', [{ const: a.constant({ t: 'string', v: 'f' }) }, FB])
    .emit('Star', [{ reg: 0 }])
    .emit('CallUndefinedReceiver0', [{ reg: 0 }, FB])
    .label('te')
    .emit('LdaUndefined').emit('Return')
    .label('h')
    .emit('Star', [{ reg: 2 }]).emit('Ldar', [{ reg: 2 }]).emit('Star', [{ reg: 1 }])
    .emit('LdaUndefined').emit('Return');
  a.handler('ts', 'te', 'h', 1);                 // CAUGHT
};

/** try { return } finally { g() } -- the one-command token form, 4.4.5 */
const tryFinallyShape = (a) => {
  a.emit('LdaSmi', [{ imm: -1 }]).emit('Star', [{ reg: 0 }])
    .emit('LdaTheHole').emit('Star', [{ reg: 2 }])
    .label('ts')
    .emit('LdaGlobal', [{ const: a.constant({ t: 'string', v: 'f' }) }, FB])
    .emit('Star', [{ reg: 1 }])
    .emit('CallUndefinedReceiver0', [{ reg: 1 }, FB])
    .emit('LdaZero').emit('Star', [{ reg: 0 }])
    .label('te')
    .emit('Jump', [{ label: 'fin' }])
    .label('h')
    .emit('Star', [{ reg: 2 }]).emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 0 }])
    .label('fin')
    .emit('LdaGlobal', [{ const: a.constant({ t: 'string', v: 'g' }) }, FB])
    .emit('Star', [{ reg: 3 }])
    .emit('CallUndefinedReceiver0', [{ reg: 3 }, FB])
    .emit('LdaZero').emit('TestReferenceEqual', [{ reg: 0 }])
    .emit('JumpIfFalse', [{ label: 'rethrow' }])
    .emit('LdaUndefined').emit('Return')
    .label('rethrow')
    .emit('Ldar', [{ reg: 2 }]).emit('ReThrow');
  a.handler('ts', 'te', 'h', 0);                 // UNCAUGHT: finally only
};

/** BuildSuspendPoint twice: the resume dispatcher plus two suspend points */
const generatorShape = (a) => {
  a.emit('SwitchOnGeneratorState', [{ reg: 0 }, { table: ['resume0', 'resume1'] }, { u: 2 }])
    .emit('LdaUndefined').emit('Star', [{ reg: 1 }])
    .emit('SuspendGenerator', [{ reg: 0 }, { regList: [1, 2] }, { count: 2 }, { u: 0 }])
    .label('resume0')
    .emit('ResumeGenerator', [{ reg: 0 }, { regList: [1, 2] }, { count: 2 }])
    .emit('Star', [{ reg: 3 }])
    .emit('Ldar', [{ reg: 3 }])
    .emit('JumpIfToBooleanFalse', [{ label: 'cont' }])
    .emit('SuspendGenerator', [{ reg: 0 }, { regList: [1, 2] }, { count: 2 }, { u: 1 }])
    .label('resume1')
    .emit('ResumeGenerator', [{ reg: 0 }, { regList: [1, 2] }, { count: 2 }])
    .emit('Star', [{ reg: 3 }])
    .label('cont')
    .emit('Ldar', [{ reg: 3 }])
    .emit('Return');
};

/**
 * `await` inside a loop: the dispatcher jumps into the middle of the loop
 * body, which is ARCHITECTURE.md 10.1's irreducible shape, and the loop's back
 * edge only exists once the suspend is spliced to its resume. Both of T8's
 * stage-1 obligations in one function.
 */
const awaitInLoopShape = (a) => {
  a.emit('SwitchOnGeneratorState', [{ reg: 0 }, { table: ['resume0'] }, { u: 1 }])
    .emit('LdaZero').emit('Star', [{ reg: 1 }])
    .label('head')
    .emit('Ldar', [{ reg: 1 }]).emit('TestLessThan', [{ reg: 2 }, FB])
    .emit('JumpIfFalse', [{ label: 'done' }])
    .emit('LdaUndefined').emit('Star', [{ reg: 3 }])
    .emit('SuspendGenerator', [{ reg: 0 }, { regList: [1, 3] }, { count: 3 }, { u: 0 }])
    .label('resume0')
    .emit('ResumeGenerator', [{ reg: 0 }, { regList: [1, 3] }, { count: 3 }])
    .emit('Star', [{ reg: 4 }])
    .emit('Ldar', [{ reg: 1 }]).emit('Inc', [FB]).emit('Star', [{ reg: 1 }])
    .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
    .label('done')
    .emit('Ldar', [{ reg: 1 }]).emit('Return');
};

/**
 * Two entries into one cycle with no dispatcher to remove: genuinely
 * irreducible, so the honest fall-back (4.4.7) is the right answer and the
 * self-test asserts it is taken AND counted.
 */
const irreducibleShape = (a) => {
  a.emit('Ldar', [{ reg: 0 }]).emit('JumpIfToBooleanFalse', [{ label: 'b' }])
    .label('aa')
    .emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 1 }])
    .emit('Jump', [{ label: 'b' }])
    .label('b')
    .emit('LdaSmi', [{ imm: 2 }]).emit('Star', [{ reg: 2 }])
    .emit('Ldar', [{ reg: 3 }]).emit('JumpIfToBooleanFalse', [{ label: 'out' }])
    .emit('JumpLoop', [{ label: 'aa' }, { imm: 0 }, FB])
    .label('out')
    .emit('Ldar', [{ reg: 1 }]).emit('Return');
};

function structured(profile, buildFn, unitExtra = {}) {
  const a = asm(profile);
  buildFn(a);
  const { unit } = a.build(unitExtra);
  const ir = buildIR(unit, { profile, scopeInfoById: null });
  return { ir, sf: structure(ir, { profile }) };
}

/** Every reachable, non-removed block exactly once (11.3 invariant 1). */
function coverage(sf) {
  const v = sf.verification.checks[0];
  return v.violations === 0 ? null : `coverage: ${v.violations} (${JSON.stringify(v.samples)})`;
}
function violations(sf) {
  return sf.verification.checks.filter((c) => c.violations)
    .map((c) => `${c.name}=${c.violations}`).join(', ');
}
const loopsOf = (sf) => summarise(sf).loopForms;
function regionKinds(sf) {
  const seen = {};
  walkRegions(sf.root, (r) => { seen[r.r] = (seen[r.r] ?? 0) + 1; });
  return seen;
}

const SHAPES = [
  ['while: the test is in the header, follow is the block after the loop', whileShape, { registerCount: 4 },
    ({ sf }) => {
      const lp = [...sf.loopPlans.values()][0];
      if (!lp) return 'no loop plan';
      if (lp.form !== 'while') return `form ${lp.form}`;
      if (lp.testBlock !== lp.header) return `test in B${lp.testBlock}, header B${lp.header}`;
      if (loopsOf(sf).while !== 1) return `loop forms ${JSON.stringify(loopsOf(sf))}`;
      return null;
    }],
  ['while whose test the leader rule split off the header (the async shape)', whileSplitShape, { registerCount: 5 },
    ({ sf }) => {
      const lp = [...sf.loopPlans.values()][0];
      if (!lp) return 'no loop plan';
      if (lp.form !== 'while') return `form ${lp.form} (the defect: it came out as forever)`;
      if (lp.testBlock === lp.header) return 'the test did not land in a separate block; the fixture is wrong';
      if (lp.testChain.length !== 2) return `test chain ${JSON.stringify(lp.testChain)}`;
      if (!sf.removed.loopTestBlocks.some((t) => t.block === lp.header)) return 'the header was not accounted for';
      if (sf.stats.asyncHandlerRanges !== 1) return `${sf.stats.asyncHandlerRanges} async ranges`;
      if (sf.stats.tryRegions !== 0) return `${sf.stats.tryRegions} try regions for an ASYNC_AWAIT range`;
      return null;
    }],
  ['do-while: the body is ahead of the test and the latch is only the JumpLoop', doWhileShape,
    { registerCount: 4 },
    ({ sf }) => {
      const lp = [...sf.loopPlans.values()][0];
      if (!lp) return 'no loop plan';
      if (lp.form !== 'doWhile') return `form ${lp.form}`;
      if (!lp.testAtHeader) return 'the test was not read as part of the body';
      if (loopsOf(sf).doWhile !== 1) return `loop forms ${JSON.stringify(loopsOf(sf))}`;
      return null;
    }],
  ['for: the latch is a dedicated continue target with two in-body predecessors', forShape,
    { registerCount: 5 },
    ({ sf }) => {
      const lp = [...sf.loopPlans.values()][0];
      if (!lp) return 'no loop plan';
      if (lp.form !== 'for') return `form ${lp.form}`;
      if (lp.updateBlock === null) return 'no update block';
      if (lp.continueTarget !== lp.updateBlock) return 'continue target is not the update block';
      let update = null;
      walkRegions(sf.root, (r) => { if (r.r === 'loop') update = r.update; });
      if (update === null) return 'the loop region carries no update';
      return null;
    }],
  ['if / else if / else: nested ifs, one join, nothing unstructured', ifChainShape, { registerCount: 4 },
    ({ sf }) => {
      const k = regionKinds(sf);
      if (k.if !== 2) return `${k.if} if regions, expected 2`;
      if (k.unstructured) return 'fell back';
      return null;
    }],
  ['switch as a jump table: one switch region, every case a body', jumpTableShape, { registerCount: 3 },
    ({ sf }) => {
      const forms = summarise(sf).switchForms;
      if (forms.jumpTable !== 1) return `switch forms ${JSON.stringify(forms)}`;
      let cases = 0;
      walkRegions(sf.root, (r) => { if (r.r === 'switch') cases = r.cases.length; });
      if (cases < 3) return `${cases} cases`;
      return null;
    }],
  ['switch as a compare chain (9.3: 99.65% of real switches)', compareChainShape, { registerCount: 3 },
    ({ sf }) => {
      const forms = summarise(sf).switchForms;
      if (forms.compareChain !== 1) return `switch forms ${JSON.stringify(forms)}`;
      let disc = null, cases = 0;
      walkRegions(sf.root, (r) => { if (r.r === 'switch') { disc = r.disc; cases = r.cases.length; } });
      if (cases < 3) return `${cases} cases`;
      if (disc === null || disc.value === null) return 'no discriminant value';
      return null;
    }],
  ['try / catch: one try region, the caught value is the catch parameter', tryCatchShape, { registerCount: 4 },
    ({ sf }) => {
      let tries = 0, param = null;
      walkRegions(sf.root, (r) => { if (r.r === 'try') { tries++; param = r.param; } });
      if (tries !== 1) return `${tries} try regions`;
      if (!param || param.value === null || param.value === undefined) return 'no catch parameter';
      if (sf.stats.tryByPrediction.CAUGHT !== 1) return `by prediction ${JSON.stringify(sf.stats.tryByPrediction)}`;
      return null;
    }],
  ['try / finally: the one-command token form is recognised (4.4.5 misses it)', tryFinallyShape, { registerCount: 5 },
    ({ sf }) => {
      if (sf.finallyShapes.size !== 1) return `${sf.finallyShapes.size} finally shapes`;
      const shape = [...sf.finallyShapes.values()][0];
      if (shape.dispatchKind !== 'referenceEqual') return `dispatch kind ${shape.dispatchKind}`;
      if (sf.stats.tryByPrediction.UNCAUGHT !== 1) return `by prediction ${JSON.stringify(sf.stats.tryByPrediction)}`;
      return null;
    }],
  ['generator: the resume dispatcher is deleted and each suspend spliced', generatorShape,
    { registerCount: 5, incomingNewTargetOrGeneratorRegister: 0 },
    ({ sf }) => {
      if (sf.stats.dispatchers !== 1) return `${sf.stats.dispatchers} dispatchers`;
      if (sf.stats.dispatcherBlocksRemoved !== 1) return 'the dispatcher block was not removed';
      if (sf.stats.resumeEdgesRemoved !== 2) return `${sf.stats.resumeEdgesRemoved} resume edges removed`;
      if (sf.stats.splices !== 2) return `${sf.stats.splices} splices`;
      if (sf.stats.irreducibleAfterRemoval !== 0) return 'irreducible after removal';
      if (summarise(sf).switchForms.jumpTable) return 'the dispatcher came out as a switch statement';
      return null;
    }],
  // 10.1's second half: the IR graph of this function has NO back edge, because
  // the body ends in `SuspendGenerator` and that instruction returns. The loop
  // exists only once the suspend is spliced to its resume, which is why "back
  // edge count equals JumpLoop count" is false over the corpus (259 forward
  // edges in 243 functions) and why the splice is not optional.
  ['await inside a loop: the loop only exists after the suspend is spliced (10.1)', awaitInLoopShape,
    { registerCount: 6, incomingNewTargetOrGeneratorRegister: 0 },
    ({ ir, sf }) => {
      if (ir.loopInfo.backEdges.length !== 0) {
        return `the IR already has ${ir.loopInfo.backEdges.length} back edges, so the fixture does not test the splice`;
      }
      if (sf.stats.splices !== 1) return `${sf.stats.splices} splices`;
      if (sf.stats.loopsFound !== 1) return `${sf.stats.loopsFound} loops after the splice`;
      if (sf.stats.irreducibleAfterRemoval !== 0) {
        return `${sf.stats.irreducibleAfterRemoval} irreducible edges after removal`;
      }
      const forms = loopsOf(sf);
      if (!forms.while) return `loop forms ${JSON.stringify(forms)}`;
      if (sf.stats.jumpLoopsInLoop !== sf.stats.jumpLoops) {
        return `${sf.stats.jumpLoopsInLoop}/${sf.stats.jumpLoops} JumpLoops became a loop statement`;
      }
      return null;
    }],
  ['irreducible with no dispatcher: falls back honestly and counts it (4.4.7)', irreducibleShape,
    { registerCount: 5 },
    ({ sf }) => {
      if (sf.stats.irreducibleAfterRemoval === 0) return 'the fixture is not irreducible; it does not test the fall-back';
      if (sf.stats.unstructuredRegions !== 1) return `${sf.stats.unstructuredRegions} unstructured regions`;
      if (!sf.unstructured[0].why) return 'the unstructured region carries no reason';
      if (!sf.unstructured[0].dispatchVar) return 'no dispatch variable for the fall-back';
      return null;
    }],
];

for (const tag of TAGS) {
  const profile = loadProfile(path.join('profiles', tag));
  for (const [name, shape, extra, assertFn] of SHAPES) {
    check('C', `${tag}: ${name}`, () => {
      const r = structured(profile, shape, extra);
      const bad = assertFn(r);
      const cov = coverage(r.sf);
      if (bad || cov) return { ok: false, detail: [bad, cov].filter(Boolean).join('; ') };
      return { ok: true, detail: `${r.sf.stats.reachableBlocks} blocks, ${r.sf.stats.regions} regions` };
    });
  }
}

// =========================================================== D  real .jsc
//
// One named check per source construct, against real V8 bytecode.

const fixtureCache = new Map();
function fixture(name, unitIndex = 2) {
  const key = `${name}#${unitIndex}`;
  if (fixtureCache.has(key)) return fixtureCache.get(key);
  const { units, profile, scopeInfoById } = loadUnits(
    path.join(FIXTURES, `${name}.jsc`), path.join('profiles', FIXTURE_TAG),
  );
  const u = units[unitIndex];
  if (!u || !u.bytecode) throw new Error(`${name}: no unit ${unitIndex}`);
  const ir = buildIR(u, { profile, scopeInfoById });
  const sf = structure(ir, { profile });
  const r = { ir, sf, unit: u };
  fixtureCache.set(key, r);
  return r;
}

const onlyLoop = (sf) => [...sf.loopPlans.values()][0] ?? null;

const REAL = [
  ['while', 'loop-while', ({ sf }) => {
    const lp = onlyLoop(sf);
    if (lp?.form !== 'while') return `form ${lp?.form}`;
    if (!loopsOf(sf).while) return `forms ${JSON.stringify(loopsOf(sf))}`;
    return null;
  }],
  ['do-while', 'loop-do-while', ({ sf }) => {
    const lp = onlyLoop(sf);
    if (lp?.form !== 'doWhile') return `form ${lp?.form}`;
    // V8 puts the body AND the test in the header and leaves the latch holding
    // only the JumpLoop, so the test block IS the header here
    if (!lp.testAtHeader) return 'expected the header-resident do/while shape';
    return null;
  }],
  ['for (3-clause)', 'loop-for-3clause', ({ sf }) => {
    const lp = onlyLoop(sf);
    if (lp === null) return 'no loop';
    if (lp.form !== 'while' && lp.form !== 'for') return `form ${lp.form}`;
    return null;
  }],
  ['for-in', 'loop-for-in', ({ sf }) => {
    const lp = onlyLoop(sf);
    if (lp === null) return 'no loop';
    if (lp.idiom?.kind !== 'forIn') return `idiom ${lp.idiom?.kind}`;
    if (lp.idiom.confidence !== 'exact') return `confidence ${lp.idiom.confidence}`;
    return null;
  }],
  ['for-of', 'loop-for-of', ({ sf }) => {
    const lp = onlyLoop(sf);
    if (lp === null) return 'no loop';
    if (sf.stats.tryRegions !== 2) return `${sf.stats.tryRegions} try regions (the implicit iterator close)`;
    if (sf.stats.fellBack) return `fell back: ${sf.stats.fellBackWhy}`;
    return null;
  }],
  ['for-of with break', 'loop-for-of-break', ({ sf }) => {
    if (sf.stats.fellBack) return `fell back: ${sf.stats.fellBackWhy}`;
    if (!regionKinds(sf).break) return 'no break emitted';
    return null;
  }],
  // `continue` in the source does not have to become `{r:'continue'}`: V8 gives
  // the loop a separate continue target, and when every path reaches it by
  // falling through, the structured form needs no statement at all. What must
  // hold is that the target is the loop's continue target and the body is still
  // inside the loop.
  ['while with continue', 'loop-while-continue', ({ sf }) => {
    const k = regionKinds(sf);
    if (!k.loop) return 'no loop region';
    const lp = onlyLoop(sf);
    if (lp.form !== 'for') return `form ${lp.form} (V8 gives a continue its own target block)`;
    if (lp.continueTarget !== lp.updateBlock) return 'the continue target is not the update block';
    if (!k.if) return 'the conditional continue did not become an if';
    return null;
  }],
  ['nested loops', 'loop-nested', ({ sf }) => {
    if (sf.stats.loopsFound !== 2) return `${sf.stats.loopsFound} loops`;
    const forms = loopsOf(sf);
    if ((forms.while ?? 0) !== 2) return `forms ${JSON.stringify(forms)}`;
    let depth = 0, max = 0;
    walkRegions(sf.root, (r, p) => {
      if (r.r !== 'loop') return;
      depth = p.filter((x) => x.r === 'loop').length + 1;
      if (depth > max) max = depth;
    });
    if (max !== 2) return `max loop nesting ${max}`;
    return null;
  }],
  ['labelled break', 'label-break', ({ sf }) => {
    if (!regionKinds(sf).break) return 'no break';
    if (sf.stats.fellBack) return `fell back: ${sf.stats.fellBackWhy}`;
    return null;
  }],
  ['labelled break out of two loops', 'label-break-multi', ({ sf }) => {
    const k = regionKinds(sf);
    if (!k.break) return 'no break';
    let labelled = 0;
    walkRegions(sf.root, (r) => { if (r.r === 'break' && r.label) labelled++; });
    if (!labelled) return 'no labelled break for the outer loop';
    if (!sf.labels.length) return 'no label declared';
    return null;
  }],
  ['labelled continue', 'label-continue', ({ sf }) => {
    if (!regionKinds(sf).loop) return 'no loop';
    if (sf.stats.fellBack) return `fell back: ${sf.stats.fellBackWhy}`;
    return null;
  }],
  ['labelled continue across three loops', 'label-continue-multi', ({ sf }) => {
    if (sf.stats.loopsFound !== 3) return `${sf.stats.loopsFound} loops`;
    let labelled = 0;
    walkRegions(sf.root, (r) => { if ((r.r === 'break' || r.r === 'continue') && r.label) labelled++; });
    if (!labelled) return 'nothing labelled across three nested loops';
    return null;
  }],
  ['switch with a jump table (dense Smi cases)', 'switch-dense', ({ sf }) => {
    const forms = summarise(sf).switchForms;
    if (forms.jumpTable !== 1) return `forms ${JSON.stringify(forms)}`;
    let guards = 0;
    walkRegions(sf.root, (r) => { if (r.r === 'switch') guards = r.guardBlocks.length; });
    if (!guards) return 'the typeof/range guard chain in front of the table was not reported';
    return null;
  }],
  ['switch as a compare chain (sparse cases)', 'switch-sparse', ({ sf }) => {
    const forms = summarise(sf).switchForms;
    if (forms.compareChain !== 1) return `forms ${JSON.stringify(forms)}`;
    return null;
  }],
  ['switch on strings is a compare chain', 'switch-string', ({ sf }) => {
    const forms = summarise(sf).switchForms;
    if (forms.compareChain !== 1) return `forms ${JSON.stringify(forms)}`;
    return null;
  }],
  ['switch with fall-through between cases', 'switch-fallthrough', ({ sf }) => {
    let empty = 0, cases = 0;
    walkRegions(sf.root, (r) => {
      if (r.r !== 'switch') return;
      cases = r.cases.length;
      for (const c of r.cases) if (c.body.r === 'seq' && c.body.body.length === 0) empty++;
    });
    if (cases < 3) return `${cases} cases`;
    return null;
  }],
  ['switch with default in the middle', 'switch-default-middle', ({ sf }) => {
    let hasDefault = false;
    walkRegions(sf.root, (r) => {
      if (r.r !== 'switch') return;
      for (const c of r.cases) if (c.isDefault) hasDefault = true;
    });
    if (!hasDefault) return 'no default case';
    return null;
  }],
  ['switch with no default', 'switch-no-default', ({ sf }) => {
    const forms = summarise(sf).switchForms;
    if (!forms.compareChain && !forms.jumpTable) return `forms ${JSON.stringify(forms)}`;
    return null;
  }],
  ['try / catch', 'try-catch', ({ sf }) => {
    if (sf.stats.tryRegions !== 1) return `${sf.stats.tryRegions} try regions`;
    if (sf.stats.tryByPrediction.CAUGHT !== 1) return `by prediction ${JSON.stringify(sf.stats.tryByPrediction)}`;
    return null;
  }],
  ['try / finally', 'try-finally', ({ sf }) => {
    if (sf.stats.tryRegions !== 1) return `${sf.stats.tryRegions} try regions`;
    if (sf.finallyShapes.size !== 1) return 'the finally token shape was not recognised';
    return null;
  }],
  ['try / catch / finally', 'try-catch-finally', ({ sf }) => {
    if (sf.stats.tryRegions !== 2) return `${sf.stats.tryRegions} try regions (finally wraps catch)`;
    const byPred = sf.stats.tryByPrediction;
    if (byPred.CAUGHT !== 1 || byPred.UNCAUGHT !== 1) return `by prediction ${JSON.stringify(byPred)}`;
    return null;
  }],
  ['nested try, four deep', 'try-nested', ({ sf }) => {
    if (sf.stats.tryRegions !== 4) return `${sf.stats.tryRegions} try regions`;
    let max = 0;
    walkRegions(sf.root, (r, p) => {
      if (r.r !== 'try') return;
      const d = p.filter((x) => x.r === 'try').length + 1;
      if (d > max) max = d;
    });
    if (max !== 4) return `max try nesting ${max}`;
    return null;
  }],
  ['async function', 'async-function', ({ sf }) => {
    if (sf.stats.dispatcherBlocksRemoved !== 1) return 'the resume dispatcher was not removed';
    if (sf.stats.asyncHandlerRanges === 0) return 'no ASYNC_AWAIT range found';
    if (sf.stats.tryRegions !== 0) return `${sf.stats.tryRegions} try regions for an await desugaring`;
    if (sf.stats.irreducibleAfterRemoval !== 0) return 'irreducible after removal';
    return null;
  }],
  ['await inside a loop', 'async-await-in-loop', ({ sf }) => {
    if (sf.stats.loopsFound !== 2) return `${sf.stats.loopsFound} loops`;
    const forms = loopsOf(sf);
    if ((forms.while ?? 0) !== 2) return `forms ${JSON.stringify(forms)}`;
    if (sf.stats.testBelowHeader !== 2) return `${sf.stats.testBelowHeader} tests below the header`;
    if (sf.stats.irBackEdgesInLoop !== sf.stats.irBackEdges) {
      return `${sf.stats.irBackEdgesInLoop}/${sf.stats.irBackEdges} back edges became a loop`;
    }
    if (sf.stats.tryRegions !== 0) return `${sf.stats.tryRegions} try regions for an await desugaring`;
    return null;
  }],
];

for (const [name, file, assertFn] of REAL) {
  check('D', `${name} (${file}.jsc)`, () => {
    const r = fixture(file);
    const bad = assertFn(r);
    const cov = coverage(r.sf);
    if (bad || cov) return { ok: false, detail: [bad, cov].filter(Boolean).join('; ') };
    return {
      ok: true,
      detail: `${r.sf.stats.reachableBlocks} blocks, ${r.sf.stats.regions} regions, `
        + `loops=${JSON.stringify(loopsOf(r.sf))}, try=${r.sf.stats.tryRegions}`,
    };
  });
}

// ======================================================== E  invariants
check('E', 'every fixture: 0 invariant violations and nothing unstructured', () => {
  const bad = [];
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jsc')).sort();
  let units = 0, fellBack = 0;
  for (const f of files) {
    const { units: us, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of us) {
      if (!u.bytecode) continue;
      units++;
      const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
      const v = violations(sf);
      if (v) bad.push(`${f}#${u.bytecodeId}: ${v}`);
      if (sf.stats.fellBack) { fellBack++; bad.push(`${f}#${u.bytecodeId}: fell back (${sf.stats.fellBackWhy})`); }
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.slice(0, 4).join('; ') : `${files.length} files, ${units} functions, 0 violations, ${fellBack} fall-backs`,
  };
});

check('E', 'every fixture: no try region for an ASYNC_AWAIT range (11.2 constraint 3)', () => {
  const bad = [];
  let ranges = 0, asyncRanges = 0, tries = 0;
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.jsc')).sort()) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of units) {
      if (!u.bytecode) continue;
      const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
      ranges += sf.stats.handlerRanges;
      asyncRanges += sf.stats.asyncHandlerRanges;
      tries += sf.stats.tryRegions;
      const n = sf.stats.tryByPrediction.ASYNC_AWAIT ?? 0;
      if (n) bad.push(`${f}#${u.bytecodeId}: ${n}`);
      for (const [i] of sf.tryPlans) {
        if (sf.removed.asyncHandlerRanges.includes(i)) bad.push(`${f}#${u.bytecodeId}: range ${i} planned as a try`);
      }
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.slice(0, 4).join('; ')
      : `${ranges} ranges, ${asyncRanges} ASYNC_AWAIT, ${tries} try regions, 0 of them async`,
  };
});

check('E', 'every fixture: the structuring graph is reducible after stage 1', () => {
  const bad = [];
  let before = 0, after = 0;
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.jsc')).sort()) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of units) {
      if (!u.bytecode) continue;
      const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
      before += sf.stats.irreducibleBeforeRemoval;
      after += sf.stats.irreducibleAfterRemoval;
      if (sf.stats.irreducibleAfterRemoval) bad.push(`${f}#${u.bytecodeId}`);
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.join(', ') : `${before} irreducible edges before stage 1, ${after} after`,
  };
});

check('E', 'a single-block function is one {r:block} leaf (10.6: 55.13% of the corpus)', () => {
  const bad = [];
  let single = 0, trivial = 0;
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.jsc')).sort()) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of units) {
      if (!u.bytecode) continue;
      const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
      if (sf.stats.singleBlockFunction) {
        single++;
        if (sf.stats.singleBlockTrivial) trivial++;
        else bad.push(`${f}#${u.bytecodeId}: root is ${sf.root?.r}`);
      }
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join('; ') : `${trivial}/${single} single-block functions are one leaf` };
});

check('E', 'structure() is deterministic: two runs give the same tree and the same labels', () => {
  const bad = [];
  for (const f of ['async-await-in-loop', 'try-nested', 'loop-for-of-break', 'switch-dense', 'label-break-multi']) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, `${f}.jsc`), path.join('profiles', FIXTURE_TAG),
    );
    const render = () => {
      const out = [];
      for (const u of units) {
        if (!u.bytecode) continue;
        const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
        walkRegions(sf.root, (r) => out.push(`${r.r}:${r.id ?? r.header ?? r.label ?? r.handlerIndex ?? ''}`));
        out.push(sf.labels.map((l) => l.id).join(','));
      }
      return out.join('|');
    };
    if (render() !== render()) bad.push(f);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(', ') : '5 files, identical on a second run' };
});

check('E', 'every Test names an SSA value of the function, or says it has none', () => {
  const bad = [];
  let tests = 0;
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.jsc')).sort()) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of units) {
      if (!u.bytecode) continue;
      const ir = buildIR(u, { profile, scopeInfoById });
      const sf = structure(ir, { profile });
      for (const t of summarise(sf).tests) {
        if (!t) continue;
        tests++;
        if (t.value === null || t.value === undefined) {
          if (!t.valueless && t.predicate !== 'value') bad.push(`${f}#${u.bytecodeId}: null value, predicate ${t.predicate}`);
          continue;
        }
        if (!ir.values[t.value]) bad.push(`${f}#${u.bytecodeId}: v${t.value} is not a value`);
        if (!t.predicate) bad.push(`${f}#${u.bytecodeId}: no predicate`);
      }
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join('; ') : `${tests} Tests, all resolvable` };
});

check('E', 'no region carries an expression (11.2: T8 only names SSA values)', () => {
  const bad = [];
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.jsc')).sort()) {
    const { units, profile, scopeInfoById } = loadUnits(
      path.join(FIXTURES, f), path.join('profiles', FIXTURE_TAG),
    );
    for (const u of units) {
      if (!u.bytecode) continue;
      const sf = structure(buildIR(u, { profile, scopeInfoById }), { profile });
      walkRegions(sf.root, (r) => {
        const json = JSON.stringify(r, (k, v) => (k === 'body' || k === 'then' || k === 'else'
          || k === 'cases' || k === 'block' || k === 'handler' || k === 'update' ? undefined : v));
        if (/"e"\s*:/.test(json) || /"s"\s*:/.test(json)) bad.push(`${f}#${u.bytecodeId}: ${r.r}`);
      });
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join('; ') : 'no Expr or Stmt anywhere in a region tree' };
});

// ================================================================= totals
say('');
say(`**${pass} passed, ${fail} failed**`);
if (fail) {
  say('');
  say('## Failures');
  say('');
  for (const f of failures) say(`* ${f}`);
}
fs.mkdirSync('scratch/t8', { recursive: true });
fs.writeFileSync('scratch/t8/SELFTEST.md', `${L.join('\n')}\n`);
if (VERBOSE) process.stderr.write(`wrote scratch/t8/SELFTEST.md\n`);
process.exitCode = fail ? 1 : 0;
