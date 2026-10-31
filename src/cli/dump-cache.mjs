#!/usr/bin/env node
// src/cli/dump-cache.mjs
//
//   node src/cli/dump-cache.mjs <file.jsc> [options]
//
//     --profile <tag|dir>   which profile to decode against (default: the one
//                           whose Version::Hash() matches the file's header)
//     --json <out.json>     write the full decode, FunctionUnits included
//     --function <id>       print one unit in full, by function_literal_id
//     --sfi <id>            print one unit in full, by sfiId
//     --max-units <n>       cap the unit summary table (default 40)
//     --constants <n>       constants to print per unit (default 12)
//     --no-scopes           skip ScopeInfo decoding (faster, loses names)
//     --quiet               totals and reports only
//
// Prints: the header with its verification, the unit count split into compiled
// and uncompiled, the constant-pool tagged unions, the handler table rows, the
// scope chains, and the unresolved report.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvironment, readCache, formatHeader, availableProfiles, CacheVersionError } from '../cache/index.mjs';
import { buildUnits, contextSlotNamingStats } from '../heap/index.mjs';
import { versionHashFromString } from '../cache/version-hash.mjs';
import { loadProfile } from '../profile/index.mjs';

function parseArgs(argv) {
  const o = {
    file: null, profile: null, json: null, functionId: null, sfiId: null,
    maxUnits: 40, constants: 12, scopes: true, quiet: false, roHeap: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') o.profile = argv[++i];
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--function') o.functionId = Number(argv[++i]);
    else if (a === '--sfi') o.sfiId = Number(argv[++i]);
    else if (a === '--max-units') o.maxUnits = Number(argv[++i]);
    else if (a === '--constants') o.constants = Number(argv[++i]);
    else if (a === '--no-scopes') o.scopes = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--ro-heap') o.roHeap = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (o.file === null) o.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.file) {
    throw new Error('usage: node src/cli/dump-cache.mjs <file.jsc> [--profile <tag>] [--json out.json] [--function <id>]');
  }
  return o;
}

/**
 * Pick the profile whose Version::Hash() matches the file's versionHash, so the
 * common case needs no --profile at all and a mismatch is impossible to miss.
 */
function autoSelectProfile(file, root = 'profiles') {
  const buf = fs.readFileSync(file, { length: 64 });
  // The versionHash offset is itself profile data, so read it through whichever
  // profile is available first, then re-select. All profiles agree on the
  // code-cache header layout unless V8 changes it, which the per-profile check
  // below would catch.
  const tags = availableProfiles(root);
  if (!tags.length) throw new Error(`no profiles under ${root}/`);
  const tried = [];
  for (const tag of tags) {
    const p = loadProfile(path.join(root, tag), { strict: false, verifySources: false });
    const off = p.constants.codeCacheHeader.kVersionHashOffset;
    if (buf.length < off + 4) continue;
    const got = buf.readUInt32LE(off);
    const want = versionHashFromString(p.version);
    tried.push({ tag, want, got });
    if (got === want) return tag;
  }
  const got = tried.length ? tried[0].got : 0;
  throw new CacheVersionError(
    `${file} stores versionHash 0x${got.toString(16)}, which matches none of the installed profiles:\n`
    + tried.map((t) => `  ${t.tag} -> 0x${t.want.toString(16)}`).join('\n')
    + '\nGenerate the matching profile:\n'
    + '  node tools/profilegen/index.mjs --tag <X.Y.Z.W> --variant intl+wasm --tagged-size 4 --out profiles/\n'
    + '  node tools/layoutpatch/index.mjs --tag <X.Y.Z.W>');
}

// VERSION-FREE: 100 is a printing width.
function fmtConstant(c, width = 100) {
  const s = (() => {
    switch (c.t) {
      case 'string': return `string ${JSON.stringify(c.v)}`;
      case 'number': return `number ${c.v}${c.repr === 'smi' ? ' (smi)' : ''}`;
      case 'bigint': return `bigint ${c.v}n`;
      case 'boolean': return `boolean ${c.v}`;
      case 'null': return 'null';
      case 'undefined': return 'undefined';
      case 'hole': return 'hole';
      case 'symbol': return `symbol ${JSON.stringify(c.desc)}`;
      case 'sfi': return `sfi #${c.sfiId}`;
      case 'scopeInfo': return `scopeInfo #${c.scopeInfoId}`;
      case 'objectBoilerplate':
        return `objectBoilerplate flags=${c.flags} backingStore=${c.backingStoreSize} entries=${c.entries.length} `
          + `${c.entries.slice(0, 3).map((e) => `${short(e.key)}:${short(e.value)}`).join(', ')}`;
      case 'arrayBoilerplate':
        return `arrayBoilerplate kind=${c.elementsKind ?? c.flags} elements=${c.elements ? `[${c.elements.slice(0, 5).map(short).join(', ')}]` : `<${c.why}>`}`;
      case 'regexpBoilerplate': return `regexpBoilerplate /${c.source}/${c.flagString ?? c.flags}`;
      case 'templateObject':
        return `templateObject raw=${c.raw ? JSON.stringify(c.raw.map((x) => x.v ?? null)) : `<${c.rawWhy}>`} `
          + `cooked=${c.cooked ? JSON.stringify(c.cooked.map((x) => x.v ?? null)) : `<${c.cookedWhy}>`}`;
      case 'smiArray': return `smiArray [${c.values.join(', ')}]`;
      case 'array': return `array<${c.className}> [${c.values.slice(0, 5).map(short).join(', ')}]${c.values.length > 5 ? ' ...' : ''}`;
      case 'byteArray': return `byteArray<${c.className}> ${c.length} bytes`;
      case 'roRef': return c.resolved
        ? `roRef ${c.chunk}:${c.offset} -> ${c.resolved.kind} ${JSON.stringify(c.resolved.value ?? c.resolved.mapName)}`
        : `roRef ${c.chunk}:${c.offset} UNRESOLVED`;
      case 'rootObject': return `rootObject ${c.rootName} (${c.cppType})${c.isEmpty ? ' [empty]' : ''}`;
      case 'unresolved': return `UNRESOLVED ${c.why}${c.detail ? ' ' + JSON.stringify(c.detail) : ''}`;
      default: return JSON.stringify(c);
    }
  })();
  return s.length > width ? s.slice(0, width - 1) + '\u2026' : s;
}

function short(c) {
  if (!c) return 'null';
  if (c.t === 'string') return JSON.stringify(c.v);
  if (c.t === 'number') return String(c.v);
  if (c.t === 'sfi') return `sfi#${c.sfiId}`;
  if (c.t === 'unresolved') return `<${c.why}>`;
  return c.t;
}

function printScopeChain(scope, indent = '    ') {
  const lines = [];
  let s = scope;
  let depth = 0;
  while (s) {
    const names = (s.contextLocalNames ?? []);
    const shown = names.map((n, i) => `${i}:${n === null ? '<anonymous>' : JSON.stringify(n)}`);
    lines.push(`${indent}depth ${depth}  ${s.scopeType}  ${s.languageMode ?? '?'}  `
      + `params=${s.parameterCount}  contextLocals=${s.contextLocalCount}`
      + (s.contextLocalNamesSource ? `  names=${s.contextLocalNamesSource}` : ''));
    if (shown.length) lines.push(`${indent}          ${shown.join('  ')}`);
    if (s.contextLocalInfos?.length) {
      lines.push(`${indent}          modes ${s.contextLocalInfos.map((x, i) => `${i}:${x ? x.mode : '?'}${x?.maybeAssigned ? '*' : ''}`).join(' ')}`);
    }
    if (s.functionVariable) {
      lines.push(`${indent}          functionVariable ${JSON.stringify(s.functionVariable.name)} `
        + `(${s.functionVariable.allocation}, slot ${s.functionVariable.slotIndex})`);
    }
    if (s.inferredFunctionName) lines.push(`${indent}          inferredFunctionName ${JSON.stringify(s.inferredFunctionName)}`);
    if (s.positionInfo) lines.push(`${indent}          position [${s.positionInfo.start}, ${s.positionInfo.end})`);
    if (s.warnings?.length) for (const w of s.warnings.slice(0, 3)) lines.push(`${indent}          ! ${w}`);
    s = s.outer;
    depth++;
  }
  return lines.join('\n');
}

function printUnitFull(u, opts) {
  const out = [];
  out.push(`\n=== sfi #${u.sfiId}  function_literal_id ${u.functionLiteralId}  ${u.compiled ? 'COMPILED' : 'UNCOMPILED'}`);
  out.push(`    name              ${JSON.stringify(u.name)}${u.nameSource ? `  (from ${u.nameSource})` : ''}`);
  out.push(`    kind              ${u.kind}  (${u.functionKindName}, syntax ${u.functionSyntaxKind})`);
  out.push(`    generator/async   ${u.isGenerator} / ${u.isAsync}      strict ${u.isStrict}   topLevel ${u.isTopLevel}`);
  out.push(`    source range      [${u.startPosition}, ${u.endPosition})${u.positionSource ? `  (from ${u.positionSource})` : ''}`);
  out.push(`    parent sfi        ${u.parentSfiId}`);
  out.push(`    children          ${u.children.length ? u.children.map((c) => `lit${c.functionLiteralId}/sfi${c.sfiId}`).join(' ') : '(none)'}`);
  if (u.compiled) {
    out.push(`    bytecode          ${u.bytecodeLength} bytes${u.bytecode ? '' : '  (NOT SERIALIZED)'}`);
    out.push(`    frame             frameSize=${u.frameSize}  registerCount=${u.registerCount}  `
      + `parameterCount=${u.parameterCount} (without receiver ${u.parameterCountWithoutReceiver})  maxArguments=${u.maxArguments}`);
    out.push(`    formal params     ${u.formalParameterCount}   newTarget/generator reg operand ${u.incomingNewTargetOrGeneratorRegister}`);
    out.push(`    constant pool     ${u.constants.length} entries`);
    const n = Math.min(u.constants.length, opts.constants);
    for (let i = 0; i < n; i++) out.push(`      [${String(i).padStart(3)}] ${fmtConstant(u.constants[i])}`);
    if (u.constants.length > n) out.push(`      ... ${u.constants.length - n} more`);
    if (u.constantPoolSmiRuns.length) {
      out.push(`    smi runs (jump tables): ${u.constantPoolSmiRuns.map((r) => `@${r.start}x${r.length}`).join(' ')}`);
      for (const r of u.constantPoolSmiRuns) out.push(`      start ${r.start} length ${r.length}: [${r.values.join(', ')}]`);
    }
    out.push(`    handlers          ${u.handlers.length}  (${u.handlerTableBytes} bytes)`);
    for (const h of u.handlers) {
      out.push(`      [${h.rangeStart}, ${h.rangeEnd}) -> ${h.handlerOffset}  prediction=${h.prediction} (${h.predictionName})  wasUsed=${h.wasUsed}  data=${h.data}`);
    }
    out.push(`    source positions  ${u.sourcePositions.length}  (${u.sourcePositionTableBytes} bytes)`);
    for (const p of u.sourcePositions.slice(0, 20)) {
      out.push(`      @${String(p.codeOffset).padStart(5)} -> pos ${p.sourcePosition}  ${p.isStatement ? 'statement' : 'expression'}${p.isBreakable ? ', breakable' : ''}`);
    }
    if (u.sourcePositions.length > 20) out.push(`      ... ${u.sourcePositions.length - 20} more`);
  } else {
    out.push(`    uncompiled        ${u.uncompiled ? JSON.stringify(u.uncompiled) : '(no UncompiledData either)'}`);
  }
  if (u.scope) {
    out.push('    scope chain:');
    out.push(printScopeChain(u.scope, '      '));
  } else if (u.outerScope) {
    out.push(`    outer scope chain (${u.scopeSource}):`);
    out.push(printScopeChain(u.outerScope, '      '));
  } else {
    out.push('    scope             (none)');
  }
  if (u.warnings.length) {
    out.push(`    warnings (${u.warnings.length}):`);
    for (const w of u.warnings.slice(0, 10)) out.push(`      ! ${w}`);
  }
  return out.join('\n');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const tag = o.profile ?? autoSelectProfile(o.file);
  const env = loadEnvironment(tag, { roHeapFile: o.roHeap ?? undefined });

  const t0 = Date.now();
  const r = readCache(o.file, env);
  const built = buildUnits(env, r.graph, { decodeScopes: o.scopes });
  const ms = Date.now() - t0;

  const lines = [];
  lines.push(`file      ${o.file}  (${r.header.fileLength} bytes)`);
  lines.push(`profile   ${env.profile.dir}  V8 ${env.profile.version} ${env.profile.variant} kTaggedSize=${env.profile.taggedSize}`);
  lines.push(`overlay   ${env.overlay.file}`);
  lines.push(`ro-heap   ${env.roHeapFile ?? '(none)'}`);
  lines.push('');
  lines.push('-- header ------------------------------------------------------------');
  lines.push(formatHeader(r.header));
  lines.push('');
  lines.push('-- header verification -----------------------------------------------');
  for (const c of r.verification.checks) {
    const mark = c.ok === null ? '  --  ' : c.ok ? '  ok  ' : ' FAIL ';
    lines.push(`[${mark}] ${c.name.padEnd(26)} ${c.actual}${c.expected !== undefined ? `  (expected ${c.expected})` : ''}`);
    lines.push(`          ${c.basis}`);
  }
  if (r.checksum) {
    lines.push(`payload checksum: ${r.checksum.present ? (r.checksum.ok ? 'ok' : 'MISMATCH') : 'not written'}  (${r.checksum.note})`);
  }
  for (const w of r.verification.warnings) lines.push(`WARNING: ${w}`);
  for (const e of r.verification.errors) lines.push(`ERROR: ${e}`);
  lines.push('');
  lines.push('-- deserialization ---------------------------------------------------');
  lines.push(`objects ${r.graph.objects.length}   backrefs ${r.graph.backrefCount}   `
    + `forward refs unresolved ${r.graph.unresolvedForwardRefs}   backing stores ${r.graph.backingStores}   `
    + `external refs ${r.graph.externalReferences}`);
  lines.push(`trailing bytes after kSynchronize: ${r.graph.trailingBytes} `
    + `(all kNop: ${r.graph.trailingAllNop}, within Serializer::Pad budget: ${r.graph.trailingWithinPadBudget})`);
  lines.push(`tags: ${Object.entries(r.graph.stats.tagCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push('');
  lines.push('-- object classes ----------------------------------------------------');
  for (const [k, v] of Object.entries(built.stats.classCounts)) lines.push(`  ${String(v).padStart(7)}  ${k}`);
  lines.push('');
  lines.push('-- units -------------------------------------------------------------');
  lines.push(`total ${built.stats.units}   compiled ${built.stats.compiled}   uncompiled ${built.stats.uncompiled}`
    + `   orphan BytecodeArrays ${built.stats.orphanBytecodeArrays}   ScopeInfos decoded ${built.stats.scopeInfos}`);

  if (!o.quiet) {
    lines.push('');
    lines.push('  lit   sfi   kind        g a s  params  frame  regs  bclen  consts  hdlr  srcpos  name');
    const sorted = [...built.units].sort((a, b) => (a.functionLiteralId ?? 1e9) - (b.functionLiteralId ?? 1e9));
    for (const u of sorted.slice(0, o.maxUnits)) {
      lines.push([
        String(u.functionLiteralId).padStart(5),
        String(u.sfiId).padStart(5),
        (u.kind ?? '?').padEnd(10),
        `${u.isGenerator ? 'G' : '-'} ${u.isAsync ? 'A' : '-'} ${u.isStrict ? 'S' : '-'}`,
        String(u.parameterCount ?? '-').padStart(6),
        String(u.frameSize ?? '-').padStart(6),
        String(u.registerCount ?? '-').padStart(5),
        String(u.bytecodeLength ?? '-').padStart(6),
        String(u.constants.length).padStart(7),
        String(u.handlers.length).padStart(5),
        String(u.sourcePositions.length).padStart(7),
        `  ${u.compiled ? '' : '[UNCOMPILED] '}${JSON.stringify(u.name)}`,
      ].join(' '));
    }
    if (built.units.length > o.maxUnits) lines.push(`  ... ${built.units.length - o.maxUnits} more (raise --max-units)`);
  }

  const naming = contextSlotNamingStats(built.units);
  lines.push('');
  lines.push('-- context slot naming -----------------------------------------------');
  // VERSION-FREE: 100 converts a ratio to a percentage.
  lines.push(`scopes ${naming.scopes}   context slots ${naming.contextSlots}   named ${naming.namedSlots}   `
    + `anonymous ${naming.anonymousSlots}   rate ${naming.rate === null ? 'n/a' : (100 * naming.rate).toFixed(2) + '%'}`);
  lines.push(`  from the inlined name array ${naming.viaInlined}, from the hash table ${naming.viaHashtable}`);
  for (const [k, v] of Object.entries(naming.byScopeType)) {
    lines.push(`  ${k.padEnd(20)} scopes ${String(v.scopes).padStart(5)}  slots ${String(v.slots).padStart(6)}  named ${String(v.named).padStart(6)}`);
  }

  lines.push('');
  lines.push('-- unresolved --------------------------------------------------------');
  const ur = built.reports.unresolved;
  lines.push(`${ur.total} occurrences in ${ur.distinct} categories`);
  for (const c of ur.categories) {
    lines.push(`  ${String(c.count).padStart(7)}  ${c.category}${c.samples.length ? '   e.g. ' + JSON.stringify(c.samples[0]) : ''}`);
  }
  lines.push('');
  lines.push(built.ctx.roRefs.formatReport(10));
  const mr = built.reports.maps;
  lines.push(`maps: ${mr.distinctMapsSeen} distinct seen, ${mr.distinctClassified} classified, `
    + `${mr.distinctNoLayoutForClass} named but absent from layouts.json (${mr.noLayoutOccurrences} objects), `
    + `${mr.unnamedMapWords} map words unnamed`);
  for (const t of mr.top) lines.push(`  no layouts.json class for map ${t.mapName}  x${t.count}`);

  lines.push('');
  lines.push(`decoded in ${ms} ms`);

  if (o.functionId !== null) {
    const u = built.unitByFunctionLiteralId.get(o.functionId);
    lines.push(u ? printUnitFull(u, o) : `\nno unit with function_literal_id ${o.functionId}`);
  }
  if (o.sfiId !== null) {
    const u = built.unitBySfiId.get(o.sfiId);
    lines.push(u ? printUnitFull(u, o) : `\nno unit with sfiId ${o.sfiId}`);
  }

  process.stdout.write(lines.join('\n') + '\n');

  if (o.json) {
    const replacer = (k, v) => {
      if (Buffer.isBuffer(v)) return { $buffer: v.toString('base64'), length: v.length };
      if (typeof v === 'bigint') return v.toString();
      return v;
    };
    fs.writeFileSync(o.json, JSON.stringify({
      file: o.file,
      profile: { dir: env.profile.dir, version: env.profile.version, variant: env.profile.variant },
      overlay: env.overlay.file,
      header: r.header,
      verification: r.verification,
      checksum: r.checksum,
      deserialization: {
        objects: r.graph.objects.length,
        backrefs: r.graph.backrefCount,
        trailingBytes: r.graph.trailingBytes,
        trailingAllNop: r.graph.trailingAllNop,
        tagCounts: r.graph.stats.tagCounts,
      },
      stats: built.stats,
      reports: built.reports,
      contextSlotNaming: naming,
      units: built.units,
    }, replacer, 1), 'utf8');
    process.stdout.write(`wrote ${o.json}\n`);
  }
}

try { main(); } catch (e) {
  process.stderr.write((e instanceof CacheVersionError ? e.message : (e.stack ?? String(e))) + '\n');
  process.exitCode = 1;
}
