#!/usr/bin/env node
// tools/ir/selftest.mjs
//
// Unit-level self-test for src/ir/. No .jsc, no engine, no corpus.
//
//   A  hygiene      no version-specific literal anywhere in src/ir/
//   B  semantics    the opcode effect/allocation table is total over every
//                   profile, and the derived register roles agree with the
//                   operand-type lists
//   C  graphs       hand-built CFGs: diamond, nested loop, loop with multiple
//                   exits, irreducible (two entries into a loop), switch
//                   fan-out, endless loop. Dominators, dominance frontiers,
//                   post-dominators and the loop forest are asserted against
//                   the expected answer AND against the brute-force oracles.
//   D  ir           assembled bytecode, through the whole of buildIR: phi
//                   placement on a diamond and on a loop, a nested try, a
//                   generator dispatcher, the `finally` token dispatch, and
//                   the effect order.
//   E  invariants   every assembled function passes src/ir/verify.mjs with the
//                   brute-force oracles enabled.
//
// Usage: node tools/ir/selftest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { verifyIR } from '../../src/ir/verify.mjs';
import {
  dominators, postDominators, bruteForceDominators, bruteForcePostDominators, immediateFromSets,
} from '../../src/ir/dominators.mjs';
import { findLoops } from '../../src/ir/loops.mjs';
import { opcodeSemantics, classifyProfile, EFFECTS } from '../../src/ir/opcode_effects.mjs';
import { contextHeaderConstants } from '../../src/ir/context.mjs';
import { asm } from './asm.mjs';

const TAGS = listProfiles();
const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let pass = 0, fail = 0;
function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, detail: `threw: ${e.message} ${String(e.stack).split('\n')[1] ?? ''}` }; }
  if (r.ok) pass++; else fail++;
  say(`| ${group} | ${name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${(r.detail ?? '').replace(/\|/g, '\\|')} |`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

say('# src/ir self-test');
say('');
say(`profiles: ${TAGS.join(', ')}`);
say('');
say('| group | check | result | detail |');
say('|---|---|---|---|');

// ---------------------------------------------------------------- A hygiene
check('A', 'no version-specific literal in src/ir/', () => {
  const dir = 'src/ir';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of files) {
    const stripped = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hex = [...stripped.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0]);
    const big = [...stripped.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)].map((m) => m[0]);
    if (hex.length || big.length) offenders.push(`${f}: hex[${hex.join(',')}] big[${big.join(',')}]`);
  }
  return { ok: offenders.length === 0, detail: offenders.length ? offenders.join('; ') : `${files.length} files clean` };
});
check('A', 'no opcode value, operand width or root index written down', () => {
  // The only names src/ir may contain are opcode NAMES, in the declared
  // tables; everything numeric has to come from the profile. Catch the easy
  // regression: a numeric comparison against an opcode value.
  const bad = [];
  for (const f of fs.readdirSync('src/ir')) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join('src/ir', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/opcodeValue\s*[=!]==?\s*(\d+)/g)) bad.push(`${f}: opcodeValue === ${m[1]}`);
    for (const m of src.matchAll(/getOpcode\(\s*(\d+)\s*\)/g)) bad.push(`${f}: getOpcode(${m[1]})`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'no numeric opcode comparison' };
});

// ------------------------------------------------------------- B semantics
for (const tag of TAGS) {
  const p = loadProfile(path.join('profiles', tag));
  check('B', `${tag}: every opcode is named in the EFFECTS table`, () => {
    const missing = classifyProfile(p);
    return { ok: missing.length === 0, detail: missing.length ? `unclassified: ${missing.join(', ')}` : `${p.opcodeCount} opcodes classified` };
  });
  check('B', `${tag}: EFFECTS names no opcode the profile does not have`, () => {
    const extra = Object.keys(EFFECTS).filter((n) => !p.getOpcode(n));
    return { ok: extra.length === 0, detail: extra.length ? `not in the profile: ${extra.join(', ')}` : 'exact' };
  });
  check('B', `${tag}: register read/write roles come from the operand-type lists`, () => {
    const sem = opcodeSemantics(p);
    const ops = p.tables.operands;
    const problems = [];
    if (!eq([...sem.inOutTypes], ops.registerOperandTypes.filter((t) => /InOut$/.test(t)))) {
      problems.push(`in-out types ${[...sem.inOutTypes]} are not the *InOut ones`);
    }
    // a spot check with a known shape, by operand type not by opcode
    const star = sem.of('Star');
    if (!star.operands[0].writes || star.operands[0].reads) problems.push('Star\'s kRegOut is not write-only');
    if (!star.accumulator.read || star.accumulator.write) problems.push('Star does not read-only the accumulator');
    const mov = sem.of('Mov');
    if (!mov.operands[0].reads || mov.operands[0].writes) problems.push('Mov operand 0 is not read-only');
    if (!mov.operands[1].writes || mov.operands[1].reads) problems.push('Mov operand 1 is not write-only');
    const step = sem.of('ForInStep');
    if (!step.operands[0].reads || !step.operands[0].writes) problems.push('ForInStep\'s kRegInOut is not both');
    return { ok: problems.length === 0, detail: problems.join('; ') || 'kReg/kRegOut/kRegInOut all correct' };
  });
  check('B', `${tag}: hasEffect and allocatesIdentity are consistent with the row`, () => {
    const sem = opcodeSemantics(p);
    const problems = [];
    for (const name of sem.names) {
      const s = sem.of(name);
      const want = s.effect.writes.length > 0 || s.effect.throws || s.effect.callsUserCode;
      if (s.hasEffect !== want) problems.push(`${name}: hasEffect ${s.hasEffect} vs row ${want}`);
      const wantAlloc = s.effect.allocation === 'definite' || s.effect.allocation === 'maybe';
      if (s.allocatesIdentity !== wantAlloc) problems.push(`${name}: allocatesIdentity ${s.allocatesIdentity}`);
      if (s.hasEffect && !s.inEffectChain) problems.push(`${name}: effectful but not in the chain`);
    }
    // the four classes 4.3 depends on
    const mustAllocate = ['CreateObjectLiteral', 'CreateArrayLiteral', 'CreateClosure', 'CreateRegExpLiteral',
      'CreateEmptyObjectLiteral', 'CreateEmptyArrayLiteral', 'CloneObject', 'CreateMappedArguments',
      'CreateUnmappedArguments', 'CreateRestParameter', 'Construct', 'ConstructWithSpread',
      'ConstructForwardAllArgs', 'CreateBlockContext', 'CreateCatchContext', 'CreateFunctionContext',
      'CreateEvalContext', 'CreateWithContext', 'CreateArrayFromIterable'];
    for (const n of mustAllocate) if (p.getOpcode(n) && !sem.of(n).allocatesIdentity) problems.push(`${n} must allocate an identity`);
    const mustBePure = ['Ldar', 'Star', 'Mov', 'LdaSmi', 'LdaConstant', 'LdaUndefined', 'TestEqualStrict',
      'TestReferenceEqual', 'ToBoolean', 'LogicalNot', 'TypeOf', 'LdaImmutableContextSlot',
      'LdaImmutableCurrentContextSlot', 'ForInStep', 'Jump', 'JumpIfTrue'];
    for (const n of mustBePure) {
      if (!p.getOpcode(n)) continue;
      const s = sem.of(n);
      if (s.hasEffect || s.allocatesIdentity) problems.push(`${n} must be pure (hasEffect=${s.hasEffect} alloc=${s.allocatesIdentity})`);
    }
    const mustBeEffectful = ['GetNamedProperty', 'SetNamedProperty', 'GetKeyedProperty', 'SetKeyedProperty',
      'CallProperty', 'CallUndefinedReceiver', 'Throw', 'ReThrow', 'StaContextSlot', 'StaCurrentContextSlot',
      'SuspendGenerator', 'DeletePropertyStrict', 'DeletePropertySloppy', 'TestIn', 'Add', 'ToNumber',
      'SetPendingMessage', 'ResumeGenerator', 'SwitchOnGeneratorState'];
    for (const n of mustBeEffectful) if (p.getOpcode(n) && !sem.of(n).hasEffect) problems.push(`${n} must be effectful`);
    // a mutable context load is pure but order-sensitive: not hasEffect, still in the chain
    for (const n of ['LdaContextSlot', 'LdaCurrentContextSlot']) {
      if (!p.getOpcode(n)) continue;
      const s = sem.of(n);
      if (s.hasEffect) problems.push(`${n} should not have hasEffect`);
      if (!s.inEffectChain) problems.push(`${n} must still join the effect chain as a read`);
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 4).join('; ') || `${sem.names.length} opcodes consistent` };
  });
  check('B', `${tag}: the context header length is derived, and the profile gap is reported`, () => {
    const hc = contextHeaderConstants(p);
    const ok = hc.extended === hc.min + 1 && hc.min >= 2;
    return { ok, detail: `MIN_CONTEXT_SLOTS=${hc.min} extended=${hc.extended} source=${hc.source.slice(0, 60)}`
      + (hc.gap ? ' [gap reported]' : '') };
  });
}

// ------------------------------------------------------------- C graphs
//
// Each case is an adjacency list plus the answers, and every case is also run
// through the brute-force oracles. `-1` in the expected idom means the entry.

function graphOf(succ) {
  const n = succ.length;
  const preds = Array.from({ length: n }, () => []);
  succ.forEach((ss, i) => ss.forEach((s) => preds[s].push(i)));
  return { n, entry: 0, succs: (i) => succ[i], preds: (i) => preds[i], predList: preds };
}

/** Wrap an adjacency list in the shape src/ir/loops.mjs consumes. */
function cfgOf(succ, opts = {}) {
  const g = graphOf(succ);
  const edges = [];
  const blocks = succ.map((ss, i) => ({
    id: i, startOffset: i * 10, endOffset: i * 10 + 2, first: i, last: i,
    instructions: [], preds: [], succs: [], normalPreds: [], normalSuccs: [],
    exceptionPreds: [], exceptionSuccs: [], inEdges: [], outEdges: [],
    kind: 'normal', kinds: [], isGeneratorDispatch: false, handlerIndex: -1,
    isHandlerEntryFor: [], canThrow: false, throwingTerminator: false, reachable: true,
    terminator: { opcode: 'Jump', isBackward: (opts.backward ?? []).some(([a, b]) => a === i), isJump: true, isSwitch: false, isConditional: ss.length > 1, endsFunction: ss.length === 0 },
  }));
  succ.forEach((ss, i) => ss.forEach((s) => {
    const e = { id: edges.length, from: i, to: s, kind: ss.length > 1 ? 'true' : 'unconditional' };
    edges.push(e);
    blocks[i].succs.push(s); blocks[s].preds.push(i);
    blocks[i].outEdges.push(e.id); blocks[s].inEdges.push(e.id);
  }));
  return { blocks, edges, entry: 0, handlers: [], instructions: [], stats: { generatorResumeEdges: 0 }, graph: g };
}

const CASES = {
  // 0 -> 1,2 ; 1,2 -> 3
  diamond: {
    succ: [[1, 2], [3], [3], []],
    idom: [0, 0, 0, 0],
    ipdom: [3, 3, 3, 'EXIT'],
    df: [[], [3], [3], []],
    loops: 0,
  },
  // 0 -> 1 ; 1 -> 2,4 ; 2 -> 3 ; 3 -> 2,1(outer latch) ... nested loop
  nestedLoop: {
    //  0 entry, 1 outer header, 2 inner header, 3 inner latch, 4 outer latch, 5 exit
    succ: [[1], [2, 5], [3], [2, 4], [1], []],
    backward: [[3, 2], [4, 1]],
    idom: [0, 0, 1, 2, 3, 1],
    loops: 2,
    loopHeaders: [1, 2],
    loopDepths: [0, 1],
  },
  // a loop with two exits
  multiExitLoop: {
    //  0 entry, 1 header, 2 body, 3 latch, 4 exit a, 5 exit b, 6 join
    succ: [[1], [2, 4], [3, 5], [1], [6], [6], []],
    backward: [[3, 1]],
    loops: 1,
    loopExits: 2,
  },
  // two entries into the same cycle: irreducible
  irreducible: {
    //  0 -> 1,2 ; 1 -> 2 ; 2 -> 1 ; 1 -> 3
    succ: [[1, 2], [2, 3], [1], []],
    irreducible: 1,
  },
  // a switch dispatching five ways plus a fall-through, all joining
  switchFanOut: {
    succ: [[1, 2, 3, 4, 5, 6], [7], [7], [7], [7], [7], [7], []],
    idom: [0, 0, 0, 0, 0, 0, 0, 0],
    ipdom: [7, 7, 7, 7, 7, 7, 7, 'EXIT'],
    loops: 0,
  },
  // while (true) {} -- no path to a return at all
  endlessLoop: {
    succ: [[1], [2], [1]],
    backward: [[2, 1]],
    loops: 1,
    virtualExitEdges: 1,
  },
};

for (const [name, c] of Object.entries(CASES)) {
  check('C', `${name}: idom matches the brute-force oracle`, () => {
    const g = graphOf(c.succ);
    const d = dominators(g);
    const slow = immediateFromSets(bruteForceDominators(g), 0, (b) => d.reachable(b));
    const bad = [];
    for (const b of d.rpo) if (slow[b] !== d.idom[b]) bad.push(`B${b}: fast ${d.idom[b]} slow ${slow[b]}`);
    if (c.idom && !eq([...d.idom], c.idom)) bad.push(`idom ${[...d.idom]} != expected ${c.idom}`);
    return { ok: bad.length === 0, detail: bad.join('; ') || `idom=[${[...d.idom]}]` };
  });
  check('C', `${name}: ipdom matches the brute-force oracle`, () => {
    const g = graphOf(c.succ);
    const pd = postDominators(g);
    const slow = immediateFromSets(bruteForcePostDominators(g, pd).sets, pd.exit, (b) => b === pd.exit || pd.dom.reachable(b));
    const bad = [];
    for (let b = 0; b < g.n; b++) {
      if (!pd.dom.reachable(b)) continue;
      if (slow[b] !== pd.ipdom[b]) bad.push(`B${b}: fast ${pd.ipdom[b]} slow ${slow[b]}`);
    }
    if (c.ipdom) {
      const got = [...pd.ipdom].map((x) => (x === pd.exit ? 'EXIT' : x));
      if (!eq(got, c.ipdom)) bad.push(`ipdom ${JSON.stringify(got)} != expected ${JSON.stringify(c.ipdom)}`);
    }
    if (c.virtualExitEdges !== undefined && pd.virtualExitEdges.length !== c.virtualExitEdges) {
      bad.push(`virtual exit edges ${pd.virtualExitEdges.length} != ${c.virtualExitEdges}`);
    }
    return { ok: bad.length === 0, detail: bad.join('; ')
      || `ipdom=[${[...pd.ipdom].map((x) => (x === pd.exit ? 'E' : x))}] virtual=${pd.virtualExitEdges.length}` };
  });
  check('C', `${name}: dominance frontiers`, () => {
    const g = graphOf(c.succ);
    const d = dominators(g);
    // brute force: y is in DF(x) iff x dominates a predecessor of y and does
    // not strictly dominate y
    const bad = [];
    for (let x = 0; x < g.n; x++) {
      if (!d.reachable(x)) continue;
      const want = [];
      for (let y = 0; y < g.n; y++) {
        if (!d.reachable(y)) continue;
        if (g.predList[y].some((p) => d.reachable(p) && d.dominates(x, p)) && !d.strictlyDominates(x, y)) want.push(y);
      }
      const got = [...(d.domFrontier[x] ?? [])].sort((a, b) => a - b);
      if (!eq(got, want.sort((a, b) => a - b))) bad.push(`DF(${x}) = [${got}] want [${want}]`);
    }
    if (c.df) {
      for (let x = 0; x < c.df.length; x++) {
        const got = [...(d.domFrontier[x] ?? [])].sort((a, b) => a - b);
        if (!eq(got, c.df[x])) bad.push(`DF(${x}) = [${got}] expected [${c.df[x]}]`);
      }
    }
    return { ok: bad.length === 0, detail: bad.join('; ') || 'frontiers agree with the definition' };
  });
  check('C', `${name}: loops, nesting and reducibility`, () => {
    const cfg = cfgOf(c.succ, { backward: c.backward });
    const d = dominators(cfg.graph);
    const li = findLoops(cfg, d);
    const bad = [];
    if (c.loops !== undefined && li.loops.length !== c.loops) bad.push(`${li.loops.length} loops, expected ${c.loops}`);
    if (c.loopHeaders && !eq(li.loops.map((l) => l.header), c.loopHeaders)) bad.push(`headers ${li.loops.map((l) => l.header)} != ${c.loopHeaders}`);
    if (c.loopDepths && !eq(li.loops.map((l) => l.depth), c.loopDepths)) bad.push(`depths ${li.loops.map((l) => l.depth)} != ${c.loopDepths}`);
    if (c.loopExits !== undefined && li.loops[0] && li.loops[0].exits.length !== c.loopExits) {
      bad.push(`${li.loops[0].exits.length} exits, expected ${c.loopExits}`);
    }
    const wantIrr = c.irreducible ?? 0;
    if (li.irreducible.length !== wantIrr) bad.push(`${li.irreducible.length} irreducible edges, expected ${wantIrr}`);
    // the forest must be a forest and every header must dominate its body
    for (const l of li.loops) {
      for (const b of l.body) if (!d.dominates(l.header, b)) bad.push(`loop${l.id}: header does not dominate B${b}`);
      let p = l.parent, steps = 0;
      while (p !== null && steps++ <= li.loops.length) p = li.loops[p].parent;
      if (steps > li.loops.length) bad.push(`loop${l.id}: parent chain is cyclic`);
    }
    return { ok: bad.length === 0, detail: bad.join('; ')
      || `${li.loops.length} loop(s), ${li.irreducible.length} irreducible, depths [${li.loops.map((l) => l.depth)}]` };
  });
}

// ----------------------------------------------------------------- D ir
//
// The same shapes again, but assembled as bytecode and taken all the way
// through buildIR, so phi placement, the effect order, the exception edges and
// the jump tables are exercised rather than just the graph algorithms.

const P = loadProfile(path.join('profiles', TAGS[0]));
const FB = { slot: 0 };

/**
 * BuildSuspendPoint's shape, twice over, with the second suspend on the normal
 * path out of the first resume (which is where V8 puts it) rather than after
 * an unconditional jump, so every block is reachable:
 *
 *   SuspendGenerator ... <id>
 *   Bind(jump_table, id)
 *   ResumeGenerator ...
 */
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

function irOf(buildFn, unitExtra = {}, irOpts = {}) {
  const a = asm(P);
  buildFn(a);
  const { scopeInfoById, ...rest } = unitExtra;
  const { unit } = a.build(rest);
  return buildIR(unit, { profile: P, scopeInfoById: scopeInfoById ?? null, ...irOpts });
}

check('D', 'diamond: one phi for the accumulator at the join', () => {
  const ir = irOf((a) => {
    a.emit('LdaZero')
      .emit('JumpIfToBooleanFalse', [{ label: 'else' }])
      .emit('LdaSmi', [{ imm: 1 }])
      .emit('Star', [{ reg: 0 }])
      .emit('Jump', [{ label: 'join' }])
      .label('else')
      .emit('LdaSmi', [{ imm: 2 }])
      .emit('Star', [{ reg: 0 }])
      .label('join')
      .emit('Ldar', [{ reg: 0 }])
      .emit('Return');
  });
  const join = ir.blocks.find((b) => b.preds.length === 2);
  const phis = join ? join.phis.map((p) => ir.values[p]) : [];
  const bad = [];
  if (ir.blocks.length !== 4) bad.push(`${ir.blocks.length} blocks, expected 4`);
  if (phis.length !== 1) bad.push(`${phis.length} phis at the join, expected 1`);
  else {
    if (phis[0].varName !== 'r0') bad.push(`the phi is for ${phis[0].varName}, expected r0`);
    if (phis[0].operands.length !== 2) bad.push(`phi arity ${phis[0].operands.length}`);
    if (phis[0].operands[0] === phis[0].operands[1]) bad.push('both phi operands are the same definition');
  }
  const kinds = ir.edges.map((e) => e.kind).sort();
  if (!eq(kinds, ['fallthrough', 'false', 'true', 'unconditional'])) bad.push(`edge kinds ${kinds}`);
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `4 blocks, phi r0 arity 2, edges ${kinds.join('/')}` };
});

check('D', 'loop: a phi at the header, a back edge, and the latch found', () => {
  const ir = irOf((a) => {
    a.emit('LdaZero').emit('Star', [{ reg: 0 }])
      .label('head')
      .emit('Ldar', [{ reg: 0 }])
      .emit('TestLessThan', [{ reg: 1 }, FB])
      .emit('JumpIfFalse', [{ label: 'done' }])
      .emit('Ldar', [{ reg: 0 }])
      .emit('Inc', [FB])
      .emit('Star', [{ reg: 0 }])
      .emit('JumpLoop', [{ label: 'head' }, { imm: 0 }, FB])
      .label('done')
      .emit('Ldar', [{ reg: 0 }])
      .emit('Return');
  });
  const bad = [];
  if (ir.loops.length !== 1) bad.push(`${ir.loops.length} loops`);
  else {
    const l = ir.loops[0];
    const header = ir.blocks[l.header];
    if (!header.kinds.includes('loopHeader')) bad.push('the header is not marked loopHeader');
    if (l.latches.length !== 1) bad.push(`${l.latches.length} latches`);
    const phis = header.phis.map((p) => ir.values[p]);
    if (!phis.some((p) => p.varName === 'r0')) bad.push(`no phi for r0 at the header (got ${phis.map((p) => p.varName)})`);
    if (l.exits.length !== 1) bad.push(`${l.exits.length} exit edges`);
  }
  if (ir.stats.jumpLoopBackEdges !== 1) bad.push(`${ir.stats.jumpLoopBackEdges} JumpLoop back edges`);
  if (ir.stats.irreducibleBackEdges !== 0) bad.push('reported irreducible');
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `1 loop, 1 latch, phi r0 at the header, ${ir.stats.jumpLoopBackEdges} back edge` };
});

check('D', 'nested try: innermost-first handler lookup and the exception edges', () => {
  const ir = irOf((a) => {
    const nameA = a.constant({ t: 'string', v: 'a' });
    a.emit('LdaUndefined').emit('Star', [{ reg: 0 }])
      .label('outerStart')
      .emit('GetNamedProperty', [{ reg: 0 }, { const: nameA }, FB])     // can throw
      .label('innerStart')
      .emit('GetNamedProperty', [{ reg: 0 }, { const: nameA }, FB])     // can throw, inner range
      .emit('Star', [{ reg: 1 }])
      .label('innerEnd')
      .emit('Jump', [{ label: 'outerEnd' }])
      .label('innerHandler')
      .emit('Star', [{ reg: 2 }])                                       // the caught exception
      .emit('Ldar', [{ reg: 2 }])
      .emit('ReThrow')
      .label('outerEnd')
      .emit('LdaUndefined')
      .emit('Return')
      .label('outerHandler')
      .emit('Star', [{ reg: 3 }])
      .emit('LdaUndefined')
      .emit('Return');
    // the inner range is nested inside the outer one, and the inner handler is
    // itself inside the outer range, which is what makes innermost-only
    // exception edges conservative
    a.handler('outerStart', 'outerEnd', 'outerHandler', 1);
    a.handler('innerStart', 'innerEnd', 'innerHandler', 1);
  }, { registerCount: 4 });
  const bad = [];
  const handlerBlocks = ir.blocks.filter((b) => b.isHandlerEntryFor.length);
  if (handlerBlocks.length !== 2) bad.push(`${handlerBlocks.length} handler blocks`);
  // the innermost range wins: the block starting at innerStart must point at
  // the inner handler, not the outer one
  const byOffset = new Map(ir.blocks.map((b) => [b.startOffset, b]));
  const inner = ir.handlers[1];
  const innerRangeBlock = byOffset.get(inner.rangeStart);
  if (!innerRangeBlock) bad.push('no block starts at the inner range start');
  else if (innerRangeBlock.handlerIndex !== inner.index) {
    bad.push(`the inner range block is under handler ${innerRangeBlock.handlerIndex}, expected ${inner.index}`);
  }
  // the inner handler block must itself have an exception edge to the outer one
  const innerHandlerBlock = byOffset.get(inner.handlerOffset);
  if (!innerHandlerBlock) bad.push('no block at the inner handler offset');
  else if (!innerHandlerBlock.exceptionSuccs.length) {
    bad.push('the inner handler has no exception edge to the outer handler, so a rethrow would be lost');
  }
  if (ir.stats.handlerNotInsideEnclosingRange !== 0) bad.push('the inner handler is not covered by the outer range');
  // the accumulator at a handler entry is a CaughtException, not a phi
  for (const b of handlerBlocks) {
    if (b.caughtException === null) bad.push(`B${b.id} has no CaughtException definition`);
    if (b.phis.some((p) => ir.values[p].var === 0)) bad.push(`B${b.id} has an accumulator phi`);
  }
  if (ir.stats.exceptionEdges < 3) bad.push(`only ${ir.stats.exceptionEdges} exception edges`);
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `2 handlers, ${ir.stats.exceptionEdges} exception edges, innermost-first, CaughtException at both` };
});

check('D', 'exception edges leave the throwing instruction, not the block', () => {
  // Two throwing sites in one range, with a register written between them. The
  // handler must see a phi, because the two sites disagree about r1 -- which is
  // exactly what ARCHITECTURE.md 4.2's coarse "one phi over the range blocks"
  // model cannot express.
  const ir = irOf((a) => {
    const nameA = a.constant({ t: 'string', v: 'a' });
    a.emit('LdaZero').emit('Star', [{ reg: 1 }])
      .label('tryStart')
      .emit('GetNamedProperty', [{ reg: 0 }, { const: nameA }, FB])     // site 1: r1 == 0
      .emit('LdaSmi', [{ imm: 7 }])
      .emit('Star', [{ reg: 1 }])
      .emit('GetNamedProperty', [{ reg: 0 }, { const: nameA }, FB])     // site 2: r1 == 7
      .label('tryEnd')
      .emit('LdaUndefined').emit('Return')
      .label('handler')
      .emit('Star', [{ reg: 2 }])
      .emit('Ldar', [{ reg: 1 }])                                       // reads r1
      .emit('Return');
    a.handler('tryStart', 'tryEnd', 'handler', 1);
  }, { registerCount: 4 });
  const bad = [];
  const h = ir.blocks.find((b) => b.isHandlerEntryFor.length);
  if (!h) return { ok: false, detail: 'no handler block' };
  if (h.exceptionPreds.length !== 2) bad.push(`${h.exceptionPreds.length} exception predecessors, expected 2`);
  const phis = h.phis.map((p) => ir.values[p]);
  const r1 = phis.find((p) => p.varName === 'r1');
  if (!r1) bad.push(`no phi for r1 at the handler (got ${phis.map((p) => p.varName)})`);
  else if (r1.operands[0] === r1.operands[1]) bad.push('the r1 phi has the same operand twice');
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `2 exception predecessors, phi r1 with distinct operands (v${r1.operands.join(', v')})` };
});

check('D', 'switch fan-out: a jump table with five cases and a fall-through', () => {
  const ir = irOf((a) => {
    a.emit('LdaZero')
      .emit('SwitchOnSmiNoFeedback', [{ table: ['c0', 'c1', 'c2', 'c3', 'c4'] }, { u: 5 }, { imm: 0 }])
      .emit('Jump', [{ label: 'join' }])
      .label('c0').emit('LdaSmi', [{ imm: 0 }]).emit('Jump', [{ label: 'join' }])
      .label('c1').emit('LdaSmi', [{ imm: 1 }]).emit('Jump', [{ label: 'join' }])
      .label('c2').emit('LdaSmi', [{ imm: 2 }]).emit('Jump', [{ label: 'join' }])
      .label('c3').emit('LdaSmi', [{ imm: 3 }]).emit('Jump', [{ label: 'join' }])
      .label('c4').emit('LdaSmi', [{ imm: 4 }])
      .label('join').emit('Return');
  });
  const bad = [];
  const disp = ir.blocks.find((b) => b.kinds.includes('switchDispatch'));
  if (!disp) return { ok: false, detail: 'no switchDispatch block' };
  if (disp.isGeneratorDispatch) bad.push('SwitchOnSmiNoFeedback was classified as a generator dispatcher');
  const sw = ir.edges.filter((e) => e.kind === 'switch');
  if (sw.length !== 5) bad.push(`${sw.length} switch edges, expected 5`);
  if (!eq(sw.map((e) => e.caseValue), [0, 1, 2, 3, 4])) bad.push(`case values ${sw.map((e) => e.caseValue)}`);
  if (!disp.outEdges.some((eid) => ir.edges[eid].kind === 'fallthrough')) bad.push('no out-of-range fall-through edge');
  const join = ir.blocks.find((b) => b.preds.length >= 5);
  if (!join) bad.push('the cases do not join');
  else if (join.phis.length !== 1 || ir.values[join.phis[0]].operands.length !== join.preds.length) {
    bad.push(`join phis ${join.phis.length}, arity ${join.phis.map((p) => ir.values[p].operands.length)}, preds ${join.preds.length}`);
  }
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `5 switch edges + fall-through, join phi arity ${ir.values[ir.blocks.find((b) => b.preds.length >= 5).phis[0]].operands.length}` };
});

check('D', 'generator dispatcher: resume points are ordinary multi-predecessor joins', () => {
  // The shape of BuildSuspendPoint: a dispatcher at offset 0 whose table
  // targets each ResumeGenerator, each immediately after its SuspendGenerator,
  // and the resumes join on a shared continuation.
  const ir = irOf(generatorShape, { registerCount: 5, isGenerator: true, incomingNewTargetOrGeneratorRegister: 0 });
  const bad = [];
  const disp = ir.blocks.find((b) => b.kinds.includes('switchDispatch'));
  if (!disp) return { ok: false, detail: 'no dispatcher block' };
  if (!disp.isGeneratorDispatch) bad.push('the dispatcher was not recognised as a generator dispatcher');
  const resumeEdges = ir.edges.filter((e) => e.kind === 'switch' && e.generatorResume);
  if (resumeEdges.length !== 2) bad.push(`${resumeEdges.length} resume edges`);
  // SuspendGenerator must terminate its block: no fall-through into the resume
  const suspendBlocks = ir.blocks.filter((b) => b.terminator.opcode === 'SuspendGenerator');
  if (suspendBlocks.length !== 2) bad.push(`${suspendBlocks.length} blocks end in SuspendGenerator`);
  for (const b of suspendBlocks) if (b.succs.length !== 0) bad.push(`B${b.id} falls through out of SuspendGenerator`);
  // the continuation is a real join with a phi
  const cont = ir.blocks.find((b) => b.preds.length === 2 && !b.isHandlerEntryFor.length && b.id !== disp.id);
  if (!cont) bad.push('no two-predecessor continuation');
  else if (!cont.phis.length) bad.push('the continuation has no phi');
  if (ir.stats.irreducibleBackEdges !== 0) bad.push('reported irreducible');
  // every table target is a block leader and is a ResumeGenerator
  for (const e of resumeEdges) {
    const b = ir.blocks[e.to];
    if (b.instructions[0].opcode !== 'ResumeGenerator') bad.push(`resume target B${b.id} starts with ${b.instructions[0].opcode}`);
  }
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `2 resume edges onto ResumeGenerator leaders, suspends terminate, continuation phi arity `
      + `${cont ? ir.values[cont.phis[0]]?.operands.length : '?'}` };
});

check('D', 'finally token dispatch: SwitchOnSmiNoFeedback on a saved token register', () => {
  // V8's finally desugaring: a token register is set on each path out of the
  // try, the cleanup runs, and a trailing SwitchOnSmiNoFeedback re-dispatches
  // on the token. ARCHITECTURE.md 4.4.5 says this shape must be recognised
  // rather than left as a state machine; the IR has to represent it exactly.
  const ir = irOf((a) => {
    a.emit('LdaSmi', [{ imm: -1 }]).emit('Star', [{ reg: 0 }])    // token = -1
      .label('tryStart')
      .emit('GetNamedProperty', [{ reg: 1 }, { const: a.constant({ t: 'string', v: 'x' }) }, FB])
      .emit('LdaZero').emit('Star', [{ reg: 0 }])                 // token = 0 (fall off the try)
      .label('tryEnd')
      .emit('Jump', [{ label: 'finally' }])
      .label('handler')
      .emit('Star', [{ reg: 2 }])                                 // the caught exception
      .emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 0 }])    // token = 1 (rethrow)
      .label('finally')
      .emit('LdaUndefined')                                       // the cleanup block
      .emit('Star', [{ reg: 3 }])
      .emit('Ldar', [{ reg: 0 }])
      .emit('SwitchOnSmiNoFeedback', [{ table: ['tok0', 'tok1'] }, { u: 2 }, { imm: 0 }])
      .emit('Jump', [{ label: 'fallOut' }])
      .label('tok0').emit('LdaUndefined').emit('Return')
      .label('tok1').emit('Ldar', [{ reg: 2 }]).emit('ReThrow')
      .label('fallOut').emit('LdaUndefined').emit('Return');
    a.handler('tryStart', 'tryEnd', 'handler', 0);                // UNCAUGHT: finally only
  }, { registerCount: 5 });
  const bad = [];
  const h = ir.blocks.find((b) => b.isHandlerEntryFor.length);
  if (!h) bad.push('no handler block');
  else if (ir.handlers[0].predictionName !== 'UNCAUGHT') bad.push(`prediction ${ir.handlers[0].predictionName}`);
  const disp = ir.blocks.find((b) => b.kinds.includes('switchDispatch'));
  if (!disp) return { ok: false, detail: 'no token dispatch block' };
  // the dispatch block is the join of the normal and the exceptional path, so
  // the token register needs a phi there
  const fin = ir.blocks.find((b) => b.preds.length === 2 && b.instructions.some((x) => x.opcode === 'Star'));
  if (!fin) bad.push('no two-predecessor cleanup block');
  else {
    const names = fin.phis.map((p) => ir.values[p].varName);
    if (!names.includes('r0')) bad.push(`the cleanup block has no phi for the token register (got ${names})`);
  }
  const sw = ir.edges.filter((e) => e.kind === 'switch');
  if (sw.length !== 2) bad.push(`${sw.length} token edges`);
  if (sw.some((e) => e.generatorResume)) bad.push('a token edge was classified as a generator resume');
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `UNCAUGHT range, token phi at the cleanup join, ${sw.length} token dispatch edges` };
});

check('D', 'effect order: a total order per block, merged across blocks', () => {
  const ir = irOf((a) => {
    const nx = a.constant({ t: 'string', v: 'x' });
    const ny = a.constant({ t: 'string', v: 'y' });
    a.emit('GetNamedProperty', [{ reg: 0 }, { const: nx }, FB])         // e1
      .emit('Star', [{ reg: 1 }])                                       // pure
      .emit('CreateEmptyObjectLiteral')                                 // allocates, no effect
      .emit('Star', [{ reg: 2 }])
      .emit('Ldar', [{ reg: 1 }])
      .emit('SetNamedProperty', [{ reg: 2 }, { const: ny }, FB])        // e2
      .emit('JumpIfToBooleanFalse', [{ label: 'skip' }])
      .emit('GetNamedProperty', [{ reg: 2 }, { const: nx }, FB])        // e3
      .label('skip')
      .emit('LdaUndefined')
      .emit('Return');
  }, { registerCount: 4 });
  const bad = [];
  const entryBlock = ir.blocks[0];
  const chain = entryBlock.effects.map((v) => ir.values[v].op);
  if (!eq(chain, ['GetNamedProperty', 'SetNamedProperty'])) bad.push(`block 0 chain ${chain}`);
  // a pure allocation stays out of the chain but is flagged
  const alloc = ir.values.find((v) => v.op === 'CreateEmptyObjectLiteral');
  if (!alloc.allocatesIdentity) bad.push('CreateEmptyObjectLiteral does not allocate an identity');
  if (alloc.hasEffect) bad.push('CreateEmptyObjectLiteral claims an effect');
  if (entryBlock.effects.includes(alloc.id)) bad.push('a pure allocation is in the effect chain');
  // the order inside the block must be the instruction order
  const idx = entryBlock.effects.map((v) => ir.values[v].instruction);
  for (let i = 1; i < idx.length; i++) if (idx[i] <= idx[i - 1]) bad.push('the in-block effect order is not the instruction order');
  // the join needs an effect phi because the two paths end at different effects
  const join = ir.blocks.find((b) => b.preds.length === 2);
  if (!join) bad.push('no join');
  else if (ir.effectGraph.effectPhi[join.id] < 0) bad.push('the join has no effect phi');
  else {
    const p = ir.values[ir.effectGraph.effectPhi[join.id]];
    if (p.operands.length !== 2 || p.operands[0] === p.operands[1]) bad.push(`effect phi operands ${p.operands}`);
  }
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `chain ${chain.join(' -> ')}, pure allocation excluded, effect phi at the join` };
});

check('D', 'the incoming new.target / generator register is an ordinary local', () => {
  const ir = irOf((a) => {
    a.emit('SwitchOnGeneratorState', [{ reg: 2 }, { table: ['r0'] }, { u: 1 }])
      .emit('LdaUndefined')
      .label('r0')
      .emit('Ldar', [{ reg: 2 }])
      .emit('Return');
  }, { registerCount: 4, isGenerator: true, incomingNewTargetOrGeneratorRegister: 2 });
  const bad = [];
  const entry = ir.values.find((v) => v.kind === 'FrameEntry' && v.incomingNewTargetOrGenerator);
  if (!entry) bad.push('no entry definition for the incoming generator register');
  else {
    if (entry.reg.k !== 'local' || entry.reg.i !== 2) bad.push(`it is ${JSON.stringify(entry.reg)}, expected local r2`);
    const uses = ir.defUse.get(entry.id) ?? [];
    // both the dispatcher and the later Ldar must name the SAME definition
    if (uses.length < 2) bad.push(`only ${uses.length} use(s) resolved to it, so the two references did not unify`);
  }
  return { ok: bad.length === 0, detail: bad.join('; ')
    || `r2 is a FrameEntry local with ${(ir.defUse.get(entry.id) ?? []).length} uses` };
});

check('D', 'context slots resolve against a hand-built scope chain', () => {
  // depth 0 is the context the closure captured, which is unit.scope.outer.
  const inner = { scopeInfoId: 20, scopeType: 'BLOCK_SCOPE', flags: {}, contextLocalCount: 1, contextLocalNames: ['f'], contextLocalInfos: [{ mode: 'kLet' }], outer: null };
  const mid = { scopeInfoId: 10, scopeType: 'FUNCTION_SCOPE', flags: {}, contextLocalCount: 2, contextLocalNames: ['d', 'e'], contextLocalInfos: [{ mode: 'kVar' }, { mode: 'kLet' }], outer: null };
  const outer = { scopeInfoId: 1, scopeType: 'FUNCTION_SCOPE', flags: {}, contextLocalCount: 3, contextLocalNames: ['a', 'b', 'c'], contextLocalInfos: [{ mode: 'kVar' }, { mode: 'kLet' }, { mode: 'kConst' }], outer: null };
  mid.outer = outer;
  inner.outer = mid;
  const own = { scopeInfoId: 30, scopeType: 'FUNCTION_SCOPE', flags: {}, contextLocalCount: 0, contextLocalNames: [], contextLocalInfos: [], outer: inner };
  const ir = irOf((a) => {
    a.emit('LdaImmutableCurrentContextSlot', [{ slot: 2 }])                            // f
      .emit('LdaImmutableContextSlot', [{ special: 'context' }, { slot: 2 }, { u: 1 }])  // d
      .emit('LdaImmutableContextSlot', [{ special: 'context' }, { slot: 3 }, { u: 1 }])  // e
      .emit('LdaImmutableContextSlot', [{ special: 'context' }, { slot: 4 }, { u: 2 }])  // c
      .emit('Return');
  }, { scope: own });
  const got = ir.values.filter((v) => v.contextSlot).map((v) => v.contextSlot.name);
  const ok = eq(got, ['f', 'd', 'e', 'c']);
  return { ok, detail: ok ? 'depth 0/1/1/2 -> f, d, e, c' : `got ${JSON.stringify(got)}, expected ["f","d","e","c"]` };
});

check('D', 'PushContext / PopContext move the depth baseline', () => {
  const blockScope = { scopeInfoId: 50, scopeType: 'BLOCK_SCOPE', flags: {}, contextLocalCount: 1, contextLocalNames: ['inBlock'], contextLocalInfos: [{ mode: 'kLet' }], outer: null };
  const outerScope = { scopeInfoId: 1, scopeType: 'FUNCTION_SCOPE', flags: {}, contextLocalCount: 1, contextLocalNames: ['captured'], contextLocalInfos: [{ mode: 'kVar' }], outer: null };
  blockScope.outer = outerScope;
  const own = { scopeInfoId: 60, scopeType: 'FUNCTION_SCOPE', flags: {}, contextLocalCount: 0, contextLocalNames: [], contextLocalInfos: [], outer: outerScope };
  const ir = irOf((a) => {
    const si = a.constant({ t: 'scopeInfo', scopeInfoId: 50 });
    a.emit('LdaImmutableCurrentContextSlot', [{ slot: 2 }])      // captured, before the push
      .emit('CreateBlockContext', [{ const: si }])
      .emit('PushContext', [{ reg: 0 }])
      .emit('LdaImmutableCurrentContextSlot', [{ slot: 2 }])      // inBlock, inside
      .emit('LdaImmutableContextSlot', [{ special: 'context' }, { slot: 2 }, { u: 1 }])   // captured, depth 1
      .emit('PopContext', [{ reg: 0 }])
      .emit('LdaImmutableCurrentContextSlot', [{ slot: 2 }])      // captured again, after the pop
      .emit('Return');
  }, { scope: own, scopeInfoById: new Map([[50, blockScope]]) });
  const got = ir.values.filter((v) => v.contextSlot).map((v) => v.contextSlot.name);
  const ok = eq(got, ['captured', 'inBlock', 'captured', 'captured']);
  return { ok, detail: ok ? 'before/inside/depth-1/after -> captured, inBlock, captured, captured'
    : `got ${JSON.stringify(got)}` };
});

// -------------------------------------------------------- E invariants
const IR_CASES = [
  ['diamond', (a) => {
    a.emit('LdaZero').emit('JumpIfToBooleanFalse', [{ label: 'e' }])
      .emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 0 }]).emit('Jump', [{ label: 'j' }])
      .label('e').emit('LdaSmi', [{ imm: 2 }]).emit('Star', [{ reg: 0 }])
      .label('j').emit('Ldar', [{ reg: 0 }]).emit('Return');
  }, {}],
  ['nested loop', (a) => {
    a.emit('LdaZero').emit('Star', [{ reg: 0 }])
      .label('outer').emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 3 }, FB]).emit('JumpIfFalse', [{ label: 'done' }])
      .emit('LdaZero').emit('Star', [{ reg: 1 }])
      .label('inner').emit('Ldar', [{ reg: 1 }]).emit('TestLessThan', [{ reg: 3 }, FB]).emit('JumpIfFalse', [{ label: 'innerDone' }])
      .emit('Ldar', [{ reg: 1 }]).emit('Inc', [FB]).emit('Star', [{ reg: 1 }])
      .emit('JumpLoop', [{ label: 'inner' }, { imm: 1 }, FB])
      .label('innerDone').emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
      .emit('JumpLoop', [{ label: 'outer' }, { imm: 0 }, FB])
      .label('done').emit('Ldar', [{ reg: 0 }]).emit('Return');
  }, { registerCount: 4 }],
  ['loop with two exits', (a) => {
    a.emit('LdaZero').emit('Star', [{ reg: 0 }])
      .label('h').emit('Ldar', [{ reg: 0 }]).emit('TestLessThan', [{ reg: 2 }, FB]).emit('JumpIfFalse', [{ label: 'x1' }])
      .emit('Ldar', [{ reg: 0 }]).emit('TestEqualStrict', [{ reg: 3 }, { u: 0 }]).emit('JumpIfTrue', [{ label: 'x2' }])
      .emit('Ldar', [{ reg: 0 }]).emit('Inc', [FB]).emit('Star', [{ reg: 0 }])
      .emit('JumpLoop', [{ label: 'h' }, { imm: 0 }, FB])
      .label('x1').emit('LdaSmi', [{ imm: 1 }]).emit('Return')
      .label('x2').emit('LdaSmi', [{ imm: 2 }]).emit('Return');
  }, { registerCount: 4 }],
  ['switch fan-out', (a) => {
    a.emit('LdaZero').emit('SwitchOnSmiNoFeedback', [{ table: ['a', 'b', 'c'] }, { u: 3 }, { imm: 0 }])
      .emit('Jump', [{ label: 'j' }])
      .label('a').emit('LdaSmi', [{ imm: 1 }]).emit('Jump', [{ label: 'j' }])
      .label('b').emit('LdaSmi', [{ imm: 2 }]).emit('Jump', [{ label: 'j' }])
      .label('c').emit('LdaSmi', [{ imm: 3 }])
      .label('j').emit('Return');
  }, {}],
  ['nested try', (a) => {
    const nm = a.constant({ t: 'string', v: 'a' });
    a.label('o').emit('GetNamedProperty', [{ reg: 0 }, { const: nm }, FB])
      .label('i').emit('GetNamedProperty', [{ reg: 0 }, { const: nm }, FB])
      .label('ie').emit('Jump', [{ label: 'oe' }])
      .label('ih').emit('Star', [{ reg: 1 }]).emit('ReThrow')
      .label('oe').emit('LdaUndefined').emit('Return')
      .label('oh').emit('Star', [{ reg: 2 }]).emit('LdaUndefined').emit('Return');
    a.handler('o', 'oe', 'oh', 1);
    a.handler('i', 'ie', 'ih', 1);
  }, { registerCount: 4 }],
  ['generator dispatcher', generatorShape,
    { registerCount: 5, isGenerator: true, incomingNewTargetOrGeneratorRegister: 0 }],
  ['finally token dispatch', (a) => {
    a.emit('LdaSmi', [{ imm: -1 }]).emit('Star', [{ reg: 0 }])
      .label('ts').emit('GetNamedProperty', [{ reg: 1 }, { const: a.constant({ t: 'string', v: 'x' }) }, FB])
      .emit('LdaZero').emit('Star', [{ reg: 0 }])
      .label('te').emit('Jump', [{ label: 'f' }])
      .label('h').emit('Star', [{ reg: 2 }]).emit('LdaSmi', [{ imm: 1 }]).emit('Star', [{ reg: 0 }])
      .label('f').emit('LdaUndefined').emit('Star', [{ reg: 3 }]).emit('Ldar', [{ reg: 0 }])
      .emit('SwitchOnSmiNoFeedback', [{ table: ['t0', 't1'] }, { u: 2 }, { imm: 0 }])
      .emit('Jump', [{ label: 'fo' }])
      .label('t0').emit('LdaUndefined').emit('Return')
      .label('t1').emit('Ldar', [{ reg: 2 }]).emit('ReThrow')
      .label('fo').emit('LdaUndefined').emit('Return');
    a.handler('ts', 'te', 'h', 0);
  }, { registerCount: 5 }],
  ['endless loop', (a) => {
    a.label('h').emit('LdaUndefined').emit('JumpLoop', [{ label: 'h' }, { imm: 0 }, FB]);
  }, {}],
];

for (const [name, build, extra] of IR_CASES) {
  check('E', `${name}: all structural invariants, with the brute-force oracles`, () => {
    const ir = irOf(build, extra);
    const rep = verifyIR(ir, { bruteForce: true });
    const bad = rep.checks.filter((c) => !c.ok);
    return {
      ok: bad.length === 0,
      detail: bad.length
        ? bad.map((c) => `${c.name}: ${c.violations} (${JSON.stringify(c.samples[0] ?? null).slice(0, 120)})`).join('; ')
        : `${rep.checks.length} invariants, ${ir.blocks.length} blocks, ${ir.edges.length} edges, `
          + `${ir.phis.length} phis, ${ir.loops.length} loops`,
    };
  });
}

check('E', 'the disassembler and the assembler agree on every jump target', () => {
  // The assembler computes deltas from the opcode byte and negates the
  // backward one; src/disasm reads them back the same way. A disagreement
  // between the two means one of them has the rule wrong.
  const bad = [];
  for (const [name, build, extra] of IR_CASES) {
    const ir = irOf(build, extra);
    const a2 = asm(P); build(a2);
    const { labels } = a2.build(extra);
    const offsets = new Set(labels.values());
    for (const ins of ir.instructions) {
      if (ins.jumpTarget !== null && !offsets.has(ins.jumpTarget)) {
        bad.push(`${name}: ${ins.opcode}@${ins.offset} -> ${ins.jumpTarget} is not a label`);
      }
      for (const e of ins.jumpTable ?? []) {
        if (e.target !== null && !offsets.has(e.target)) bad.push(`${name}: table case ${e.caseValue} -> ${e.target} is not a label`);
      }
    }
  }
  return { ok: bad.length === 0, detail: bad.slice(0, 3).join('; ') || `${IR_CASES.length} cases, every target is a label` };
});

say('');
say(`${pass} passed, ${fail} failed`);
fs.mkdirSync('scratch/t6', { recursive: true });
fs.writeFileSync('scratch/t6/SELFTEST.md', L.join('\n') + '\n');
process.exitCode = fail === 0 ? 0 : 1;
