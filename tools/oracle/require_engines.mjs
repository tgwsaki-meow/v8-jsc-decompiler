#!/usr/bin/env node
// tools/oracle/require_engines.mjs
//
// "Is the engine this measurement needs actually here, on THIS host?" -- asked
// once, loudly, before the suites that need it run.
//
// The suites used to answer it themselves and answer it as a SKIP. On the
// ubuntu runner `tools/disasm/oracle_agreement.mjs` printed
//
//   SKIP: cache engine missing: .v8bin-cache/electron-v40.0.0-win32-x64/electron.exe
//
// for both of its 14.4 modes -- a hardcoded Windows path, for a file that job
// never downloaded -- and then printed its green last line having measured
// only 14.6. `.github/workflows/oracle.yml` runs this step so the miss is a
// red step naming the fetch command, not a line inside a passing one.
//
// Usage:
//   node tools/oracle/require_engines.mjs d8@14.4.258. electron@40.
//   node tools/oracle/require_engines.mjs --list          # report, exit 0

import { findCachedEngine, engineCandidates } from './engines.mjs';

const LIST = process.argv.includes('--list');
const specs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!specs.length) {
  console.error('usage: require_engines.mjs <kind>@<versionPrefix> [...]   (kind: d8 | electron)');
  process.exit(64);
}

let missing = 0;
for (const spec of specs) {
  const [kind, prefix = ''] = spec.split('@');
  if (kind !== 'd8' && kind !== 'electron') {
    console.error(`::error::unknown engine kind \`${kind}\` in \`${spec}\` (expected d8 or electron)`);
    process.exit(64);
  }
  const r = findCachedEngine(kind, prefix);
  if (r.found) {
    const f = r.found;
    console.log(`OK   ${kind} ${prefix}* -> ${f.exe}  (v${f.version}, ${f.platform})`);
    continue;
  }
  missing++;
  // Say what IS there as well as what is not: "no electron" and "an electron
  // for another platform" are different problems with different fixes.
  const any = engineCandidates(kind).map((c) => `${c.dir}${c.runnable ? '' : ' (not executable)'}`);
  console.log(`${LIST ? 'MISS' : '::error::'}${kind} ${prefix}*: ${r.why}`);
  if (r.considered.length) console.log(`     considered: ${r.considered.join(', ')}`);
  console.log(`     this host's ${kind} directories in .v8bin-cache: ${any.length ? any.join(', ') : '(none)'}`);
}

if (missing && !LIST) process.exit(1);
console.log(missing ? `${missing} of ${specs.length} engine(s) missing (--list, so not failing)`
  : `${specs.length} engine(s) present`);
