#!/usr/bin/env node
// src/cli/dump-ir.mjs
//
// Dump the IR of ARCHITECTURE.md 8.4 for one function or a whole cache.
//
//   node src/cli/dump-ir.mjs <file.jsc> [options]
//
//   --function <id>     only the function with this bytecode id, index or name
//   --profile <tag>     profile directory or tag (default: the newest)
//   --dot               Graphviz instead of text, so a CFG can be eyeballed
//   --json [<out>]      machine-readable
//   --list              one line per function: blocks, edges, loops, phis, ...
//   --verify            run the structural invariants and print the table
//   --brute-force       also cross-check idom/ipdom against the slow oracles
//   --exception-model instruction|block
//                       'instruction' (default) ends a block at every throwing
//                       instruction inside a protected range; 'block' is
//                       ARCHITECTURE.md 4.2's coarse model, for comparison
//   --no-scope-infos    skip decoding the constant-pool ScopeInfos
//   --quiet             no per-file header
//
// Printed, per function: the block list with its kind, offsets, predecessors
// and successors (each successor labelled with its edge kind), the dominator
// and post-dominator trees, the loop forest, the phi nodes, the SSA
// definitions with their uses, and the effect chain.

import fs from 'node:fs';
import path from 'node:path';
import { listProfiles } from '../profile/index.mjs';
import { buildIR } from '../ir/index.mjs';
import { verifyIR } from '../ir/verify.mjs';
import { toDot } from '../ir/dot.mjs';
import { loadUnits as unitsFromCache, loadUnitsFromAnyProfile as unitsFromAnyProfile } from '../load/index.mjs';

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  const prev = all[i - 1];
  return !(prev && prev.startsWith('--'));
});

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node src/cli/dump-ir.mjs <file.jsc> [--function <id>] [--profile <tag>]
                               [--dot] [--json [out.json]] [--list] [--verify]
                               [--brute-force] [--exception-model instruction|block]
                               [--no-scope-infos] [--quiet]

available profiles: ${listProfiles().join(', ') || '(none)'}`);
  process.exit(msg ? 2 : 0);
}
if (flag('help') || flag('h')) usage();
const file = positional[0];
if (!file) usage('no .jsc file given');
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

function resolveProfileDir(spec) {
  if (!spec || spec === true) return null;        // try every profile
  if (fs.existsSync(path.join(spec, 'meta.json'))) return spec;
  const asTag = path.join('profiles', spec);
  if (fs.existsSync(path.join(asTag, 'meta.json'))) return asTag;
  usage(`no profile at ${spec} or ${asTag}. Available: ${listProfiles().join(', ')}`);
  return null;
}
const profileDir = resolveProfileDir(arg('profile'));
const loadOpts = { scopeInfos: !flag('no-scope-infos') };

let loaded;
try {
  loaded = profileDir ? unitsFromCache(file, profileDir, loadOpts) : unitsFromAnyProfile(file, loadOpts);
} catch (e) {
  console.error(`error: src/cache + src/heap could not read ${file}: ${e.message}`);
  process.exit(1);
}
const { units, scopeInfoById, profile } = loaded;

const want = arg('function');
const matches = (u, i) => {
  if (want === undefined || want === true) return true;
  const s = String(want);
  return String(u.bytecodeId) === s || String(i) === s || (u.name && u.name === s)
    || (u.functionLiteralId !== null && String(u.functionLiteralId) === s);
};
const selected = units.map((u, i) => ({ u, i })).filter(({ u, i }) => matches(u, i) && u.bytecode);
if (!selected.length) {
  console.error(`error: no compiled function matches --function ${want}. Use --list to see them.`);
  process.exit(1);
}

if (!flag('quiet')) {
  console.error(`${file}: ${units.length} functions, profile ${profile.version} (${profile.variant})`);
  console.error(`  ${scopeInfoById ? scopeInfoById.size : 0} ScopeInfo objects decoded for context-slot naming`);
  if (selected.length !== units.length) console.error(`  showing ${selected.length} selected function(s)`);
}

const irOpts = {
  profile, scopeInfoById,
  exceptionPrecision: arg('exception-model') === 'block' ? 'block' : 'instruction',
};

const built = [];
let failures = 0;
for (const { u, i } of selected) {
  try { built.push({ i, ir: buildIR(u, irOpts) }); }
  catch (e) { failures++; console.error(`  function ${i} (bytecode ${u.bytecodeId}): ${e.message}\n${e.stack}`); }
}

// --------------------------------------------------------------- renderers
const pad = (s, w) => String(s).padStart(w);

function valueText(ir, id) {
  const v = ir.values[id];
  if (!v) return `v${id}=?`;
  switch (v.kind) {
    case 'Param': return `v${id} = Param ${v.isReceiver ? 'this' : 'a' + (v.index - 1)}`;
    case 'FrameEntry': return `v${id} = FrameEntry ${ir.vs.name(v.var) ?? v.reg.k} (${v.what})`;
    case 'Phi': return `v${id} = phi ${v.varName} [${v.operands.map((o) => (o === null ? '?' : 'v' + o)).join(', ')}]`;
    case 'CaughtException': return `v${id} = CaughtException (handlers ${v.handlers.join(',')}: ${v.predictions.join(',')})`;
    case 'EffectPhi': return `v${id} = effect-phi [${v.operands.map((o) => (o === null ? '?' : 'v' + o)).join(', ')}]`;
    case 'EffectEntry': return `v${id} = effect-entry`;
    case 'Proj': return `v${id} = proj ${v.slot} of v${v.of} -> ${ir.vs.name(v.var)}`;
    case 'ContextSlot':
      return `v${id} = ContextSlot(frame ${v.frame}, index ${v.localIndex}) `
        + `${v.resolved ? JSON.stringify(v.name) : '<' + v.why + '>'} ${v.mode ?? ''} `
        + `loads=${v.loads.length} stores=${v.stores.length}`;
    case 'Op': {
      const flags = `${v.hasEffect ? 'E' : '-'}${v.allocatesIdentity ? 'A' : '-'}`;
      const out = v.var >= 0 ? `${ir.vs.name(v.var)}${v.clobbered ? '(clobber)' : ''} = ` : '';
      const cs = v.contextSlot
        ? `  ; ${v.contextSlot.mode} ${v.contextSlot.resolved ? JSON.stringify(v.contextSlot.name) : '<' + v.contextSlot.why + '>'}`
          + ` depth=${v.contextSlot.depth} index=${v.contextSlot.index}`
        : '';
      return `v${id} [${flags}] @${v.offset} ${out}${v.op}(${v.inputs.map((x) => 'v' + x).join(', ')})${cs}`;
    }
    default: return `v${id} = ${v.kind}`;
  }
}

function printFunction(ir, index) {
  const u = ir.unit;
  const L = [];
  const say = (s = '') => L.push(s);
  say('='.repeat(78));
  say(`function #${index}  bytecode ${u.bytecodeId}  ${JSON.stringify(u.name ?? '')}`
    + `  kind=${u.kind ?? '?'}${u.isAsync ? ' async' : ''}${u.isGenerator ? ' generator' : ''}`);
  say(`  ${ir.instructions.length} instructions, ${u.parameterCount} parameters, ${u.registerCount} registers,`
    + ` ${ir.handlers.length} handler range(s)`);
  say(`  ${ir.blocks.length} blocks (${ir.stats.reachableBlocks} reachable), ${ir.edges.length} edges`
    + ` ${JSON.stringify(ir.stats.byKind)}`);
  say(`  ${ir.loops.length} loops (max nesting ${ir.stats.maxNestingDepth}),`
    + ` ${ir.phis.length} phis (max arity ${ir.stats.maxPhiArity}),`
    + ` ${ir.values.length} values, ${ir.effects.length} effect nodes`);
  if (ir.stats.irreducibleBackEdges) {
    say(`  IRREDUCIBLE: ${ir.stats.irreducibleBackEdges} retreating edge(s) whose target does not dominate them`);
    for (const x of ir.loopInfo.irreducible) say(`    B${x.from}@${x.fromOffset} -> B${x.to}@${x.toOffset} (${x.kind}, ${x.terminator})`);
  }
  say(`  context header length: ${ir.stats.contextHeader.min}`
    + ` (extended ${ir.stats.contextHeader.extended}) from ${ir.stats.contextHeader.source}`);
  if (ir.stats.contextHeader.gap) say(`    profilegen gap: ${ir.stats.contextHeader.gap}`);
  const cs = ir.stats.contextSlots;
  if (cs.ops) {
    say(`  context slots: ${cs.resolved}/${cs.ops} named`
      + `${cs.unresolved ? '  unresolved: ' + JSON.stringify(cs.byWhy) : ''}`
      + `  depth>0: ${cs.nonZeroDepth} (max ${cs.maxDepth})`);
  }
  if (ir.warnings.length) {
    say(`  ${ir.warnings.length} warning(s):`);
    for (const w of ir.warnings.slice(0, 10)) say(`    [${w.stage}] ${w.code}: ${w.message ?? JSON.stringify(w)}`);
  }

  say('');
  say('-- blocks ------------------------------------------------------------');
  for (const b of ir.blocks) {
    const succ = b.outEdges.map((eid) => {
      const e = ir.edges[eid];
      const tag = e.kind === 'switch' ? `switch(${e.caseValue})` : e.kind;
      return `B${e.to}:${tag}`;
    });
    say(`B${pad(b.id, 3)} @${pad(b.startOffset, 6)}..${pad(b.endOffset, 6)}`
      + ` ${(b.kinds.join(',') || 'normal').padEnd(28)}`
      + ` ins=${pad(b.instructions.length, 4)} preds=[${b.preds.join(',')}] succs=[${succ.join(',')}]`
      + ` idom=${b.idom >= 0 ? 'B' + b.idom : '-'} ipdom=${b.ipdom === ir.exit ? 'EXIT' : 'B' + b.ipdom}`
      + ` df=[${b.domFrontier.join(',')}]`
      + (b.loop >= 0 ? ` loop=${b.loop}@${b.loopDepth}` : '')
      + (b.handlerIndex >= 0 ? ` inRange=${b.handlerIndex}` : '')
      + (b.reachable ? '' : ' UNREACHABLE'));
  }

  say('');
  say('-- dominator tree ----------------------------------------------------');
  printTree(say, ir.dominators.rpo.length ? 0 : -1, (x) => ir.dominators.children[x] ?? [], (x) => `B${x}`);
  say('');
  say('-- post-dominator tree (rooted at EXIT) ------------------------------');
  printTree(say, ir.exit, (x) => ir.postDominators.dom.children[x] ?? [], (x) => (x === ir.exit ? 'EXIT' : `B${x}`));
  if (ir.postDominators.virtualExitEdges.length) {
    say(`  (${ir.postDominators.virtualExitEdges.length} virtual exit edge(s) from blocks with no path to a return: `
      + ir.postDominators.virtualExitEdges.map((b) => `B${b}`).join(', ') + ')');
  }

  say('');
  say('-- loop forest -------------------------------------------------------');
  if (!ir.loops.length) say('  (none)');
  for (const l of ir.loops) {
    say(`  ${'  '.repeat(l.depth)}loop${l.id} header=B${l.header} depth=${l.depth}`
      + ` latches=[${l.latches.map((x) => 'B' + x).join(',')}]`
      + ` body=${l.body.length} blocks [${l.body.map((x) => 'B' + x).join(',')}]`
      + ` exits=[${l.exits.map((e) => `B${e.from}->B${e.to}`).join(',')}]`
      + (l.endless ? ' ENDLESS' : ''));
  }

  say('');
  say('-- phis --------------------------------------------------------------');
  if (!ir.phis.length) say('  (none)');
  for (const b of ir.blocks) {
    for (const p of b.phis) say(`  B${b.id}: ${valueText(ir, p)}   preds=[${b.preds.join(',')}]`);
    if (b.caughtException !== null) say(`  B${b.id}: ${valueText(ir, b.caughtException)}`);
  }

  say('');
  say('-- SSA values and uses -----------------------------------------------');
  for (const v of ir.values) {
    if (!v) continue;
    const uses = ir.defUse.get(v.id) ?? [];
    say(`  ${valueText(ir, v.id)}${uses.length ? `   uses=[${uses.map((x) => 'v' + x).join(',')}]` : '   (no uses)'}`);
  }

  say('');
  say('-- effect chain ------------------------------------------------------');
  for (const b of ir.blocks) {
    if (!b.reachable) continue;
    const inv = ir.effectGraph.effectIn[b.id];
    const outv = ir.effectGraph.effectOut[b.id];
    say(`  B${b.id}: in=v${inv} [${b.effects.map((x) => {
      const v = ir.values[x];
      return `v${x}:${v.op}`;
    }).join(' -> ')}] out=v${outv}`);
  }
  return L.join('\n');
}

function printTree(say, root, childrenOf, label) {
  if (root < 0) { say('  (empty)'); return; }
  const stack = [[root, 0]];
  while (stack.length) {
    const [x, d] = stack.pop();
    say(`  ${'  '.repeat(d)}${label(x)}`);
    const kids = [...childrenOf(x)].sort((a, b) => b - a);
    for (const c of kids) stack.push([c, d + 1]);
  }
}

// --------------------------------------------------------------- output
if (flag('list')) {
  console.log('index\tbcId\tins\tblocks\tedges\texc\tswitch\tloops\tmaxDepth\tphis\tmaxArity\tvalues\teffects\tirred\twarn\tname');
  for (const { i, ir } of built) {
    const s = ir.stats;
    console.log([i, ir.unit.bytecodeId, ir.instructions.length, ir.blocks.length, ir.edges.length,
      s.exceptionEdges, s.switchEdges, ir.loops.length, s.maxNestingDepth, ir.phis.length, s.maxPhiArity,
      ir.values.length, ir.effects.length, s.irreducibleBackEdges, ir.warnings.length,
      ir.unit.name || '<anonymous>'].join('\t'));
  }
} else if (flag('dot')) {
  for (const { ir } of built) process.stdout.write(toDot(ir, { domTree: false }));
} else if (arg('json') !== undefined) {
  const payload = {
    file, profile: profile.version,
    functions: built.map(({ i, ir }) => ({
      index: i,
      unit: {
        bytecodeId: ir.unit.bytecodeId, name: ir.unit.name, kind: ir.unit.kind,
        isAsync: ir.unit.isAsync, isGenerator: ir.unit.isGenerator,
        parameterCount: ir.unit.parameterCount, registerCount: ir.unit.registerCount,
      },
      blocks: ir.blocks.map((b) => ({
        id: b.id, startOffset: b.startOffset, endOffset: b.endOffset,
        kind: b.kind, kinds: b.kinds, preds: b.preds, succs: b.succs,
        exceptionSuccs: b.exceptionSuccs, idom: b.idom, ipdom: b.ipdom,
        domFrontier: b.domFrontier, loop: b.loop, loopDepth: b.loopDepth,
        phis: b.phis, effects: b.effects, caughtException: b.caughtException,
        instructions: b.instructions.map((x) => x.offset),
      })),
      edges: ir.edges,
      entry: ir.entry, exit: ir.exit,
      idom: [...ir.idom], ipdom: [...ir.ipdom],
      loops: ir.loops.map((l) => ({
        id: l.id, header: l.header, latches: l.latches, body: l.body,
        exits: l.exits, parent: l.parent, children: l.children, depth: l.depth,
      })),
      values: ir.values.map((v) => {
        const { sem, bodySet, ...rest } = v;
        return { ...rest, effect: v.effect ? { ...v.effect } : undefined };
      }),
      effects: ir.effects,
      defUse: Object.fromEntries([...ir.defUse].map(([k, v]) => [k, v])),
      handlers: ir.handlers,
      stats: ir.stats,
      warnings: ir.warnings,
      verify: flag('verify') ? verifyIR(ir, { bruteForce: flag('brute-force') }).checks : undefined,
    })),
  };
  const text = JSON.stringify(payload, (k, v) => (v instanceof Int32Array || v instanceof Uint32Array ? [...v] : v), 1);
  const out = arg('json');
  if (out === true) console.log(text);
  else {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    console.error(`wrote ${out}`);
  }
} else {
  for (const { i, ir } of built) {
    console.log(printFunction(ir, i));
    if (flag('verify')) {
      const r = verifyIR(ir, { bruteForce: flag('brute-force') });
      console.log('');
      console.log('-- invariants --------------------------------------------------------');
      console.log('| check | result | violations / total |');
      console.log('|---|---|---|');
      for (const c of r.checks) {
        console.log(`| ${c.name} | ${c.ok ? 'PASS' : '**FAIL**'} | ${c.violations} / ${c.total} |`);
        if (!c.ok) for (const s of c.samples) console.log(`|   ${JSON.stringify(s)} | | |`);
      }
      console.log(r.ok ? 'ALL INVARIANTS HOLD' : `${r.violations} VIOLATION(S)`);
      if (!r.ok) failures++;
    }
    console.log('');
  }
}

process.exitCode = failures === 0 ? 0 : 1;
