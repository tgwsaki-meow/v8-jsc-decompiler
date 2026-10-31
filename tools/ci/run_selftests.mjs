// `npm test` -- every self-test that needs neither a V8 binary nor the corpus.
//
// Each one is a separate child process so that a crash in one still lets the
// rest report, and so the exit code is the only thing this file decides.
//
//   node tools/ci/run_selftests.mjs [--list]
//
// The engine-backed suites are deliberately NOT here; they are `npm run
// oracle*` and .github/workflows/oracle.yml, because they download a d8 and an
// Electron build. The decompiler itself never needs either
// (docs/ARCHITECTURE.md §11.0), which is the point of the split.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SUITES = [
  ['profilegen', 'tools/profilegen/selftest.mjs', 'profiles derive mechanically from pinned V8 sources'],
  ['frontend', 'tests/t4/selftest.mjs', '.jsc -> typed heap objects (src/cache + src/heap)'],
  ['disasm', 'tools/disasm/selftest.mjs', 'typed objects -> Ignition instructions'],
  ['ir', 'tools/ir/selftest.mjs', 'CFG, dominators, SSA, effect graph'],
  ['recover', 'tools/recover/selftest.mjs', 'SSA -> expressions, statements and names'],
  ['structure', 'tools/structure/selftest.mjs', 'CFG -> a structured control tree'],
  ['emit', 'tools/emit/selftest.mjs', 'control tree + expressions -> JavaScript'],
  // `--experimental-vm-modules` is not optional for this one. 14 of the 270
  // fixtures are ES modules, and minting a code cache for a module needs
  // `vm.SourceTextModule`, which node hides behind that flag. Without it the
  // check reports "will not compile to a .jsc" for all 14 and fails -- which
  // is the right behaviour on its part, and the reason it is spelled out here
  // rather than worked around. A local run that happens to find Electron in
  // .v8bin-cache/ mints all 270 and passes, so the flag is also what stops the
  // result depending on which minter is lying around.
  ['corpus', 'corpus/check.mjs', 'the 270 syntax-feature fixtures are well formed',
    ['--experimental-vm-modules']],
];

if (process.argv.includes('--list')) {
  for (const [name, file, what, flags] of SUITES) {
    console.log(`${name.padEnd(12)} ${file.padEnd(34)} ${what}${flags ? `   [${flags.join(' ')}]` : ''}`);
  }
  process.exit(0);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const results = [];
let failed = 0;

for (const [name, file, what, flags = []] of SUITES) {
  if (only.length && !only.includes(name)) continue;
  if (!fs.existsSync(file)) {
    results.push({ name, state: 'absent', what });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...flags, file], { stdio: 'inherit' });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name, state: ok ? 'pass' : 'FAIL', ms, what, code: r.status });
}

console.log('\n================================ summary ================================');
for (const r of results) {
  const t = r.ms === undefined ? '' : `${(r.ms / 1000).toFixed(1)}s`;
  console.log(`  ${r.state.padEnd(7)} ${r.name.padEnd(12)} ${t.padStart(7)}  ${r.what}`);
}
const absent = results.filter((r) => r.state === 'absent').map((r) => r.name);
if (absent.length) console.log(`\n  not built yet: ${absent.join(', ')}`);
console.log(`\n  ${results.filter((r) => r.state === 'pass').length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
