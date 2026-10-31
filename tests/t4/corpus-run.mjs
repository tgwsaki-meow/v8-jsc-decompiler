// tests/t4/corpus-run.mjs
//
//   node tests/t4/corpus-run.mjs [--dir extracted_jsc] [--profile 14.4.258.16]
//                                [--limit N] [--json out.json] [--scopes|--no-scopes]
//
// The regression run: every `.jsc` in the corpus, decoded against the profile
// for the build that produced it. Reports files parsed, units found, compiled
// vs uncompiled, unresolved constants by category with counts, unresolved
// read-only references, the context-slot naming rate and wall time.
//
// Memory: one file at a time, and nothing from a file is retained once its
// statistics are folded in. Units hold Buffer views into the payload, so
// keeping even one of them would keep the whole payload alive -- the corpus has
// a 10.7 MB input, and this host has 4 GB.
//
// This never executes corpus code. It only reads bytes.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvironment, readCache } from '../../src/cache/index.mjs';
import { buildUnits, contextSlotNamingStats, HeapContext } from '../../src/heap/index.mjs';

function parseArgs(argv) {
  const o = { dir: 'extracted_jsc', profile: null, limit: Infinity, json: null, scopes: true, progressEvery: 100 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--profile') o.profile = argv[++i];
    else if (argv[i] === '--limit') o.limit = Number(argv[++i]);
    else if (argv[i] === '--json') o.json = argv[++i];
    else if (argv[i] === '--no-scopes') o.scopes = false;
    else if (argv[i] === '--progress-every') o.progressEvery = Number(argv[++i]);
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const env = loadEnvironment(o.profile ?? '14.4.258.16');

  const files = fs.readdirSync(o.dir).filter((f) => f.endsWith('.jsc')).sort().slice(0, o.limit);

  const total = {
    files: files.length, parsed: 0, failed: 0, bytes: 0,
    objects: 0, units: 0, compiled: 0, uncompiled: 0,
    constants: 0, handlers: 0, sourcePositions: 0, smiRuns: 0,
    scopes: 0, contextSlots: 0, namedSlots: 0, viaInlined: 0, viaHashtable: 0,
    hashtableScopes: 0, outerChainLinks: 0, maxScopeDepth: 0,
    roResolved: 0, roUnresolved: 0,
    headerWarnings: 0, headerErrors: 0, unitWarnings: 0,
    trailingNotNop: 0, unresolvedForwardRefs: 0,
  };
  const unresolvedByCategory = new Map();
  const classCounts = new Map();
  const mapsWithoutClass = new Map();
  const roUnresolvedKeys = new Map();
  const failures = [];
  const kindCounts = new Map();
  const predictionCounts = new Map();
  const perFileScopeRates = [];

  const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

  const t0 = Date.now();
  for (const f of files) {
    const file = path.join(o.dir, f);
    try {
      const r = readCache(file, env);
      total.bytes += r.header.fileLength;
      total.headerWarnings += r.verification.warnings.length;
      total.headerErrors += r.verification.errors.length;
      if (!r.graph.trailingAllNop) total.trailingNotNop++;
      total.unresolvedForwardRefs += r.graph.unresolvedForwardRefs;
      total.objects += r.graph.objects.length;

      const built = buildUnits(env, r.graph, { decodeScopes: o.scopes });
      total.parsed++;
      total.units += built.stats.units;
      total.compiled += built.stats.compiled;
      total.uncompiled += built.stats.uncompiled;
      for (const [k, v] of Object.entries(built.stats.classCounts)) bump(classCounts, k, v);
      for (const c of built.reports.unresolved.categories) bump(unresolvedByCategory, c.category, c.count);
      for (const m of built.reports.maps.top) bump(mapsWithoutClass, m.mapName, m.count);

      for (const u of built.units) {
        total.constants += u.constants.length;
        total.handlers += u.handlers.length;
        total.sourcePositions += u.sourcePositions.length;
        total.smiRuns += u.constantPoolSmiRuns.length;
        total.unitWarnings += u.warnings.length;
        bump(kindCounts, `${u.kind}${u.isGenerator ? '+gen' : ''}${u.isAsync ? '+async' : ''}`);
        for (const h of u.handlers) bump(predictionCounts, h.predictionName ?? `prediction=${h.prediction}`);
      }

      if (o.scopes) {
        const n = contextSlotNamingStats(built.units);
        total.scopes += n.scopes;
        total.contextSlots += n.contextSlots;
        total.namedSlots += n.namedSlots;
        total.viaInlined += n.viaInlined;
        total.viaHashtable += n.viaHashtable;
        if (n.contextSlots > 0) perFileScopeRates.push(n.namedSlots / n.contextSlots);
        // chain depth + hashtable usage
        for (const u of built.units) {
          let d = 0;
          for (let s = u.scope; s; s = s.outer) {
            d++;
            if (s.contextLocalNamesSource === 'hashtable') total.hashtableScopes++;
          }
          if (d > 1) total.outerChainLinks += d - 1;
          if (d > total.maxScopeDepth) total.maxScopeDepth = d;
        }
      }

      // read-only resolution is per-file in these counters
      const ro = built.reports.roRefs;
      total.roResolved += ro.resolvedOccurrences;
      total.roUnresolved += ro.unresolvedOccurrences;
      for (const u of ro.top) bump(roUnresolvedKeys, `${u.chunkIndex}:${u.chunkOffset}`, u.occurrences);
    } catch (e) {
      total.failed++;
      failures.push({ file: f, error: (e.message ?? String(e)).split('\n')[0] });
    }
    if (total.parsed % o.progressEvery === 0 && total.parsed > 0) {
      process.stderr.write(`  ${total.parsed}/${files.length} files, ${total.units} units, ${Date.now() - t0} ms\n`);
    }
  }
  const ms = Date.now() - t0;

  const lines = [];
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(2) + '%' : 'n/a');
  lines.push(`corpus run: ${o.dir} against ${env.profile.dir} (V8 ${env.profile.version}, kTaggedSize=${env.profile.taggedSize})`);
  lines.push(`build facts ${env.overlay.file}   read-only table ${env.roHeapFile}`);
  lines.push('');
  lines.push(`files            ${total.parsed}/${total.files} parsed, ${total.failed} failed   `
    + `${(total.bytes / 1048576).toFixed(1)} MiB read`);
  lines.push(`objects          ${total.objects}`);
  lines.push(`units            ${total.units}   compiled ${total.compiled} (${pct(total.compiled, total.units)})   `
    + `uncompiled ${total.uncompiled} (${pct(total.uncompiled, total.units)})`);
  lines.push(`decoded          ${total.constants} constants, ${total.handlers} handler rows, `
    + `${total.sourcePositions} source positions, ${total.smiRuns} constant-pool Smi runs`);
  lines.push(`header           ${total.headerErrors} errors, ${total.headerWarnings} warnings; `
    + `${total.trailingNotNop} file(s) with non-kNop padding after kSynchronize; `
    + `${total.unresolvedForwardRefs} unresolved forward reference(s)`);
  lines.push(`wall time        ${ms} ms  (${(ms / Math.max(1, total.parsed)).toFixed(1)} ms/file, `
    + `${(total.bytes / 1024 / Math.max(1, ms)).toFixed(2)} KiB/ms)`);
  lines.push('');
  lines.push('-- read-only references ---------------------------------------------');
  lines.push(`${total.roResolved}/${total.roResolved + total.roUnresolved} occurrences resolved `
    + `(${pct(total.roResolved, total.roResolved + total.roUnresolved)}), `
    + `${roUnresolvedKeys.size} distinct unresolved`);
  for (const [k, v] of [...roUnresolvedKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`  unresolved ${k}  x${v}`);
  }
  lines.push('');
  lines.push('-- context slot naming ----------------------------------------------');
  lines.push(`scopes ${total.scopes}   context slots ${total.contextSlots}   named ${total.namedSlots} `
    + `(${pct(total.namedSlots, total.contextSlots)})   anonymous ${total.contextSlots - total.namedSlots}`);
  lines.push(`  from the inlined name array ${total.viaInlined}, from the name hash table ${total.viaHashtable} `
    + `(${total.hashtableScopes} scope visits took the hash-table branch)`);
  lines.push(`  outer_scope_info links walked ${total.outerChainLinks}, deepest chain ${total.maxScopeDepth}`);
  if (perFileScopeRates.length) {
    const sorted = [...perFileScopeRates].sort((a, b) => a - b);
    const q = (p) => (100 * sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]).toFixed(2) + '%';
    lines.push(`  per-file named rate: min ${q(0)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${q(0.999)} `
      + `(${perFileScopeRates.length} files have at least one context slot)`);
  }
  lines.push('');
  lines.push('-- unresolved, by category ------------------------------------------');
  const urRows = [...unresolvedByCategory.entries()].sort((a, b) => b[1] - a[1]);
  lines.push(`${urRows.reduce((s, r) => s + r[1], 0)} occurrences in ${urRows.length} categories`);
  for (const [k, v] of urRows) lines.push(`  ${String(v).padStart(9)}  ${k}`);
  lines.push('');
  lines.push('-- maps with no layouts.json class ----------------------------------');
  for (const [k, v] of [...mapsWithoutClass.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(v).padStart(9)}  ${k}`);
  }
  lines.push('');
  lines.push('-- object classes ---------------------------------------------------');
  for (const [k, v] of [...classCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(v).padStart(9)}  ${k}`);
  }
  lines.push('');
  lines.push('-- function kinds ---------------------------------------------------');
  for (const [k, v] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(v).padStart(9)}  ${k}`);
  }
  lines.push('');
  lines.push('-- handler catch predictions ----------------------------------------');
  for (const [k, v] of [...predictionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(v).padStart(9)}  ${k}`);
  }
  if (failures.length) {
    lines.push('');
    lines.push('-- failures ---------------------------------------------------------');
    for (const f of failures.slice(0, 40)) lines.push(`  ${f.file}: ${f.error}`);
    if (failures.length > 40) lines.push(`  ... ${failures.length - 40} more`);
  }
  lines.push('');
  lines.push(`unit warnings total ${total.unitWarnings}`);

  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (o.json) {
    fs.writeFileSync(o.json, JSON.stringify({
      profile: env.profile.dir, overlay: env.overlay.file, roHeap: env.roHeapFile,
      total, ms,
      unresolvedByCategory: Object.fromEntries(unresolvedByCategory),
      mapsWithoutClass: Object.fromEntries(mapsWithoutClass),
      roUnresolvedKeys: Object.fromEntries(roUnresolvedKeys),
      classCounts: Object.fromEntries(classCounts),
      kindCounts: Object.fromEntries(kindCounts),
      predictionCounts: Object.fromEntries(predictionCounts),
      failures,
    }, null, 1), 'utf8');
  }
  if (total.failed) process.exitCode = 1;
}

main();
