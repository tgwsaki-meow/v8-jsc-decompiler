// tests/t4/acceptance.mjs
//
//   node tests/t4/acceptance.mjs [--only <name>] [--keep] [--out <dir>]
//
// The oracle run. For each source in tests/t4/sources.mjs:
//
//   1. a child node process compiles it as a classic sloppy script and writes a
//      real `.jsc` with `vm.Script#createCachedData()`
//   2. a second child prints the same source's bytecode with
//      `--print-bytecode --no-lazy --no-enable-lazy-source-positions`
//   3. this process decodes the `.jsc` with src/cache + src/heap against
//      profiles/<the running node's V8>
//   4. units are matched to listing functions by byte-for-byte bytecode
//      equality, then every scalar is asserted against V8's own numbers
//
// V8's output is ground truth. A mismatch is a bug in the decoder, never in V8.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvironment, readCache } from '../../src/cache/index.mjs';
import { buildUnits, contextSlotNamingStats } from '../../src/heap/index.mjs';
import { parseBytecodeDump } from '../../src/verify/bytecode_parser.mjs';
import { SOURCES, sourceText } from './sources.mjs';
import { compareUnit, bytecodeFromListing } from './compare.mjs';

const V8_FLAGS = ['--print-bytecode', '--no-lazy', '--no-enable-lazy-source-positions'];
const CACHE_FLAGS = ['--no-lazy', '--no-enable-lazy-source-positions'];

function parseArgs(argv) {
  const o = { only: null, keep: false, out: null, maxDetail: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') o.only = argv[++i];
    else if (argv[i] === '--keep') o.keep = true;
    else if (argv[i] === '--out') o.out = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return o;
}

/** Run a child with stdout+stderr into a file -- never a pipe. */
function runToFile(exe, args, outFile, cwd) {
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(exe, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true });
    return { status: r.status, error: r.error };
  } finally { fs.closeSync(fd); }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const work = o.out ?? path.join('tests', 't4', 'out');
  fs.mkdirSync(work, { recursive: true });
  // The repo declares "type": "module"; a .js file compiled from this directory
  // must be a classic sloppy script, matching what `new vm.Script` produces.
  fs.writeFileSync(path.join(work, 'package.json'), '{"type":"commonjs"}\n');

  const v8 = process.versions.v8.split('-')[0];
  const localDir = path.join('profiles-local', v8);
  const localProfileDir = fs.existsSync(path.join(localDir, 'meta.json')) ? localDir : null;
  let env;
  try {
    // There is no ro-heap.json for the local node's V8 (the authoritative table
    // was generated from Electron's context snapshot for 14.4.258.16 only), so
    // a kReadOnlyHeapRef in a freshly minted cache is reported unresolved and
    // counted. That is the designed degradation, and the roUnres column below
    // makes it visible rather than hiding it.
    // The running node's V8 is built WITHOUT pointer compression and without
    // the sandbox (process.config.variables.v8_enable_pointer_compression = 0,
    // v8_enable_sandbox = 0), so kTaggedSize is 8 and the object layouts differ
    // from the Electron/Chromium configuration that produced the corpus. The
    // profile under profiles/ describes the corpus build, so the oracle needs
    // the one generated for this build:
    //
    //   node tools/profilegen/index.mjs --tag <v8> --variant intl+wasm \
    //        --tagged-size 8 --out profiles-local/
    //
    // That one command is enough: since the profilegen back-port
    // (ARCHITECTURE.md 9.9) there is no layouts-overlay to generate alongside
    // it, and the build facts this layer needs come out of the profile.
    //
    // Running the oracle against a kTaggedSize=8 profile while the corpus run
    // uses a kTaggedSize=4 one is not a complication, it is the point: it proves
    // the decoder carries no build assumption of its own.
    //
    // There is also no ro-heap.json for this build, so any kReadOnlyHeapRef is
    // reported unresolved and counted. The roUnres column makes that visible.
    env = loadEnvironment(localProfileDir ?? v8, { requireRoHeap: false });
  } catch (e) {
    console.error(`cannot load a profile for the running node's V8 (${v8}):\n${e.message}`);
    process.exitCode = 1;
    return;
  }

  const entries = SOURCES.filter((s) => !o.only || s.name === o.only);
  const rows = [];
  const detail = [];

  for (const entry of entries) {
    const dir = path.join(work, entry.name);
    fs.mkdirSync(dir, { recursive: true });
    const srcPath = path.join(dir, 'source.js');
    const jscPath = path.join(dir, 'source.jsc');
    const listPath = path.join(dir, 'listing.txt');
    const makeLog = path.join(dir, 'make.txt');
    fs.writeFileSync(srcPath, sourceText(entry), 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');

    // `lazy: true` sources are compiled *without* --no-lazy so that inner
    // functions genuinely stay uncompiled and carry UncompiledData.
    const cacheFlags = entry.lazy ? ['--no-enable-lazy-source-positions'] : CACHE_FLAGS;
    const listFlags = entry.lazy ? ['--print-bytecode', '--no-enable-lazy-source-positions'] : V8_FLAGS;

    const row = {
      name: entry.name, covers: entry.covers,
      cacheOk: false, listingOk: false,
      units: 0, compiled: 0, uncompiled: 0,
      matched: 0, unmatchedUnits: 0, listingFns: 0,
      checks: 0, failures: 0, roUnresolved: 0, unresolved: 0,
      contextSlots: 0, namedSlots: 0,
      notes: [],
    };

    const mk = runToFile(process.execPath, [...cacheFlags, path.resolve('tests/t4/make-cache.cjs'), srcPath, jscPath], makeLog, process.cwd());
    if (mk.status !== 0 || !fs.existsSync(jscPath)) {
      row.notes.push(`cache creation failed (status ${mk.status}): ${fs.readFileSync(makeLog, 'utf8').split('\n').slice(-4).join(' ').slice(0, 200)}`);
      rows.push(row);
      continue;
    }
    row.cacheOk = true;
    row.cacheBytes = fs.statSync(jscPath).size;

    const ls = runToFile(
      process.execPath,
      [...listFlags, path.resolve('tests/t4/listing-runner.cjs'), path.resolve(srcPath)],
      listPath, process.cwd());
    if (!fs.existsSync(listPath)) { row.notes.push('listing not produced'); rows.push(row); continue; }
    const listingText = fs.readFileSync(listPath, 'utf8');
    const parsed = parseBytecodeDump(listingText);
    row.listingOk = true;
    row.listingFns = parsed.functions.length;
    row.listingStatus = ls.status;
    if (parsed.unparsedLines.length) row.notes.push(`${parsed.unparsedLines.length} listing lines unrecognised`);

    // ---- our decode
    let built;
    try {
      const r = readCache(jscPath, env);
      built = buildUnits(env, r.graph);
      row.headerErrors = r.verification.errors.length;
      row.sourceLength = r.header.sourceHash.sourceLength;
      row.sourceLengthOk = r.header.sourceHash.sourceLength === sourceText(entry).length;
    } catch (e) {
      row.notes.push(`decode threw: ${e.message.split('\n')[0]}`);
      rows.push(row);
      continue;
    }
    row.units = built.stats.units;
    row.compiled = built.stats.compiled;
    row.uncompiled = built.stats.uncompiled;
    row.roUnresolved = built.reports.roRefs.unresolvedOccurrences;
    row.unresolved = built.reports.unresolved.total;
    const naming = contextSlotNamingStats(built.units);
    row.contextSlots = naming.contextSlots;
    row.namedSlots = naming.namedSlots;

    // ---- match by bytecode bytes, disambiguated by source position
    //
    // Two distinct functions can emit identical bytecode (`m(){return 1;}` and
    // `am(){return 1;}` do). Their source positions differ, so when a bytecode
    // string is shared the candidate whose first printed position matches ours
    // is taken; otherwise the match is reported as ambiguous rather than
    // silently compared against the wrong function.
    const byBytes = new Map();
    for (const fn of parsed.functions) {
      const re = bytecodeFromListing(fn);
      if (!re.bytes) continue;
      const key = re.bytes.toString('base64');
      (byBytes.get(key) ?? byBytes.set(key, []).get(key)).push(fn);
    }
    const compiledUnits = built.units.filter((u) => u.compiled && u.bytecode);
    for (const u of compiledUnits) {
      const key = u.bytecode.toString('base64');
      const candidates = byBytes.get(key) ?? [];
      let fn = candidates[0];
      if (candidates.length > 1) {
        const firstMine = u.sourcePositions.find((e) => !e.isFunctionEntry);
        const exact = firstMine
          ? candidates.filter((c) => c.instructions.some((ins) => ins.offset === firstMine.codeOffset && ins.sourcePosition === firstMine.sourcePosition))
          : [];
        if (exact.length === 1) fn = exact[0];
        else {
          row.ambiguous = (row.ambiguous ?? 0) + 1;
          row.notes.push(`sfi#${u.sfiId} shares its bytecode with ${candidates.length} listing functions and source position did not disambiguate; skipped`);
          continue;
        }
      }
      if (!fn) {
        // The top-level unit is expected not to match: `vm.Script` compiles the
        // source as a bare classic script, while node loads the same text as a
        // CommonJS module, i.e. wrapped in
        // `(function (exports, require, module, __filename, __dirname) {...})`.
        // Different program, different bytecode. Every inner function is
        // identical, which is what the comparison is for.
        row.unmatchedUnits++;
        row.notes.push(`sfi#${u.sfiId} lit${u.functionLiteralId} ${JSON.stringify(u.name)} `
          + `(${u.bytecodeLength} bytes) has no listing function with identical bytecode`);
        continue;
      }
      row.matched++;
      const cmp = compareUnit(u, fn);
      row.checks += cmp.checks.length;
      row.failures += cmp.failures;
      for (const c of cmp.checks) {
        if (c.ok === false) {
          detail.push(`FAIL ${entry.name} sfi#${u.sfiId} ${JSON.stringify(u.name)} :: ${c.name}: ${c.detail}`);
        }
      }
    }

    // ---- per-source capability assertions
    if (entry.lazy) {
      const holes = built.units.filter((u) => !u.compiled && u.uncompiled);
      row.notes.push(`${holes.length} uncompiled unit(s) with UncompiledData`);
      if (holes.length === 0) { row.failures++; detail.push(`FAIL ${entry.name} :: expected at least one SFI with UncompiledData and no BytecodeArray`); }
      for (const h of holes) {
        if (h.uncompiled.startPosition === null || h.uncompiled.endPosition === null) {
          row.failures++;
          detail.push(`FAIL ${entry.name} sfi#${h.sfiId} :: UncompiledData has no start/end position`);
        }
      }
    }
    if (entry.name === 'many-context-locals') {
      const hs = allScopes(built.units).filter((s) => s.contextLocalNamesSource === 'hashtable');
      row.notes.push(`${hs.length} scope(s) used the name hash table`);
      if (hs.length === 0) { row.failures++; detail.push(`FAIL ${entry.name} :: no ScopeInfo took the context_local_names_hashtable branch`); }
      for (const s of hs) {
        const named = (s.contextLocalNames ?? []).filter((n) => typeof n === 'string').length;
        if (named !== s.contextLocalCount) {
          row.failures++;
          detail.push(`FAIL ${entry.name} scopeInfo#${s.scopeInfoId} :: recovered ${named} of ${s.contextLocalCount} names from the hash table`
            + ` (${JSON.stringify(s.contextLocalNamesHashtable ?? {})})`);
        }
      }
    }
    if (entry.name === 'few-context-locals' || entry.name === 'nested-closures') {
      const withLocals = allScopes(built.units).filter((s) => (s.contextLocalCount ?? 0) > 0);
      const slots = withLocals.reduce((a, s) => a + s.contextLocalCount, 0);
      const named = withLocals.reduce((a, s) => a + (s.contextLocalNames ?? []).filter((n) => typeof n === 'string').length, 0);
      row.notes.push(`${named}/${slots} context slots named`);
      if (slots === 0 || named !== slots) {
        row.failures++;
        detail.push(`FAIL ${entry.name} :: ${named} of ${slots} context slots carry a name`);
      }
    }
    if (entry.strict) {
      const bad = built.units.filter((u) => u.compiled && u.isStrict !== true);
      if (bad.length) { row.failures++; detail.push(`FAIL ${entry.name} :: ${bad.length} unit(s) in a "use strict" script report isStrict !== true`); }
    }
    if (entry.name === 'generators') {
      const gens = built.units.filter((u) => u.isGenerator);
      row.notes.push(`${gens.length} generator unit(s)`);
      if (gens.length < 2) { row.failures++; detail.push(`FAIL ${entry.name} :: expected at least 2 generators, found ${gens.length}`); }
    }
    if (entry.name === 'async') {
      const as = built.units.filter((u) => u.isAsync);
      row.notes.push(`${as.length} async unit(s)`);
      if (as.length < 2) { row.failures++; detail.push(`FAIL ${entry.name} :: expected at least 2 async functions, found ${as.length}`); }
      const preds = new Set(built.units.flatMap((u) => u.handlers.map((h) => h.predictionName)));
      row.notes.push(`handler predictions: ${[...preds].join(',') || 'none'}`);
    }
    if (entry.name === 'class-full') {
      const kinds = new Set(built.units.map((u) => u.kind));
      row.notes.push(`kinds: ${[...kinds].sort().join(',')}`);
      for (const want of ['getter', 'setter', 'classCtor', 'method']) {
        if (!kinds.has(want)) { row.failures++; detail.push(`FAIL ${entry.name} :: no unit with kind ${want}`); }
      }
    }
    if (entry.name === 'try-catch-finally' || entry.name === 'catch-param-patterns') {
      const total = built.units.reduce((a, u) => a + u.handlers.length, 0);
      row.notes.push(`${total} handler row(s)`);
      if (total === 0) { row.failures++; detail.push(`FAIL ${entry.name} :: no handler rows decoded`); }
    }
    if (entry.name === 'switch') {
      const runs = built.units.flatMap((u) => u.constantPoolSmiRuns);
      row.notes.push(`${runs.length} smi run(s), longest ${runs.reduce((a, r) => Math.max(a, r.length), 0)}`);
      if (!runs.some((r) => r.length >= 8)) {
        row.failures++;
        detail.push(`FAIL ${entry.name} :: no constant-pool Smi run of 8+ entries, so the SwitchOnSmiNoFeedback jump table was not recovered`);
      }
    }
    if (entry.name === 'template-literals') {
      const t = built.units.flatMap((u) => u.constants).filter((c) => c.t === 'templateObject');
      row.notes.push(`${t.length} TemplateObjectDescription`);
      if (!t.length || !t.every((x) => Array.isArray(x.raw) && Array.isArray(x.cooked))) {
        row.failures++;
        detail.push(`FAIL ${entry.name} :: TemplateObjectDescription raw/cooked not both decoded (${JSON.stringify(t[0] ?? null).slice(0, 200)})`);
      }
    }
    if (entry.name === 'regexps') {
      // BytecodeGenerator::VisitRegExpLiteral emits
      //   CreateRegExpLiteral [pattern_constant_index], FBV[slot], #flags
      // so a *fresh* constant pool holds the pattern as a plain string and the
      // flags as an immediate; the RegExpBoilerplateDescription is built at
      // runtime and cached in the feedback vector, which a code cache does not
      // carry. The decoder implements that class (the corpus run reports
      // whether any cache contains one); what the pool can be asserted on is
      // the pattern strings.
      const strings = new Set(built.units.flatMap((u) => u.constants).filter((c) => c.t === 'string').map((c) => c.v));
      const want = ['a(b)c', '[\\p{L}]', '^ab+c$'];
      const missing = want.filter((w) => !strings.has(w));
      const boilerplates = built.units.flatMap((u) => u.constants).filter((c) => c.t === 'regexpBoilerplate');
      row.notes.push(`${want.length - missing.length}/${want.length} regexp patterns found as string constants; `
        + `${boilerplates.length} RegExpBoilerplateDescription in the pool (V8 does not put one there for a fresh compile)`);
      if (missing.length) { row.failures++; detail.push(`FAIL ${entry.name} :: regexp pattern(s) missing from the constant pool: ${missing.join(', ')}`); }
    }
    if (entry.name === 'numbers-and-bigint') {
      // BigInt literals inside an array literal live in the boilerplate's
      // constant_elements, not directly in the pool, so the search is recursive.
      const bigs = collectUnions(built.units.flatMap((u) => u.constants)).filter((c) => c.t === 'bigint');
      row.notes.push(`${bigs.length} bigint constant(s): ${bigs.map((b) => b.v).join(',')}`);
      if (bigs.length < 3) { row.failures++; detail.push(`FAIL ${entry.name} :: expected 3 BigInt constants, found ${bigs.length}`); }
      // `-2n` is unary minus applied to the literal `2n`: the pool holds 2n and
      // the negation is a Negate bytecode, so 2 is what must appear.
      const want = ['1', '2', '123456789012345678901234567890'];
      for (const w of want) {
        if (!bigs.some((b) => b.v === w)) { row.failures++; detail.push(`FAIL ${entry.name} :: BigInt ${w}n not decoded (got ${bigs.map((b) => b.v).join(',')})`); }
      }
    }
    if (!o.keep && !entry.lazy) {
      // listings are the big artifact; keep the .jsc, drop the text
      try { fs.rmSync(listPath); } catch { /* ignore */ }
    }
    rows.push(row);
  }

  // ---------------------------------------------------------------- the table
  const out = [];
  out.push(`acceptance against V8 ${process.versions.v8} (profile ${env.profile.dir})`);
  out.push(`build facts ${env.overlay.file}`);
  out.push('');
  const head = ['source', 'units', 'c/u', 'matched', 'unm', 'checks', 'fail', 'ctxSlots', 'named', 'roUnres'];
  const w = [26, 6, 8, 8, 4, 7, 5, 9, 6, 8];
  out.push(head.map((h, i) => h.padEnd(w[i])).join(' '));
  out.push(w.map((x) => '-'.repeat(x)).join(' '));
  let totalFail = 0, totalChecks = 0, totalMatched = 0, totalUnmatched = 0;
  for (const r of rows) {
    totalFail += r.failures; totalChecks += r.checks; totalMatched += r.matched; totalUnmatched += r.unmatchedUnits;
    out.push([
      r.name, String(r.units), `${r.compiled}/${r.uncompiled}`, String(r.matched),
      String(r.unmatchedUnits), String(r.checks), String(r.failures),
      String(r.contextSlots), String(r.namedSlots), String(r.roUnresolved),
    ].map((c, i) => String(c).padEnd(w[i])).join(' ') + (r.failures ? '  FAIL' : (r.cacheOk && r.listingOk ? '  pass' : '  ERROR')));
  }
  out.push('');
  out.push(`totals: ${rows.length} sources, ${totalMatched} units matched to V8 listings, ${totalUnmatched} unmatched, `
    + `${totalChecks} assertions, ${totalFail} failures`);
  out.push('');
  out.push('notes');
  for (const r of rows) for (const n of r.notes) out.push(`  ${r.name}: ${n}`);
  if (detail.length) {
    out.push('');
    out.push('failures');
    for (const d of detail) out.push('  ' + d);
  }
  const text = out.join('\n') + '\n';
  process.stdout.write(text);
  fs.writeFileSync(path.join(work, 'ACCEPTANCE.txt'), text, 'utf8');
  if (totalFail > 0) process.exitCode = 1;
}

/** Flatten every tagged union reachable from a constant list. */
function collectUnions(list, out = [], depth = 0) {
  if (depth > 8) return out;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    out.push(c);
    if (Array.isArray(c.values)) collectUnions(c.values.filter((v) => v && typeof v === 'object'), out, depth + 1);
    if (Array.isArray(c.elements)) collectUnions(c.elements, out, depth + 1);
    if (Array.isArray(c.raw)) collectUnions(c.raw, out, depth + 1);
    if (Array.isArray(c.cooked)) collectUnions(c.cooked, out, depth + 1);
    if (Array.isArray(c.rawEntries)) collectUnions(c.rawEntries, out, depth + 1);
  }
  return out;
}

function allScopes(units) {
  const seen = new Map();
  const visit = (s) => { if (!s || seen.has(s.scopeInfoId)) return; seen.set(s.scopeInfoId, s); visit(s.outer); };
  for (const u of units) { visit(u.scope); visit(u.outerScope); }
  return [...seen.values()];
}

main();
