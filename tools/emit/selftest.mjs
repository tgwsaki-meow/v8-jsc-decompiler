// tools/emit/selftest.mjs
//
// Unit-level self-test for src/emit/. No engine, no corpus, both profiles.
//
//   A  layering     ARCHITECTURE.md 11.0: src/emit imports neither
//                   src/verify/ nor tools/, holds no version literal, builds a
//                   real AST (no @babel/parser, which is a devDependency), and
//                   exports the 11.4 entry point pipeline.mjs looks for
//   B  closed sets  every tag T7 can produce has a branch, every region kind
//                   11.2 names has a branch, every branch predicate T8 can
//                   put on a Test has a rendering, and `ctx` is unreachable
//   C  shapes       assembled bytecode (tools/ir/asm.mjs, profile-driven, not
//                   one hardcoded byte) through buildIR + recover + structure
//                   + emit, on BOTH profiles: straight line, if/else, while,
//                   try/catch, jump-table switch, the nullish and JSReceiver
//                   predicates, throw
//   D  fixtures     the 24 minted .jsc in tests/t8/fixtures, one named check
//                   per source construct, each asserting that the construct
//                   round-trips to plausible source and that the text parses
//   E  invariants   11.3's six invariants over every shape and every fixture
//                   with 0 violations, `ctx` 0 times, and the two renderings
//                   ARCHITECTURE.md 7 requires: the hole and the
//                   `while (true) switch (__pc)` fall-back
//
// Parsing the output is a PRECONDITION here, not a result: ARCHITECTURE.md 5
// retired output parseability as a progress metric because it was 100% while
// the output was nonsense. It is checked because a non-parsing output cannot
// be measured by anything else, not because it means the decompiler works.
//
// Usage: node tools/emit/selftest.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover, EXPR_TAGS } from '../../src/recover/index.mjs';
import { structure } from '../../src/structure/index.mjs';
import { PREDICATE_KINDS } from '../../src/structure/facts.mjs';
import { unstructuredRegion } from '../../src/structure/fallback.mjs';
import { emit } from '../../src/emit/index.mjs';
import { decompile, decompileFile, V8Decompiler } from '../../src/emit/decompile.mjs';
import { sanitise } from '../../src/emit/names.mjs';
import { SCOPE_REFUSAL_WHY } from '../../src/emit/scopes.mjs';
import { walkAst } from '../../src/emit/verify.mjs';
import { EMIT_HOLE_WHY } from '../../src/emit/holes.mjs';
import { staticOrder } from '../../src/emit/expr.mjs';
import { ORDER_REFUSALS } from '../../src/recover/patterns/literals.mjs';
import { asm } from '../ir/asm.mjs';

const TAGS = listProfiles();
const FIXTURES = 'tests/t8/fixtures';
const FIXTURE_TAG = path.join('profiles', '14.4.258.16');
const VERBOSE = process.argv.includes('--verbose');
const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let pass = 0;
let fail = 0;
const failures = [];

function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) {
    r = { ok: false, detail: `threw: ${e.message} ${String(e.stack).split('\n')[1] ?? ''}` };
  }
  if (r.ok) pass++; else { fail++; failures.push(`${group} / ${name}: ${r.detail ?? ''}`); }
  say(`| ${group} | ${name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${(r.detail ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`);
}

const profiles = TAGS.map((t) => ({ tag: t, dir: path.join('profiles', t), profile: loadProfile(path.join('profiles', t)) }));

/** Assembled unit -> the whole back end, in one call. */
function run(a, profile, unitExtra = {}) {
  const { unit } = a.build(unitExtra);
  const ir = buildIR(unit, { profile });
  const rec = recover(ir);
  const sf = structure(ir, { profile, verify: true });
  const out = emit([rec], [sf], { file: 'selftest.jsc', units: [unit], verify: true });
  return { unit, ir, rec, sf, out };
}

const violationsOf = (out) => out.report.invariants.violations
  - (out.report.invariants.byInvariant['3c. no local name is read without ever being written'] ?? 0);

function parses(code) {
  try { parse(code, { sourceType: 'script', errorRecovery: false }); return null; }
  catch (e) { return e.message; }
}

say('# src/emit self-test');
say('');
say(`profiles: ${TAGS.join(', ')}`);
say('');
say('| group | check | result | detail |');
say('|---|---|---|---|');

// ============================================================ A  layering
check('A', 'src/emit imports nothing from src/verify/ or tools/', () => {
  const bad = [];
  for (const f of fs.readdirSync('src/emit')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/emit', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (/(^|\/)\.\.\/verify\//.test(spec) || /\btools\//.test(spec)) bad.push(`${f} -> ${spec}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'no import of src/verify/ or tools/' };
});

check('A', 'every import of src/emit resolves inside the allowed layers', () => {
  const allowed = /^(\.\/|\.\.\/(ir|structure|recover|load|profile|disasm|listing)\/|@babel\/(types|generator)$|node:)/;
  const bad = [];
  for (const f of fs.readdirSync('src/emit')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/emit', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      if (!allowed.test(m[1])) bad.push(`${f} -> ${m[1]}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : '@babel/{types,generator}, node:, and ../{ir,structure,recover,load}/' };
});

check('A', 'src/emit does not import @babel/parser (a devDependency)', () => {
  const bad = [];
  for (const f of fs.readdirSync('src/emit')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/emit', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      if (/@babel\/(parser|traverse)/.test(m[1])) bad.push(`${f} -> ${m[1]}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(', ') : 'only @babel/types and @babel/generator' };
});

check('A', 'no version literal, hex literal or 3+-digit number in src/emit', () => {
  const offenders = [];
  for (const f of fs.readdirSync('src/emit')) {
    if (!f.endsWith('.mjs')) continue;
    const stripped = fs.readFileSync(path.join('src/emit', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^const [A-Z][A-Z_0-9]* = \d+;$/gm, '');
    const hex = [...stripped.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0]);
    const big = [...stripped.matchAll(/(?<![\w.$])\d{3,}(?![\w.])/g)].map((m) => m[0]);
    const ver = [...stripped.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
    if (hex.length || big.length || ver.length) offenders.push(`${f}: ${[...hex, ...big, ...ver].join(' ')}`);
  }
  return { ok: offenders.length === 0, detail: offenders.length ? offenders.join('; ') : 'emission is version-independent' };
});

check('A', 'decompile.mjs exports the names src/verify/pipeline.mjs accepts', () => {
  const have = [typeof decompile, typeof decompileFile, typeof V8Decompiler];
  const ok = have.every((t) => t === 'function');
  const d = new V8Decompiler();
  return {
    ok: ok && typeof d.decompileFile === 'function' && typeof d.deserializer?.deserializeFile === 'function',
    detail: `decompile/decompileFile/V8Decompiler: ${have.join(',')}; V8Decompiler has decompileFile + deserializer.deserializeFile`,
  };
});

// ========================================================= B  closed sets
check('B', 'every Expr tag of src/recover has a branch in src/emit/expr.mjs', () => {
  const src = fs.readFileSync('src/emit/expr.mjs', 'utf8');
  const missing = [...EXPR_TAGS].filter((tag) => !src.includes(`case '${tag}':`));
  return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : `${EXPR_TAGS.size} tags, all mapped` };
});

check('B', 'every Stmt tag of 11.1 has a branch in src/emit/stmt.mjs', () => {
  const tags = ['expr', 'decl', 'return', 'throw', 'debugger', 'hole'];
  const src = fs.readFileSync('src/emit/stmt.mjs', 'utf8');
  const missing = tags.filter((tag) => !src.includes(`case '${tag}':`));
  return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : `${tags.length} tags, all mapped` };
});

check('B', 'every Region kind of 11.2 has a branch in src/emit/region.mjs', () => {
  const kinds = ['seq', 'block', 'if', 'loop', 'forIn', 'forOf', 'switch', 'try',
    'labeled', 'break', 'continue', 'unstructured'];
  const src = fs.readFileSync('src/emit/region.mjs', 'utf8');
  const missing = kinds.filter((k) => !src.includes(`case '${k}':`));
  return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : `${kinds.length} kinds, all mapped` };
});

check('B', 'every Test predicate src/structure can produce has a rendering', () => {
  const src = fs.readFileSync('src/emit/expr.mjs', 'utf8');
  const missing = PREDICATE_KINDS.filter((k) => !src.includes(`case '${k}':`));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing ${missing.join(', ')}` : `${PREDICATE_KINDS.join(', ')}`,
  };
});

check('B', '`ctx` is unreachable through sanitise()', () => {
  const bad = ['ctx', 'class', 'return', '0abc', 'a-b', ''].map((s) => [s, sanitise(s)])
    .filter(([, out]) => out === 'ctx' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(out));
  return { ok: bad.length === 0, detail: bad.length ? JSON.stringify(bad) : "ctx -> ctx_, class -> class_, 0abc -> _0abc, '' -> _" };
});

check('B', 'every hole reason this layer adds is documented in EMIT_HOLE_WHY', () => {
  const declared = new Set(Object.keys(EMIT_HOLE_WHY));
  const used = new Set();
  for (const f of fs.readdirSync('src/emit')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/emit', f), 'utf8');
    for (const m of src.matchAll(/countHole\('([A-Za-z]+)'/g)) used.add(m[1]);
  }
  const undocumented = [...used].filter((w) => !declared.has(w));
  return {
    ok: undocumented.length === 0,
    detail: undocumented.length ? `undocumented: ${undocumented.join(', ')}` : `${used.size} reasons, all documented`,
  };
});

// ============================================================= C  shapes
for (const { tag, profile } of profiles) {
  const P = `C[${tag}]`;

  check(P, 'a straight-line function emits one return', () => {
    const a = asm(profile);
    a.emit('LdaSmi', [{ imm: 7 }]).emit('Return');
    const { out } = run(a, profile, { name: 'straight' });
    return {
      ok: /return 7;/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 120),
    };
  });

  check(P, 'a two-way branch emits if/else', () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }]).emit('JumpIfFalse', [{ label: 'else' }])
      .emit('LdaSmi', [{ imm: 1 }]).emit('Return')
      .label('else').emit('LdaSmi', [{ imm: 2 }]).emit('Return');
    const { out } = run(a, profile, { name: 'branch', parameterCount: 2 });
    return {
      ok: /if \(/.test(out.code) && /else/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 160),
    };
  });

  check(P, 'a back edge emits a loop statement', () => {
    const a = asm(profile);
    a.emit('LdaZero').emit('Star', [{ reg: 0 }])
      .label('head').emit('Ldar', [{ reg: 0 }]).emit('JumpIfFalse', [{ label: 'out' }])
      .emit('Ldar', [{ reg: 0 }]).emit('Star', [{ reg: 0 }])
      .emit('JumpLoop', [{ label: 'head' }, { u: 0 }, { u: 0 }])
      .label('out').emit('Ldar', [{ reg: 0 }]).emit('Return');
    const { out, sf } = run(a, profile, { name: 'loop' });
    return {
      ok: /(while|for) ?\(/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: `${sf.stats.loopRegions} loop region(s); ${out.code.replace(/\s+/g, ' ').slice(0, 120)}`,
    };
  });

  check(P, 'a handler range emits try/catch', () => {
    const a = asm(profile);
    a.label('ts').emit('Ldar', [{ param: 1 }]).emit('Throw')
      .label('te').emit('LdaZero').emit('Return')
      .label('h').emit('Star', [{ reg: 1 }]).emit('LdaSmi', [{ imm: 9 }]).emit('Return');
    a.handler('ts', 'te', 'h', 1);
    const { out } = run(a, profile, { name: 'trycatch', parameterCount: 2 });
    return {
      ok: /try \{/.test(out.code) && /catch \(/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 170),
    };
  });

  check(P, 'a jump table emits a switch statement', () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }])
      .emit('SwitchOnSmiNoFeedback', [{ table: ['c0', 'c1'] }, { u: 2 }, { u: 0 }])
      .emit('Jump', [{ label: 'dflt' }])
      .label('c0').emit('LdaSmi', [{ imm: 10 }]).emit('Return')
      .label('c1').emit('LdaSmi', [{ imm: 11 }]).emit('Return')
      .label('dflt').emit('LdaZero').emit('Return');
    const { out } = run(a, profile, { name: 'switch', parameterCount: 2 });
    return {
      ok: /switch \(/.test(out.code) && /case /.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 170),
    };
  });

  check(P, 'the undefinedOrNull predicate emits `== null`, not a truthiness test', () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }]).emit('JumpIfUndefinedOrNull', [{ label: 'nul' }])
      .emit('LdaSmi', [{ imm: 1 }]).emit('Return')
      .label('nul').emit('LdaZero').emit('Return');
    const { out } = run(a, profile, { name: 'nullish', parameterCount: 2 });
    return {
      ok: /[!=]= null/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 150),
    };
  });

  check(P, 'the JSReceiver predicate emits a typeof test, evaluating its operand once', () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }]).emit('JumpIfJSReceiver', [{ label: 'obj' }])
      .emit('LdaZero').emit('Return')
      .label('obj').emit('LdaSmi', [{ imm: 1 }]).emit('Return');
    const { out } = run(a, profile, { name: 'jsreceiver', parameterCount: 2 });
    const occurrences = (out.code.match(/typeof/g) ?? []).length;
    return {
      ok: occurrences === 2 && /JSReceiver/.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: `${occurrences} typeof; ${out.code.replace(/\s+/g, ' ').slice(0, 150)}`,
    };
  });

  check(P, 'a throw emits a throw statement', () => {
    const a = asm(profile);
    a.emit('Ldar', [{ param: 1 }]).emit('Throw');
    const { out } = run(a, profile, { name: 'thrower', parameterCount: 2 });
    return {
      ok: /throw /.test(out.code) && violationsOf(out) === 0 && !parses(out.code),
      detail: out.code.replace(/\s+/g, ' ').slice(0, 120),
    };
  });

  check(P, 'a context slot whose frame has no identity refuses the function instead of shadowing it', () => {
    // An assembled unit carries no ScopeInfo, so `LdaCurrentContextSlot [2]`
    // resolves to the entry frame and nothing can say which function owns it.
    // The old behaviour declared the spelling locally, which is docs/O1.md
    // 6.5's defect: the slot belongs to an ENCLOSING scope, so a local
    // declaration shadows the closure and reads `undefined`. The honest answer
    // is to refuse this function, name the slot and keep 11.3 invariant 5 --
    // `ctx` still does not occur, and nothing is left free either.
    const a = asm(profile);
    a.emit('LdaCurrentContextSlot', [{ u: 2 }]).emit('Return');
    const { out } = run(a, profile, { name: 'ctxslot' });
    const noComments = out.code.replace(/\/\*[\s\S]*?\*\//g, '');
    const why = Object.keys(out.report.refusalsByWhy ?? {});
    return {
      ok: out.report.functionsRefusedForAnUnplaceableBinding === 1
        && why.includes('contextSlotLocalIndexUnknown')
        && /HOLE contextBindingUnplaceable/.test(out.code)
        && !/__ctx_/.test(noComments)
        && !/\bctx\b/.test(noComments) && out.report.ctxIdentifiersInTheOutput === 0
        && violationsOf(out) === 0 && !parses(out.code),
      detail: `refused ${out.report.functionsRefusedForAnUnplaceableBinding}, why ${why.join(',')}; `
        + out.code.replace(/\s+/g, ' ').slice(0, 130),
    };
  });

  // The whole point of decoding the ClassBoilerplate: a method goes INSIDE its
  // class body. Before it did not -- `{e:'class'}.members` was always empty, so
  // every method was emitted as a sibling `var m = function m(){}` next to the
  // class and the output declared a class with nothing in it.
  //
  // Four units, because a class member is one unit's statements inside another
  // unit's expression: the parent holds the `%DefineClass` and the three
  // children are the constructor, the method and the getter.
  check(P, 'a class member is emitted inside its class body, not beside it', () => {
    const rid = profile.runtimeId ? profile.runtimeId('DefineClass') : null;
    if (rid === null || rid === undefined) return { skip: true, detail: 'profile has no DefineClass runtime id' };

    const child = (sfiId, name, body) => {
      const c = asm(profile);
      body(c);
      return c.build({ sfiId, parentSfiId: 1, name });
    };
    const kids = [
      child(7, 'Shape', (c) => c.emit('LdaUndefined').emit('Return')),
      child(11, 'area', (c) => c.emit('LdaSmi', [{ imm: 4 }]).emit('Return')),
      child(12, 'size', (c) => c.emit('LdaSmi', [{ imm: 9 }]).emit('Return')),
    ];

    const a = asm(profile);
    const bp = a.constant({
      t: 'classBoilerplate',
      argumentsCount: 5, firstDynamicArgumentIndex: 3, descriptorsRead: 3,
      argumentsUnclaimed: 0, synthesised: [], refusals: [],
      entries: [
        { side: 'instance', keyKind: 'name', key: 'area', kind: 'data', valueIndex: 3, keyIndex: null },
        { side: 'instance', keyKind: 'name', key: 'size', kind: 'getter', valueIndex: 4, keyIndex: null },
      ],
    });
    a.emit('LdaConstant', [{ const: bp }]).emit('Star', [{ reg: 0 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 7 }) }, { slot: 0 }, { u: 0 }]).emit('Star', [{ reg: 1 }])
      .emit('LdaTheHole').emit('Star', [{ reg: 2 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 11 }) }, { slot: 1 }, { u: 0 }]).emit('Star', [{ reg: 3 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 12 }) }, { slot: 2 }, { u: 0 }]).emit('Star', [{ reg: 4 }])
      .emit('CallRuntime', [{ u: rid }, { regList: [0, 5] }, { count: 5 }])
      .emit('Return');
    const parent = a.build({ sfiId: 1, name: 'makeShape', registerCount: 6 });

    const all = [parent, ...kids];
    const recs = [];
    const sfs = [];
    for (const b of all) {
      const ir = buildIR(b.unit, { profile });
      recs.push(recover(ir));
      sfs.push(structure(ir, { profile, verify: true }));
    }
    const out = emit(recs, sfs, { file: 'selftest.jsc', units: all.map((b) => b.unit), verify: true });
    const code = String(out.code);
    const holes = Object.keys(out.report.holes.byWhy ?? {}).filter((w) => /^class/.test(w));
    // Read back out of the AST, not out of the text: "inside the class body" is
    // a structural claim and a regexp over the source cannot make it.
    let placed = [];
    let siblings = [];
    if (!parses(code)) {
      const ast = parse(code, { sourceType: 'script' });
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n.type !== 'string') return;
        if (n.type === 'ClassExpression' || n.type === 'ClassDeclaration') {
          for (const m of n.body.body) {
            const k = m.kind === 'method' || m.kind === 'constructor' ? '' : `${m.kind} `;
            placed.push(`${m.static ? 'static ' : ''}${k}${m.key?.name ?? '?'}`);
          }
        }
        if (n.type === 'FunctionDeclaration' && /^(area|size)/.test(n.id?.name ?? '')) siblings.push(n.id.name);
        if (n.type === 'VariableDeclarator' && /^(area|size)/.test(n.id?.name ?? '')) siblings.push(n.id.name);
        for (const k in n) { if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(n[k]); }
      };
      walk(ast.program.body);
    }
    placed = placed.sort();
    // The pairing name, which docs/O1.md §4's `sfi` mode is identity by
    // construction only because of: `perFunction[].name` has to be what V8 will
    // call the function when it recompiles this text, and for a class member
    // that is the property name, `get `-prefixed for a getter
    // (ParseClassPropertyDefinition -> SetFunctionNameFromPropertyName with
    // get_space_string). Leaving the sibling spelling there cost 686 exact
    // matches over the corpus while the emitted shape was already right.
    const pairNames = out.perFunction.filter((f) => f.sfiId === 11 || f.sfiId === 12)
      .map((f) => f.name).sort();
    return {
      ok: JSON.stringify(placed) === JSON.stringify(['area', 'constructor', 'get size'])
        && JSON.stringify(pairNames) === JSON.stringify(['area', 'get size'])
        && siblings.length === 0
        && out.report.classMembersPlaced === 3
        && holes.length === 0
        && violationsOf(out) === 0 && !parses(code),
      detail: `class body [${placed.join(', ')}], pairing names [${pairNames.join(', ')}], `
        + `siblings [${siblings.join(', ')}], report ${out.report.classMembersPlaced}, `
        + `class holes ${holes.join(',') || 'none'}`,
    };
  });

  // `async` and `*` on a class member are not decoration. A `t.classMethod`
  // built without them puts `await` inside a non-async method, which is a
  // SyntaxError -- and a SyntaxError anywhere takes the whole FILE with it.
  // Measured while the member placement above was being built: 4 of a 20-file
  // corpus sample stopped compiling, each one an `async` class method.
  check(P, 'async and generator travel with a class member', () => {
    const rid = profile.runtimeId ? profile.runtimeId('DefineClass') : null;
    if (rid === null || rid === undefined) return { skip: true, detail: 'profile has no DefineClass runtime id' };
    const kid = (sfiId, name, extra) => {
      const c = asm(profile);
      c.emit('LdaUndefined').emit('Return');
      return c.build({ sfiId, parentSfiId: 1, name, ...extra });
    };
    const kids = [
      kid(7, 'Job', {}),
      kid(11, 'run', { isAsync: true }),
      kid(12, 'items', { isGenerator: true }),
    ];
    const a = asm(profile);
    const bp = a.constant({
      t: 'classBoilerplate',
      argumentsCount: 5, firstDynamicArgumentIndex: 3, descriptorsRead: 3,
      argumentsUnclaimed: 0, synthesised: [], refusals: [],
      entries: [
        { side: 'instance', keyKind: 'name', key: 'run', kind: 'data', valueIndex: 3, keyIndex: null },
        { side: 'instance', keyKind: 'name', key: 'items', kind: 'data', valueIndex: 4, keyIndex: null },
      ],
    });
    a.emit('LdaConstant', [{ const: bp }]).emit('Star', [{ reg: 0 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 7 }) }, { slot: 0 }, { u: 0 }]).emit('Star', [{ reg: 1 }])
      .emit('LdaTheHole').emit('Star', [{ reg: 2 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 11 }) }, { slot: 1 }, { u: 0 }]).emit('Star', [{ reg: 3 }])
      .emit('CreateClosure', [{ const: a.constant({ t: 'sfi', sfiId: 12 }) }, { slot: 2 }, { u: 0 }]).emit('Star', [{ reg: 4 }])
      .emit('CallRuntime', [{ u: rid }, { regList: [0, 5] }, { count: 5 }])
      .emit('Return');
    const all = [a.build({ sfiId: 1, name: 'makeJob', registerCount: 6 }), ...kids];
    const recs = [];
    const sfs = [];
    for (const b of all) {
      const ir = buildIR(b.unit, { profile });
      recs.push(recover(ir));
      sfs.push(structure(ir, { profile, verify: true }));
    }
    const out = emit(recs, sfs, { file: 'selftest.jsc', units: all.map((b) => b.unit), verify: true });
    const code = String(out.code);
    return {
      ok: /\basync\s+run\s*\(\)/.test(code) && /\*\s*items\s*\(\)/.test(code)
        && out.report.classMembersPlaced === 3
        && violationsOf(out) === 0 && !parses(code),
      detail: code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').slice(0, 170),
    };
  });

  check(P, 'two runs over the same input produce identical text (O2 precondition)', () => {
    const build = () => {
      const a = asm(profile);
      a.emit('Ldar', [{ param: 1 }]).emit('JumpIfFalse', [{ label: 'e' }])
        .emit('LdaSmi', [{ imm: 1 }]).emit('Return')
        .label('e').emit('LdaZero').emit('Return');
      return run(a, profile, { name: 'determinism', parameterCount: 2 }).out.code;
    };
    const one = build();
    const two = build();
    return { ok: one === two, detail: one === two ? `${one.length} bytes, identical` : 'DIFFERENT' };
  });
}

// =========================================================== D  fixtures
const FIXTURE_CHECKS = [
  ['loop-while', /while \(|for \(/, 'a while loop'],
  ['loop-do-while', /do \{|while \(|for \(/, 'a do/while loop'],
  ['loop-for-3clause', /for \(|while \(/, 'a three-clause for loop'],
  ['loop-nested', /(while|for) ?\([\s\S]*(while|for) ?\(/, 'nested loops'],
  ['loop-while-continue', /continue|while \(|for \(/, 'continue inside a loop'],
  ['loop-for-in', /for \([A-Za-z_$][\w$]* in /, 'a real for-in head rebuilt from the idiom'],
  ['loop-for-of', /(while|for) ?\(/, 'for-of, lowered to the iterator protocol'],
  ['loop-for-of-break', /break|return/, 'break out of a for-of'],
  ['switch-dense', /switch \(/, 'a dense switch (jump table)'],
  ['switch-sparse', /switch \(|if \(/, 'a sparse switch'],
  ['switch-string', /switch \(|if \(/, 'a string switch (compare chain)'],
  ['switch-no-default', /switch \(|if \(/, 'a switch with no default'],
  ['switch-default-middle', /switch \(|if \(/, 'a default clause in the middle'],
  ['switch-fallthrough', /switch \(|if \(/, 'case fall-through'],
  ['try-catch', /try \{[\s\S]*catch \(/, 'try/catch'],
  ['try-finally', /try \{[\s\S]*catch \(/, 'try/finally as the token-dispatch catch T8 produces'],
  ['try-catch-finally', /try \{[\s\S]*catch \(/, 'try/catch/finally'],
  ['try-nested', /try \{[\s\S]*try \{/, 'nested try'],
  ['label-break', /break/, 'a labelled break'],
  ['label-break-multi', /break/, 'a labelled break out of two loops'],
  // T8 measured `{r:'continue'}` as essentially never produced (0 against 9821
  // breaks): V8 gives a loop a dedicated continue target, so a `continue loop`
  // comes back as the merge of the two paths inside the loop body, with the
  // update in the `for` clause. The construct to look for is therefore the
  // loop with its update, not the keyword.
  ['label-continue', /for \(; [^;]*; [^)]*\)|continue/, 'a labelled continue, merged into the loop update'],
  ['label-continue-multi', /(for|while) ?\([\s\S]*(for|while) ?\(|continue/, 'a labelled continue out of two loops'],
  ['async-function', /async function|await /, 'an async function'],
  ['async-await-in-loop', /await [\s\S]*(while|for) ?\(|(while|for) ?\([\s\S]*await /, 'await inside a loop'],
];

const fixtureTotals = {
  files: 0, functions: 0, violations: 0, ctx: 0, holes: 0, parseFailures: 0,
  unwritten: 0, declared: 0, forIn: 0, finallyShapes: 0, chains: 0,
  bindingsOwned: 0, bindingsInherited: 0, slotsUnplaceable: 0, refused: 0,
  slotsHere: 0, slotsAncestor: 0,
};

for (const [name, want, what] of FIXTURE_CHECKS) {
  check('D', `${name}: ${what}`, () => {
    const file = path.join(FIXTURES, `${name}.jsc`);
    if (!fs.existsSync(file)) return { ok: false, detail: 'fixture missing' };
    const r = decompile(file, { profile: FIXTURE_TAG });
    const perr = parses(r.code);
    fixtureTotals.files++;
    fixtureTotals.functions += r.report.functionsEmitted;
    fixtureTotals.violations += violationsOf(r);
    fixtureTotals.ctx += r.report.ctxIdentifiersInTheOutput;
    fixtureTotals.holes += r.report.holes.total;
    fixtureTotals.unwritten += r.report.namesReadButNeverWritten;
    fixtureTotals.declared += r.report.namesDeclared;
    fixtureTotals.forIn += r.report.forInRebuilt;
    fixtureTotals.finallyShapes += r.report.finallyShapes;
    fixtureTotals.chains += r.report.loopTestChainsMaterialised;
    fixtureTotals.bindingsOwned += r.report.contextBindingsOwned;
    fixtureTotals.bindingsInherited += r.report.contextBindingsInherited;
    fixtureTotals.slotsUnplaceable += r.report.contextBindingsUnplaceable;
    fixtureTotals.refused += r.report.functionsRefusedForAnUnplaceableBinding;
    fixtureTotals.slotsHere += r.report.scopePlan.slotLocationsOwnedHere ?? 0;
    fixtureTotals.slotsAncestor += r.report.scopePlan.slotLocationsOwnedByAnAncestor ?? 0;
    if (perr) fixtureTotals.parseFailures++;
    const matched = want.test(r.code);
    return {
      ok: matched && !perr && violationsOf(r) === 0,
      detail: `${r.report.functionsEmitted} fn, ${r.report.holes.total} holes, `
        + `${violationsOf(r)} violations${perr ? `, PARSE: ${perr}` : ''}${matched ? '' : ', construct NOT found'}`,
    };
  });
}

// ---- the defect of docs/O1.md 6.5, on a fixture whose answer is known.
//
// `loop-for-of-break.src.js` closes over two variables: the iterator helper's
// `i` and the outer `closed`, which an inner function assigns. Both are
// context slots, so before scopes.mjs each inner function declared its own
// copy and read `undefined` from it. The check is the one thing that makes a
// closure real: the binding is declared ONCE, in the function that owns the
// frame, and the inner function declares nothing.
check('D', 'loop-for-of-break: a captured variable is declared once, by the function that owns its frame', () => {
  const r = decompile(path.join(FIXTURES, 'loop-for-of-break.jsc'), { profile: FIXTURE_TAG });
  const declarators = (name) => {
    let n = 0;
    walkAst(r.ast, (x) => {
      if (x.type === 'VariableDeclarator' && x.id?.type === 'Identifier' && x.id.name === name) n++;
    });
    return n;
  };
  const flat = r.code.replace(/\s+/g, ' ');
  // an inner function writes the outer binding -- that write is the closure
  const writesTheOuterBinding = /function \w+\(\) \{ closed = true;/.test(flat);
  const counts = { closed: declarators('closed'), i: declarators('i') };
  return {
    ok: counts.closed === 1 && counts.i === 1 && writesTheOuterBinding
      && r.report.contextBindingsInherited >= 2 && r.report.contextBindingsOwned >= 2
      && r.report.contextBindingsUnplaceable === 0 && violationsOf(r) === 0 && !parses(r.code),
    detail: `declarators closed=${counts.closed} i=${counts.i}; owned `
      + `${r.report.contextBindingsOwned}, inherited ${r.report.contextBindingsInherited}; `
      + `inner write=${writesTheOuterBinding}`,
  };
});

// ========================================================= E  invariants
check('E', 'every context slot of every fixture was placed in a real scope', () => ({
  ok: fixtureTotals.slotsUnplaceable === 0 && fixtureTotals.refused === 0
    && fixtureTotals.slotsAncestor > 0 && fixtureTotals.slotsHere > 0,
  detail: `${fixtureTotals.slotsHere} slot location(s) owned by the reading function, `
    + `${fixtureTotals.slotsAncestor} by an enclosing one, ${fixtureTotals.slotsUnplaceable} unplaceable, `
    + `${fixtureTotals.refused} function(s) refused`,
}));

check('E', 'every refusal reason scopes.mjs can produce is documented', () => {
  const src = fs.readFileSync('src/emit/scopes.mjs', 'utf8');
  const used = new Set([...src.matchAll(/refuse\(plan, '([A-Za-z]+)'/g)].map((m) => m[1]));
  const names = fs.readFileSync('src/emit/names.mjs', 'utf8');
  for (const m of names.matchAll(/unplaceable\.push\(\{\s*why: '([A-Za-z]+)'/g)) used.add(m[1]);
  const undocumented = [...used].filter((w) => !(w in SCOPE_REFUSAL_WHY));
  return {
    ok: undocumented.length === 0 && Object.keys(SCOPE_REFUSAL_WHY).length >= used.size,
    detail: undocumented.length ? `undocumented: ${undocumented.join(', ')}`
      : `${used.size} reason(s) raised, ${Object.keys(SCOPE_REFUSAL_WHY).length} documented`,
  };
});

check('E', '11.3 invariants 1-6: zero violations over every fixture', () => ({
  ok: fixtureTotals.violations === 0,
  detail: `${fixtureTotals.violations} violations over ${fixtureTotals.functions} functions in ${fixtureTotals.files} files`,
}));

check('E', '11.3 invariant 5: `ctx` occurs 0 times over every fixture', () => ({
  ok: fixtureTotals.ctx === 0,
  detail: `${fixtureTotals.ctx} occurrences (baseline 1710336 over the corpus)`,
}));

check('E', 'every fixture parses (a precondition, not a result)', () => ({
  ok: fixtureTotals.parseFailures === 0,
  detail: `${fixtureTotals.parseFailures} of ${fixtureTotals.files} failed to parse`,
}));

check('E', 'the for-in idiom is rebuilt, not emitted as a loop with no exit', () => ({
  ok: fixtureTotals.forIn >= 1,
  detail: `${fixtureTotals.forIn} for-in head(s) rebuilt from loop.idiomDetail`,
}));

check('E', "T8's finallyToken form is reported, not silently read as a plain catch", () => ({
  ok: fixtureTotals.finallyShapes >= 1,
  detail: `${fixtureTotals.finallyShapes} try region(s) carried a recognised finally token dispatch`,
}));

check('E', 'a materialised loop test is emitted, not dropped with the test block', () => ({
  ok: fixtureTotals.chains >= 1,
  detail: `${fixtureTotals.chains} loop(s) whose test chain carried statements T8 claimed were absent`,
}));

// --- the hole rendering, on a synthetic pair: T7 cannot be made to produce a
//     hole on demand, and the RENDERING is what 7 constrains.
function syntheticPair(profile, mutate) {
  const a = asm(profile);
  a.emit('LdaSmi', [{ imm: 3 }]).emit('Return');
  const { unit } = a.build({ name: 'synthetic' });
  const ir = buildIR(unit, { profile });
  const rec = recover(ir);
  const sf = structure(ir, { profile, verify: true });
  mutate(rec, sf, ir);
  return { unit, ir, rec, sf, out: emit([rec], [sf], { file: 'synthetic.jsc', units: [unit], verify: true }) };
}

check('E', 'an {e:hole} renders as a declared marker and is counted', () => {
  const { profile } = profiles[0];
  const { out } = syntheticPair(profile, (rec) => {
    for (const [b, list] of rec.stmts) {
      rec.stmts.set(b, list.map((s) => (s.s === 'return'
        ? { ...s, arg: { e: 'hole', why: 'selftestExprHole', detail: 'injected', dump: null } } : s)));
    }
  });
  const marked = /HOLE selftestExprHole/.test(out.code);
  const declared = /let [^;]*\b__hole\b/.test(out.code);
  return {
    ok: marked && declared && out.report.holes.total === 1
      && out.report.holes.byWhy.selftestExprHole === 1 && !parses(out.code),
    detail: `${out.report.holes.total} counted, marker=${marked}, declared=${declared}; `
      + out.code.replace(/\s+/g, ' ').slice(0, 150),
  };
});

check('E', 'an {s:hole} renders as a statement marker and is counted', () => {
  const { profile } = profiles[0];
  const { out } = syntheticPair(profile, (rec) => {
    for (const [b, list] of rec.stmts) {
      rec.stmts.set(b, list.map(() => ({ s: 'hole', why: 'selftestStmtHole', detail: 'injected', pos: null, values: [] })));
    }
  });
  return {
    ok: /HOLE STATEMENT selftestStmtHole/.test(out.code) && out.report.holes.total === 1 && !parses(out.code),
    detail: out.code.replace(/\s+/g, ' ').slice(0, 170),
  };
});

check('E', 'holes counted in the report equal the markers in the AST (invariant 6)', () => {
  const { profile } = profiles[0];
  const { out } = syntheticPair(profile, (rec) => {
    for (const [b, list] of rec.stmts) {
      rec.stmts.set(b, [
        { s: 'hole', why: 'a', detail: null, pos: null, values: [] },
        { s: 'hole', why: 'b', detail: null, pos: null, values: [] },
        ...list,
      ]);
    }
  });
  const six = out.perFunction[0].verification.checks.find((c) => c.id === 6);
  return {
    ok: six && six.violations === 0 && out.report.holes.total === 2,
    detail: `${out.report.holes.total} holes, invariant 6 violations ${six?.violations}`,
  };
});

check('E', '{r:unstructured} renders 4.4.7\'s while(true) switch(__pc) with the marker', () => {
  const { profile } = profiles[0];
  const { out } = syntheticPair(profile, (rec, sf, ir) => {
    const blocks = ir.blocks.filter((b) => ir.dominators.reachable(b.id)).map((b) => b.id);
    const region = unstructuredRegion(ir, sf.graph, blocks, 'selftest');
    sf.root = region;
    sf.unstructured = [{ blocks: region.blocks, why: region.why, dispatchVar: region.dispatchVar, detail: {} }];
    sf.removed.loopTestBlocks = [];
  });
  const hasLoop = /while \(true\) switch \(__pc/.test(out.code.replace(/\s+/g, ' '));
  const hasMarker = /UNSTRUCTURED selftest/.test(out.code);
  return {
    ok: hasLoop && hasMarker && out.report.unstructuredRegions === 1
      && out.report.metrics.m10_unstructuredRegions.value === 1 && !parses(out.code),
    detail: `loop=${hasLoop} marker=${hasMarker} regions=${out.report.unstructuredRegions}; `
      + out.code.replace(/\s+/g, ' ').slice(0, 190),
  };
});

check('E', 'the unstructured dispatch assigns __pc from the CFG, not from a guess', () => {
  const { profile } = profiles[0];
  const a = asm(profile);
  a.emit('Ldar', [{ param: 1 }]).emit('JumpIfFalse', [{ label: 'e' }])
    .emit('LdaSmi', [{ imm: 1 }]).emit('Return')
    .label('e').emit('LdaZero').emit('Return');
  const { unit } = a.build({ name: 'dispatch', parameterCount: 2 });
  const ir = buildIR(unit, { profile });
  const rec = recover(ir);
  const sf = structure(ir, { profile, verify: true });
  const blocks = ir.blocks.filter((b) => ir.dominators.reachable(b.id)).map((b) => b.id);
  const region = unstructuredRegion(ir, sf.graph, blocks, 'selftest');
  sf.root = region;
  sf.unstructured = [{ blocks: region.blocks, why: region.why, dispatchVar: region.dispatchVar }];
  sf.removed.loopTestBlocks = [];
  const out = emit([rec], [sf], { file: 'synthetic.jsc', units: [unit], verify: true });
  const flat = out.code.replace(/\s+/g, ' ');
  return {
    ok: /__pc\d+ = [^;]*\?/.test(flat) && violationsOf(out) === 0 && !parses(out.code),
    detail: flat.slice(0, 220),
  };
});

check('E', 'invariant 4 detects a value emitted twice when it is not duplicable', () => {
  const { profile } = profiles[0];
  // The same Expr object in two statements, with its value removed from
  // `duplicable`: the detector must see it. This is the negative control for
  // the "0 duplicated values" number -- without it, a detector that always
  // says zero would pass.
  //
  // The duplicated expression has to have STRUCTURE. A shared `{e:'name'}` is
  // exempt by design (verify.mjs check 4b: reading a variable twice evaluates
  // nothing), so `return p0` would not exercise the check. `p0 + 1` would be
  // an addition run twice.
  const a = asm(profile);
  a.emit('LdaSmi', [{ imm: 1 }]).emit('Return');
  const { unit } = a.build({ name: 'dup', parameterCount: 2 });
  const ir = buildIR(unit, { profile });
  const rec = recover(ir);
  const sf = structure(ir, { profile, verify: true });
  const bid = [...rec.stmts.keys()][0];
  const list = rec.stmts.get(bid);
  // One Expr object, registered as the expression of a value that is NOT in
  // `duplicable`, placed in two statements. Built here rather than taken from
  // T7's output so the control tests the detector and not the fixture.
  const shared = { e: 'call', callee: { e: 'name', name: 'f', ref: { k: 'global' } }, args: [], optional: false };
  const id = rec.exprs.size + ir.values.length + 1;
  rec.exprs.set(id, shared);
  rec.duplicable.delete(id);
  rec.stmts.set(bid, [
    { s: 'expr', expr: shared, pos: null, values: [id] },
    { s: 'expr', expr: shared, pos: null, values: [id] },
    ...list,
  ]);
  const out = emit([rec], [sf], { file: 'synthetic.jsc', units: [unit], verify: true });
  const four = out.perFunction[0].verification.checks.find((c) => c.id === 4);
  return {
    ok: four && four.violations === 1 && out.report.duplicatedValues === 1,
    detail: `value ${id} emitted twice; invariant 4 violations ${four?.violations}, `
      + `report ${out.report.duplicatedValues}`,
  };
});

check('E', 'invariant 2 reports a Test whose value has no exprs entry', () => {
  const { profile } = profiles[0];
  const a = asm(profile);
  a.emit('Ldar', [{ param: 1 }]).emit('JumpIfFalse', [{ label: 'e' }])
    .emit('LdaSmi', [{ imm: 1 }]).emit('Return')
    .label('e').emit('LdaZero').emit('Return');
  const { unit } = a.build({ name: 'nojoin', parameterCount: 2 });
  const ir = buildIR(unit, { profile });
  const rec = recover(ir);
  const sf = structure(ir, { profile, verify: true });
  let removedId = null;
  const strip = (r) => {
    if (!r) return;
    if (r.r === 'if' && r.test && rec.exprs.has(r.test.value)) { removedId = r.test.value; rec.exprs.delete(removedId); }
    for (const k of ['body', 'then', 'else', 'block', 'handler']) {
      const v = r[k];
      if (Array.isArray(v)) v.forEach(strip); else if (v) strip(v);
    }
  };
  strip(sf.root);
  const out = emit([rec], [sf], { file: 'synthetic.jsc', units: [unit], verify: true });
  const two = out.perFunction[0].verification.checks.find((c) => c.id === 2);
  return {
    ok: removedId !== null && two && two.violations === 1 && /HOLE joinUnresolved/.test(out.code) && !parses(out.code),
    detail: `value ${removedId} removed; invariant 2 violations ${two?.violations}; hole rendered=${/HOLE joinUnresolved/.test(out.code)}`,
  };
});

check('E', 'the source map carries the real positions and the order is monotone', () => {
  const r = decompile(path.join(FIXTURES, 'loop-while.jsc'), { profile: FIXTURE_TAG });
  const m = r.map;
  const mono = r.perFunction.every((f) => !f.monotonicity || f.monotonicity.monotone);
  return {
    ok: !!m && m.version === 3 && m.sources.length === 1 && typeof m.mappings === 'string'
      && m.mappings.length > 0 && r.report.sourcePositionsApplied > 0
      && m.x_v8d_sourcePositionsAreCharacterOffsets === true,
    detail: `${r.report.sourcePositionsApplied} positions, ${m?.mappings?.length ?? 0} mapping bytes, `
      + `monotone=${mono} (${r.report.monotonicity.monotone}/${r.report.monotonicity.functions}, `
      + `${r.report.monotonicity.inversions} inversions)`,
  };
});

check('E', 'every compiled unit of every fixture reaches the output (metric 6)', () => {
  let emitted = 0;
  let deserialized = 0;
  for (const [name] of FIXTURE_CHECKS) {
    const file = path.join(FIXTURES, `${name}.jsc`);
    if (!fs.existsSync(file)) continue;
    const r = decompile(file, { profile: FIXTURE_TAG });
    emitted += r.report.functionsEmitted + r.report.functionsClaimedInline;
    deserialized += r.report.deserializedFunctions;
  }
  return {
    ok: emitted === deserialized && deserialized > 0,
    detail: `${emitted} / ${deserialized} = ${deserialized ? (100 * emitted / deserialized).toFixed(2) : '-'}% (baseline 38.76%)`,
  };
});

check('E', 'a unit whose recovery failed is still emitted, marked and counted', () => {
  const { profile } = profiles[0];
  const a = asm(profile);
  a.emit('LdaZero').emit('Return');
  const { unit } = a.build({ name: 'broken' });
  const out = emit([], [], {
    file: 'synthetic.jsc', units: [unit], verify: true,
    failures: [{ sfiId: unit.sfiId, stage: 'recover', error: 'injected' }],
  });
  return {
    ok: /NOT DECOMPILED/.test(out.code) && out.report.functionsFailed === 1
      && out.report.functionsEmitted === 1 && !parses(out.code),
    detail: `${out.report.functionsEmitted} emitted, ${out.report.functionsFailed} failed; `
      + out.code.replace(/\s+/g, ' ').slice(0, 160),
  };
});

check('E', 'a local whose spelling a global also owns is renamed, not aliased', () => {
  const r = decompile(path.join(FIXTURES, 'loop-while.jsc'), { profile: FIXTURE_TAG });
  // `let T = T` (T7 names the result of `LdaGlobal 'T'` after the global) is a
  // TDZ error as `let` and a self-assignment of undefined as `var`.
  const selfAssign = /\b([A-Za-z_$][\w$]*) = \1;/.test(r.code);
  return {
    ok: r.report.localsRenamed > 0 && !selfAssign,
    detail: `${r.report.localsRenamed} renamed; self-assignment present=${selfAssign}`,
  };
});

check('E', 'nested functions are emitted inside their parent, so a closure slot is in scope', () => {
  const r = decompile(path.join(FIXTURES, 'loop-for-in.jsc'), { profile: FIXTURE_TAG });
  const tree = r.report.unitTree;
  return {
    ok: tree.byRange > 0 && r.report.orphans === 0,
    detail: `${tree.byRange} parent links from the source range, ${tree.byParentSfiId} confirmed by parentSfiId, `
      + `${tree.disagreed} disagreements, ${r.report.orphans} orphans`,
  };
});

// ==================================================== F  object literal order
//
// An object literal's property order is observable (`Object.keys`,
// `for...in`, `JSON.stringify`), and docs/O1.md 6.9 measured 122 corpus
// functions emitting it wrong: the constant properties came from the
// boilerplate and the run-time ones were APPENDED after them, where V8 puts
// the static part in the boilerplate's own key order
// (`VisitObjectLiteral:4336`). These pin the fix and, just as much, pin the
// refusals -- a case the bytecode does not answer must keep the old order
// under a named reason, never be reordered on a guess.
{
  const P = 'F';
  const profile = profiles.find((p) => p.tag === '14.4.258.16')?.profile ?? profiles[0].profile;
  const HOLE = { t: 'hole' };

  /**
   * A literal whose static part is `entries` and whose placeholder entries are
   * filled by one `DefineNamedOwnProperty` per `stores` name, in that order.
   */
  function literalUnit(entries, stores) {
    const a = asm(profile);
    const bp = a.constant({ t: 'objectBoilerplate', length: entries.length * 2, entries });
    a.emit('CreateObjectLiteral', [{ const: bp }, { slot: 0 }, { u: 0 }]).emit('Star', [{ reg: 0 }]);
    stores.forEach((name, i) => {
      const k = a.constant({ t: 'string', v: name });
      a.emit('LdaSmi', [{ imm: 10 + i }])
        .emit('DefineNamedOwnProperty', [{ reg: 0 }, { const: k }, { slot: 1 + i }]);
    });
    a.emit('Ldar', [{ reg: 0 }]).emit('Return');
    return run(a, profile, { name: 'lit' });
  }

  const ent = (key, value) => ({ key: { t: 'string', v: key }, value });
  const literalOf = (code) => (/\{[^{}]*\}/.exec(code.replace(/\s+/g, ' ')) ?? ['(no literal)'])[0];
  const refusals = (rec) => (rec.warnings ?? [])
    .filter((w) => w.code === 'objectLiteralStaticOrderUnclaimed').map((w) => w.reason);

  check(P, "docs/O1.md 6.9's repro: a run-time property before a constant one keeps its place", () => {
    // {fn: <computed>, await: false} -- the boilerplate's order is fn, await,
    // and appending the store produced {await: false, fn: ...}.
    const { out, rec } = literalUnit(
      [ent('fn', HOLE), ent('await', { t: 'boolean', v: false })], ['fn'],
    );
    const lit = literalOf(out.code);
    return {
      ok: /\{\s*fn:\s*10,\s*await:\s*false\s*\}/.test(lit) && refusals(rec).length === 0
        && violationsOf(out) === 0 && !parses(out.code),
      detail: `${lit}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, 'two run-time properties straddling three constants interleave, not append', () => {
    const { out, rec } = literalUnit([
      ent('a', { t: 'number', v: 1 }), ent('b', HOLE), ent('c', { t: 'number', v: 2 }),
      ent('d', HOLE), ent('e', { t: 'number', v: 3 }),
    ], ['b', 'd']);
    const lit = literalOf(out.code);
    return {
      ok: /\{\s*a:\s*1,\s*b:\s*10,\s*c:\s*2,\s*d:\s*11,\s*e:\s*3\s*\}/.test(lit)
        && refusals(rec).length === 0 && !parses(out.code),
      detail: `${lit}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, 'a constant-only static part with a dynamic tail leaves the tail last', () => {
    // The store's key is NOT in the boilerplate, so it is the dynamic part and
    // appending it IS V8's order -- there is nothing to refuse and nothing to
    // move. This is the case the fix must not break.
    const { out, rec } = literalUnit([ent('a', { t: 'number', v: 1 })], []);
    return {
      ok: /\{\s*a:\s*1\s*\}/.test(literalOf(out.code)) && refusals(rec).length === 0,
      detail: `${literalOf(out.code)}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, 'a duplicate static key is refused by name and keeps the old order', () => {
    // `{a: g(), a: 1}`: a later duplicate assigns into the property the
    // earlier one created, so the key keeps its FIRST position and its LAST
    // value, and `CalculateEmitStore` drops the store for the shadowed one --
    // so which placeholder the one store belongs to is not in the bytecode.
    const { out, rec } = literalUnit(
      [ent('a', HOLE), ent('a', { t: 'number', v: 1 })], ['a'],
    );
    return {
      ok: refusals(rec).join(',') === 'duplicateBoilerplateKey' && !parses(out.code),
      detail: `${literalOf(out.code)}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, 'more placeholders than stores is refused by name, not filled in by position', () => {
    // The corpus shape behind this one is an accessor: it gets a static entry,
    // VisitObjectLiteral:4323 defines it with a runtime call rather than a
    // Define* store, and collectStores stops there.
    const { out, rec } = literalUnit(
      [ent('a', HOLE), ent('b', { t: 'number', v: 1 }), ent('c', HOLE)], ['a'],
    );
    return {
      ok: refusals(rec).join(',') === 'fewerStoresThanPlaceholders' && !parses(out.code),
      detail: `${literalOf(out.code)}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, "a store whose key is not the placeholder's is refused, not reordered", () => {
    const { out, rec } = literalUnit(
      [ent('a', HOLE), ent('b', { t: 'number', v: 1 })], ['zzz'],
    );
    return {
      ok: refusals(rec).join(',') === 'storeKeyMismatch' && !parses(out.code),
      detail: `${literalOf(out.code)}; refusals [${refusals(rec).join(',')}]`,
    };
  });

  check(P, 'every refusal reason literals.mjs names is documented in ORDER_REFUSALS', () => {
    const declared = new Set(Object.keys(ORDER_REFUSALS));
    const src = fs.readFileSync('src/recover/patterns/literals.mjs', 'utf8');
    const used = new Set();
    for (const m of src.matchAll(/reason: '([A-Za-z]+)'/g)) used.add(m[1]);
    const undocumented = [...used].filter((w) => !declared.has(w));
    return {
      ok: undocumented.length === 0 && used.size > 0,
      detail: undocumented.length ? `undocumented: ${undocumented.join(', ')}`
        : `${used.size} reasons, all documented`,
    };
  });

  check(P, 'staticOrder throws on a contradictory plan instead of reordering', () => {
    // The marks describe a layout withLiteralFolds produces; if that layout
    // ever changes, the assertion has to fire rather than quietly permute a
    // literal. One bad plan per assertion the function makes.
    const bad = [
      ['markedRunDoesNotStartAtBpBase', [{ key: 'x' }, { key: 'y', bpAt: 0, bpBase: 0 }]],
      ['bpAtOutOfRange', [{ key: 'x' }, { key: 'y', bpAt: 9, bpBase: 1 }]],
      ['twoPropsClaimOneBoilerplatePosition',
        [{ key: 'x', bpAt: 0, bpBase: 0 }, { key: 'y', bpAt: 0, bpBase: 0 }]],
    ];
    const thrown = [];
    for (const [, props] of bad) {
      try { staticOrder(props); thrown.push('(did not throw)'); }
      catch (e) { thrown.push(/objectLiteralStaticOrder\/(\w+)/.exec(e.message)?.[1] ?? e.message); }
    }
    const want = bad.map(([w]) => w);
    // and an unmarked list is returned untouched
    const plain = [{ key: 'a' }, { key: 'b' }];
    return {
      ok: thrown.join(',') === want.join(',') && staticOrder(plain) === plain,
      detail: `${thrown.join(', ')}; an unmarked list is returned as-is`,
    };
  });
}

// ================================================================ summary
say('');
say(`## ${pass} passed, ${fail} failed`);
say('');
say('### fixture totals');
say('');
say('| metric | value |');
say('|---|---|');
say(`| files | ${fixtureTotals.files} |`);
say(`| functions emitted | ${fixtureTotals.functions} |`);
say(`| 11.3 invariant violations | ${fixtureTotals.violations} |`);
say(`| \`ctx\` occurrences | ${fixtureTotals.ctx} |`);
say(`| holes | ${fixtureTotals.holes} |`);
say(`| parse failures | ${fixtureTotals.parseFailures} |`);
say(`| names declared | ${fixtureTotals.declared} |`);
say(`| names read but never written (reported, not an invariant) | ${fixtureTotals.unwritten} |`);
if (failures.length) {
  say('');
  say('### failures');
  for (const f of failures) say(`* ${f}`);
}
fs.mkdirSync('scratch/t9', { recursive: true });
fs.writeFileSync('scratch/t9/SELFTEST.md', L.join('\n') + '\n');
if (VERBOSE) say(`\nwrote scratch/t9/SELFTEST.md`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
