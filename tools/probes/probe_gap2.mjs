// Which functions does `createCachedData()` actually carry? Controlled source,
// so the answer cannot be blamed on the decompiler.
import fs from 'node:fs';
import path from 'node:path';
import { loadUnits } from '../../src/load/index.mjs';
import { mintCompileOnly, requireMatchingMinter } from '../../src/verify/o1_corpus.mjs';

const PROFILE = 'profiles/14.4.258.16';
const WORK = path.resolve('scratch/o1corpus/gap');
fs.mkdirSync(WORK, { recursive: true });
const EXE = requireMatchingMinter();

function mintAndCount(label, src, flags) {
  const s = path.join(WORK, `${label}.js`);
  const o = path.join(WORK, `${label}.jsc`);
  fs.writeFileSync(s, src, 'utf8');
  const m = mintCompileOnly({ srcPath: s, outPath: o, exe: EXE, flags });
  if (!m.ok) return { label, error: m.error?.slice(0, 200) };
  const { units } = loadUnits(o, PROFILE, { scopeInfos: false });
  const withBc = units.filter((u) => u.bytecode);
  return {
    label, flags: flags.join(' ') || '(none)', bytes: m.bytes,
    units: units.length, withBytecode: withBc.length,
    uncompiled: units.filter((u) => !u.bytecode).length,
    names: withBc.map((u) => u.name ?? '').slice(0, 10),
  };
}

const out = [];

// 1. N top-level declarations, each with one nested arrow
for (const N of [2, 10, 40, 100, 200]) {
  let src = '';
  for (let i = 0; i < N; i++) src += `function f${i}(a){ var g = (x)=>x+${i}; return g(a); }\n`;
  src += 'var z = 1;\n';
  out.push({ shape: `${N} top-level decls + ${N} arrows`, ...mintAndCount(`flat${N}`, src, ['--no-lazy']) });
}

// 2. deep nesting
for (const D of [2, 5, 10, 20]) {
  let src = '';
  for (let i = 0; i < D; i++) src += `function n${i}(a){ `;
  src += 'return a;';
  for (let i = 0; i < D; i++) src += ' }';
  src += '\nvar z = 1;\n';
  out.push({ shape: `${D} deep nest`, ...mintAndCount(`deep${D}`, src, ['--no-lazy']) });
}

// 3. 100 declarations nested inside ONE outer function (the corpus's shape)
{
  let src = 'function outer(){\n';
  for (let i = 0; i < 100; i++) src += `  function h${i}(a){ return a+${i}; }\n`;
  src += '  return h0;\n}\nvar z = outer();\n';
  out.push({ shape: '100 decls inside one function', ...mintAndCount('inner100', src, ['--no-lazy']) });
}

// 4. 100 declarations inside one function, all referenced
{
  let src = 'function outer(){\n  var t = 0;\n';
  for (let i = 0; i < 100; i++) src += `  function h${i}(a){ return a+${i}; }\n`;
  for (let i = 0; i < 100; i++) src += `  t += h${i}(1);\n`;
  src += '  return t;\n}\nvar z = outer();\n';
  out.push({ shape: '100 decls inside one function, all called', ...mintAndCount('inner100ref', src, ['--no-lazy']) });
}

// 5. does the flag spelling matter?
{
  let src = '';
  for (let i = 0; i < 40; i++) src += `function f${i}(a){ var g = (x)=>x+${i}; return g(a); }\n`;
  src += 'var z = 1;\n';
  for (const flags of [[], ['--no-lazy'], ['--no-lazy', '--no-flush-bytecode'], ['--no-lazy', '--no-compilation-cache'], ['--max-lazy']]) {
    out.push({ shape: '40 decls + 40 arrows', ...mintAndCount('flagprobe' + flags.join('_'), src, flags) });
  }
}

console.log(JSON.stringify(out, null, 1));
