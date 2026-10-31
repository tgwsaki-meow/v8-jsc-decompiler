// tools/verify/o1_corpus_selftest.mjs
//
// Does the O1-corpus instrument work? Five checks, none of which involve the
// decompiler, so a failure here is an ORACLE defect and not a measurement.
//
//   node tools/verify/o1_corpus_selftest.mjs [--entries 12]
//
// The point of A and B is the same as `o1_bytecode.mjs::o1SelfCheck`'s:
// an oracle that always answers "match" passes an identity check, so it has to
// be shown rejecting a program that really is different.
//
//   A  CROSS-CACHE IDENTITY. The same program is minted twice -- once as
//      written, once with a leading newline -- so the two `.jsc` files differ
//      in bytes, in every source position and in every `src/heap` object id,
//      while being the same program. Every function must normalise to an
//      IDENTICAL stream and nothing may go unpaired. This is the check that
//      the cross-cache erasures (allocation ids, source positions) are
//      sufficient: without them it fails.
//   B  DISCRIMINATION. A one-token mutation of the same source must NOT come
//      out all-exact, and the divergence must land in a named cause family.
//   C  A STRUCTURAL MUTATION IS NAMED CORRECTLY. `===` -> `==` must be
//      classified `compare-opcode`; `o.x` -> `o[k]` must be classified
//      `named-vs-keyed-property`. Without this the ranked cause list could be
//      a list of plausible-sounding labels attached to the wrong diffs.
//   D  EXECUTION POLICY. The spawn guard refuses a child that is not
//      `mint_child.cjs`, refuses an evaluating flag, and refuses to write a
//      corpus-derived artefact into the tree `corpus.mjs` marks executable.
//   E  ERASURE ACCOUNTING is non-zero and the allocation-id rule actually
//      fires (otherwise A would pass for the wrong reason).

import fs from 'node:fs';
import path from 'node:path';
import {
  normalizedFunctionsFromJsc, pairCorpusFunctions, compareAndClassify,
  mintCompileOnly, requireMatchingMinter, assertCompileOnlySpawn,
  assertNotInExecutableTree, eraseAllocationIds, ExecutionPolicyError,
} from '../../src/verify/o1_corpus.mjs';
import { loadEntries, stratify, readSource } from '../../src/verify/corpus.mjs';
import { mutations } from '../../src/verify/mutate.mjs';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const PROFILE = argOf('profile', 'profiles/14.4.258.16');
const WORK = path.resolve(argOf('work', 'scratch/o1corpus/selftest'));
const N = Number(argOf('entries', '12'));

fs.mkdirSync(WORK, { recursive: true });
const MINTER = requireMatchingMinter();
const say = (s) => process.stdout.write(s + '\n');

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

/** mint a source, decode it, normalise it */
function streamOf(source, tag) {
  const src = path.join(WORK, `${tag}.js`);
  const jsc = path.join(WORK, `${tag}.jsc`);
  fs.writeFileSync(src, source, 'utf8');
  const m = mintCompileOnly({ srcPath: src, outPath: jsc, exe: MINTER });
  if (!m.ok) return { ok: false, error: m.error };
  const s = normalizedFunctionsFromJsc(jsc, { profile: PROFILE });
  return { ok: true, ...s, bytes: m.bytes, jsc };
}

function compareSources(left, right, tag) {
  const A = streamOf(left, `${tag}.a`);
  const B = streamOf(right, `${tag}.b`);
  if (!A.ok || !B.ok) return { ok: false, error: A.error ?? B.error };
  const paired = pairCorpusFunctions(A.functions, B.functions, new Map());
  const { per, causes } = compareAndClassify(paired.pairs);
  return {
    ok: true, A, B, mode: paired.mode,
    leftOnly: paired.leftOnly.length, rightOnly: paired.rightOnly.length,
    paired: per.length, exact: per.filter((p) => p.exact).length,
    allExact: per.length > 0 && per.every((p) => p.exact) && paired.leftOnly.length === 0 && paired.rightOnly.length === 0,
    causes, per,
  };
}

const entries = stratify(loadEntries({ kind: 'script' }), N);
say(`O1-corpus selftest: minter ${path.basename(MINTER)}, profile ${PROFILE}, ${entries.length} fixture(s)\n`);

// ---------------------------------------------------------------- A, E
say('A  cross-cache identity (same program, two different caches)');
let idOk = 0, erasedTotal = 0, instrTotal = 0, fnTotal = 0;
const idFails = [];
for (const e of entries) {
  const src = readSource(e);
  const r = compareSources(src, '\n' + src, `id-${e.id}`);
  if (!r.ok) { idFails.push({ id: e.id, why: r.error?.slice(0, 160) }); continue; }
  erasedTotal += (r.A.erasure.allocationIds ?? 0) + (r.B.erasure.allocationIds ?? 0);
  instrTotal += (r.A.erasure.instructions ?? 0);
  fnTotal += r.paired;
  if (r.allExact) idOk++;
  else {
    idFails.push({
      id: e.id, paired: r.paired, exact: r.exact, leftOnly: r.leftOnly, rightOnly: r.rightOnly,
      first: r.per.find((p) => !p.exact)?.firstDivergence ?? null,
      families: r.causes.map((c) => c.family).slice(0, 4),
    });
  }
}
check(idOk === entries.length && idFails.length === 0,
  `identity: ${idOk}/${entries.length} fixtures all-exact across two caches`,
  `${fnTotal} functions, ${instrTotal} instructions`);
for (const f of idFails.slice(0, 6)) say(`      ${JSON.stringify(f).slice(0, 400)}`);

check(erasedTotal > 0, `E  the allocation-id erasure fires`, `${erasedTotal} descriptor ids erased over ${instrTotal} instructions`);
check(instrTotal > 0, 'E  erasure accounting is populated', `${instrTotal} instructions accounted`);
const probe = eraseAllocationIds('CreateClosure K(<SharedFunctionInfo #123 foo>) FB[*] #0');
check(probe.erased === 1 && probe.text.includes('#* foo'), 'E  eraseAllocationIds keeps the name, drops the id', probe.text);

// ---------------------------------------------------------------- B
say('\nB  discrimination (a one-token mutation must be seen)');
let discOk = 0, discTried = 0;
const invisible = [];
for (const e of entries) {
  const src = readSource(e);
  const cands = mutations(src);
  let detected = null;
  const tried = [];
  for (const c of cands.slice(0, 4)) {
    const r = compareSources(src, c.src, `mut-${e.id}`);
    if (!r.ok) continue;
    tried.push({ label: c.label, allExact: r.allExact });
    if (!r.allExact) { detected = { label: c.label, families: r.causes.map((x) => x.family) }; break; }
  }
  if (!tried.length) continue;
  discTried++;
  if (detected) discOk++;
  else invisible.push({ id: e.id, tried: tried.map((t) => t.label) });
}
check(discTried > 0 && discOk === discTried,
  `discrimination: ${discOk}/${discTried} fixtures where a mutation was visible`);
for (const f of invisible.slice(0, 6)) say(`      invisible: ${JSON.stringify(f).slice(0, 300)}`);

// ---------------------------------------------------------------- C
say('\nC  the cause classifier names a known divergence correctly');
const CASES = [
  {
    label: 'TestEqualStrict -> TestEqual  =>  compare-opcode',
    left: 'function f(a, b) { return a === b; }\nvar x = 1;\n',
    right: 'function f(a, b) { return a == b; }\nvar x = 1;\n',
    want: 'compare-opcode',
  },
  {
    label: 'o.x -> o[k]  =>  named-vs-keyed-property',
    left: 'function f(o, k) { return o.x; }\nvar x = 1;\n',
    right: 'function f(o, k) { return o[k]; }\nvar x = 1;\n',
    want: 'named-vs-keyed-property',
  },
  {
    label: 'an extra temp  =>  extra-temp-materialisation',
    left: 'function f(a, b) { return g(a + b); }\nfunction g(z) { return z; }\n',
    right: 'function f(a, b) { var t = a + b; return g(t); }\nfunction g(z) { return z; }\n',
    want: null,                       // recorded, not asserted: V8 may fold it
  },
];
for (const c of CASES) {
  const r = compareSources(c.left, c.right, `cls-${c.want ?? 'temp'}`);
  if (!r.ok) { check(false, c.label, r.error?.slice(0, 160)); continue; }
  const fams = r.causes.map((x) => x.family);
  if (c.want === null) { say(`INFO  ${c.label}  ->  ${fams.join(', ') || '(no divergence)'}`); continue; }
  check(fams.includes(c.want), c.label, `families: ${fams.join(', ') || '(none)'}`);
}

// ---------------------------------------------------------------- D
say('\nD  execution policy');
const refuses = (fn, what) => {
  try { fn(); return { ok: false, what }; }
  catch (e) { return { ok: e instanceof ExecutionPolicyError, err: e.message.slice(0, 120) }; }
};
let r1 = refuses(() => assertCompileOnlySpawn(['--no-lazy', 'src/verify/pipeline_child.mjs', 'a.js']));
check(r1.ok, 'refuses a child that is not mint_child.cjs', r1.err);
let r2 = refuses(() => assertCompileOnlySpawn(['-e', path.resolve('src/verify/mint_child.cjs'), 'a.js']));
check(r2.ok, 'refuses an evaluating engine flag', r2.err);
let r3 = refuses(() => assertCompileOnlySpawn(['--no-lazy', 'extracted_jsc/x.js']));
check(r3.ok, 'refuses to run anything out of extracted_jsc/', r3.err);
let r4 = refuses(() => assertNotInExecutableTree('scratch/t3/work/o1/x.jsc'));
check(r4.ok, 'refuses to write corpus-derived output into the O3-executable tree', r4.err);
check(assertCompileOnlySpawn(['--no-lazy', path.resolve('src/verify/mint_child.cjs'), 'a.js', 'b.jsc', 'script']).length === 5,
  'accepts the one legal compile-only argv');

// ---------------------------------------------------------------- F
// F  WHAT STREAM B CAN AND CANNOT CONTAIN.
//
// The one thing that could make the A-side unpaired count a measurement
// artefact rather than a result: if `createCachedData()` dropped functions the
// text really does create. It does not drop them -- but it DOES omit a
// function whose closure is never created, because V8's scope analysis does
// not allocate the variable of an unreferenced inner declaration, so no
// `CreateClosure` is emitted and the SFI is unreachable from the parent's
// constant pool. Both halves are asserted here, because the first is the
// instrument's fidelity and the second is the rule by which an A-side
// unpaired function has to be read.
say('\nF  what stream B carries (the A-side-unpaired accounting rests on this)');
function mintCount(label, src, flags = ['--no-lazy']) {
  const s = path.join(WORK, `${label}.js`);
  const o = path.join(WORK, `${label}.jsc`);
  fs.writeFileSync(s, src, 'utf8');
  const m = mintCompileOnly({ srcPath: s, outPath: o, exe: MINTER, flags });
  if (!m.ok) return { error: m.error };
  const r = normalizedFunctionsFromJsc(o, { profile: PROFILE });
  return { functions: r.functions.length, units: r.units };
}
{
  // 40 referenced declarations + 40 referenced arrows + the script = 81
  let src = '';
  for (let i = 0; i < 40; i++) src += `function f${i}(a){ var g = (x)=>x+${i}; return g(a); }\n`;
  src += 'var z = 1;\n';
  const eager = mintCount('ser-flat-eager', src, ['--no-lazy']);
  const lazy = mintCount('ser-flat-lazy', src, []);
  check(eager.functions === 81, 'with --no-lazy every function the text creates is carried', `${eager.functions} of 81`);
  check(lazy.functions === 1, 'without --no-lazy only the script is carried (so the flag is load-bearing)', `${lazy.functions}`);
}
{
  // 100 declarations inside one function, none referenced -> V8 creates no
  // closure for them, so stream B cannot contain them
  let unref = 'function outer(){\n';
  for (let i = 0; i < 100; i++) unref += `  function h${i}(a){ return a+${i}; }\n`;
  unref += '  return 0;\n}\nvar z = outer();\n';
  let ref = 'function outer(){\n  var t = 0;\n';
  for (let i = 0; i < 100; i++) ref += `  function h${i}(a){ return a+${i}; }\n`;
  for (let i = 0; i < 100; i++) ref += `  t += h${i}(1);\n`;
  ref += '  return t;\n}\nvar z = outer();\n';
  const u = mintCount('ser-unref', unref);
  const r = mintCount('ser-ref', ref);
  check(r.functions === 102, 'the same 100 declarations ARE carried once they are referenced', `${r.functions} of 102`);
  check(u.functions === 2, 'an inner declaration whose closure is never created is NOT carried',
    `${u.functions} (script + outer); so an A-side unpaired function means our text does not create that closure`);
}

say(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exitCode = failures === 0 ? 0 : 1;
