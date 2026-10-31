// src/structure/switches.mjs
//
// Both of V8's `switch` shapes.
//
// ARCHITECTURE.md 9.3, measured: the corpus has 11 208 jump tables and only
// **1 140** of them belong to a `switch` statement -- the other 10 068 are
// generator resume dispatchers (dispatcher.mjs removes those). V8 emits a jump
// table only for a dense-enough run of Smi cases; everything else becomes a
// chain of `TestEqualStrict`. So the compare chain is the main form, not a
// footnote, and 4.4.4's "also recognise the if-else chain" is the wrong way
// round.
//
// The jump table
// --------------
// One dispatch block, one `switch` edge per table entry carrying its case
// value, and a fall-through edge for the out-of-range path (docs/IR.md section
// 3) which is the `default`. Nothing to recognise: T6 already decoded the
// table and built the edges.
//
// Worth knowing, and reported rather than folded away: V8 guards the dispatch
// with a run of `if`s -- `typeof x === 'number'`, `x >= min`, `x <= max`,
// `(x|0) === x` -- every one of which branches to the default path. They are
// ordinary conditionals and come out as ordinary `if` regions wrapped around
// the `switch`, which is correct and redundant. `guardBlocks` names them so T9
// can drop them if it wants to.
//
// The compare chain
// -----------------
// A run of blocks, each `LdaSmi/LdaConstant <case>; TestEqualStrict <disc>;
// JumpIfTrue <case body>`, falling through to the next comparison. From a real
// listing of `switch (x) { case 1: ...; case 1000: ...; case 1000000: ... }`:
//
//   B0  LdaSmi [1]        TestEqualStrict r_a0, [0]   Mov r_a0, r0   JumpIfTrue -> B4
//   B1  LdaSmi [1000]     TestEqualStrict r0, [0]                    JumpIfTrue -> B5
//   B2  LdaSmi [1000000]  TestEqualStrict r0, [0]                    JumpIfTrue -> B6
//   B3  Jump -> default
//
// Two things that listing settles:
//
// * the case value is in the **accumulator** and the discriminant is the
//   **register** operand, not the other way round;
// * the discriminant is not the same SSA value in every link -- link 0 tests
//   the parameter and links 1..n test a `Mov` of it. So links are matched on
//   the discriminant *up to pure register copies*.
//
// This is also what tells a `switch` apart from an `if`/`else if` chain on the
// same variable, which is otherwise indistinguishable:
//
//   switch:  JumpIfTrue -> the case body,  fall through to the next test
//   if-else: JumpIfFalse -> the next test, fall through into the body
//
// i.e. in a `switch` every comparison is emitted before every body. The
// detector requires the `JumpIfTrue` direction, so an `if` chain stays an `if`
// chain.

import { structureFacts } from './facts.mjs';

/** Follow pure register copies to the value they all stand for. */
export function copyRoot(ir, facts, ssaId, depth = 0) {
  if (ssaId === null || ssaId === undefined || ssaId < 0 || depth > 8) return ssaId ?? null;
  const v = ir.values[ssaId];
  if (!v || v.kind !== 'Op') return ssaId;
  if (!facts.isCopy(v)) return ssaId;
  const src = v.inputs?.[0];
  if (src === undefined || src === null || src < 0) return ssaId;
  return copyRoot(ir, facts, src, depth + 1);
}

/**
 * @param {object} ir
 * @param {object} facts  structureFacts(profile)
 * @param {object} g      the structuring graph
 * @param {{excludeBlocks?: Set<number>, finallyDispatchBlocks?: Set<number>}} opts
 *        `finallyDispatchBlocks` are the token dispatches exceptions.mjs
 *        recognised. They are **planned like any other table** and merely
 *        flagged, because declining to plan one leaves a block whose
 *        terminator is a switch with nothing to emit it -- which failed 94
 *        functions of the first 153 corpus files into the fall-back with
 *        `unplannedSwitchTerminator`. A token dispatch emitted as a `switch`
 *        on the token register is exactly what the bytecode does; the
 *        `finallyShape` annotation travels alongside for T9.
 */
export function planSwitches(ir, facts, g, opts = {}) {
  const exclude = opts.excludeBlocks ?? new Set();
  const finallyDispatch = opts.finallyDispatchBlocks ?? new Set();
  const jumpTables = new Map();
  const compareChains = new Map();
  const linkOf = new Map();          // block -> the chain head it belongs to
  const stats = {
    jumpTables: 0, jumpTableExcluded: 0, jumpTableFinallyToken: 0,
    generatorDispatchers: 0,
    compareChains: 0, compareChainLinks: 0, compareChainImpure: 0,
    guardBlocks: 0,
  };

  // A case target that is nothing but an unconditional jump is a trampoline,
  // not a case body. V8 ends a compare chain with `Jump <default label>`, so
  // the default's target is such a block and the real `default:` body is one
  // hop further on -- and it is also the block the last case falls through
  // into. Reading the trampoline as the default body puts it in the wrong
  // place in the case order and breaks the fall-through. The trampoline holds
  // no statement, so it is placed as an ordinary leaf in front of the
  // `switch`.
  const throughTrampoline = (target) => {
    const b = ir.blocks[target];
    if (!b || b.instructions.length !== 1) return { target, trampoline: null };
    if (!facts.isUnconditionalJump(b.instructions[0].opcodeValue)) return { target, trampoline: null };
    if (g.walkPreds[target].length !== 1) return { target, trampoline: null };
    const to = g.walkSuccs[target][0];
    if (to === undefined || to === null) return { target, trampoline: null };
    return { target: to, trampoline: target };
  };

  // ------------------------------------------------------------ jump tables
  for (const b of ir.blocks) {
    if (!g.reachable(b.id)) continue;
    const last = b.instructions[b.instructions.length - 1];
    if (!last) continue;
    if (facts.isGeneratorDispatch(last.opcodeValue)) { stats.generatorDispatchers++; continue; }
    if (!facts.isSmiSwitch(last.opcodeValue)) continue;
    if (exclude.has(b.id)) { stats.jumpTableExcluded++; continue; }
    const cases = [];
    let def = null;
    for (const eid of b.outEdges) {
      const e = ir.edges[eid];
      if (g.removedEdges.has(e.id)) continue;
      if (e.kind === 'switch') cases.push({ caseValue: e.caseValue, target: e.to, edge: e.id });
      else if (e.kind === 'fallthrough') def = { caseValue: null, target: e.to, edge: e.id };
    }
    if (!cases.length) continue;
    const vid = ir.instructionValue[b.last];
    const term = vid >= 0 ? ir.values[vid] : null;
    const trampolines = [];
    if (def) {
      const t = throughTrampoline(def.target);
      if (t.trampoline !== null) { def.target = t.target; trampolines.push(t.trampoline); }
    }
    const isFinallyToken = finallyDispatch.has(b.id);
    jumpTables.set(b.id, {
      form: 'jumpTable', head: b.id, discBlock: b.id,
      disc: term?.inputs?.[0] ?? null,
      cases, default: def, trampolines, finallyToken: isFinallyToken,
      guardBlocks: guardChainOf(ir, facts, g, b.id, def?.target ?? null),
    });
    stats.jumpTables++;
    if (isFinallyToken) stats.jumpTableFinallyToken++;
    stats.guardBlocks += jumpTables.get(b.id).guardBlocks.length;
  }

  // --------------------------------------------------------- compare chains
  const linkInfo = (blockId) => {
    const b = ir.blocks[blockId];
    const last = b.instructions[b.instructions.length - 1];
    if (!last) return null;
    const row = facts.predicateOf(last.opcodeValue);
    // `switch`: jump when the comparison is TRUE. `if`/`else if`: jump when it
    // is false. Requiring the first keeps an if-chain an if-chain.
    if (!row || row.kind !== 'truthy' || row.negate) return null;
    const vid = ir.instructionValue[b.last];
    const term = vid >= 0 ? ir.values[vid] : null;
    const cmpId = term?.inputs?.[0];
    if (cmpId === undefined || cmpId === null || cmpId < 0) return null;
    const cmp = ir.values[cmpId];
    if (!cmp || cmp.kind !== 'Op' || cmp.op !== facts.op.strictEqual) return null;
    if ((ir.defUse.get(cmpId) ?? []).length !== 1) return null;
    const label = cmp.inputs?.[0] ?? null;          // the accumulator: the case value
    const disc = cmp.inputs?.[1] ?? null;           // the register: the discriminant
    if (label === null || disc === null) return null;
    let trueTo = null, falseTo = null;
    for (const eid of b.outEdges) {
      const e = ir.edges[eid];
      if (e.kind === 'true') trueTo = e.to;
      else if (e.kind === 'false') falseTo = e.to;
    }
    if (trueTo === null || falseTo === null) return null;
    return {
      block: blockId, label, disc, root: copyRoot(ir, facts, disc, 0),
      trueTo, falseTo, compare: cmpId,
      pure: nonTerminatorsPure(ir, facts, blockId),
    };
  };

  for (const b of ir.blocks) {
    if (!g.reachable(b.id) || linkOf.has(b.id) || exclude.has(b.id)) continue;
    const first = linkInfo(b.id);
    if (!first) continue;
    // only start a chain at its head: a link whose predecessor is not itself a
    // link of the same chain
    const preds = g.walkPreds[b.id];
    if (preds.length === 1) {
      const p = linkInfo(preds[0]);
      if (p && p.falseTo === b.id && p.root === first.root) continue;    // not the head
    }
    const links = [first];
    const inChain = new Set([first.block]);
    for (;;) {
      const tail = links[links.length - 1];
      const next = tail.falseTo;
      // `inChain` is the termination guard: nothing stops a chain of
      // equality tests from closing a cycle, and `linkOf` is only written
      // once the chain is complete.
      if (inChain.has(next)) break;
      if (g.walkPreds[next].length !== 1 || exclude.has(next) || linkOf.has(next)) break;
      const info = linkInfo(next);
      if (!info || info.root !== first.root) break;
      links.push(info);
      inChain.add(next);
    }
    if (links.length < 2) continue;
    for (const l of links) linkOf.set(l.block, b.id);
    const impure = links.filter((l) => !l.pure).length;
    if (impure) stats.compareChainImpure++;
    const trampolines = [];
    const t = throughTrampoline(links[links.length - 1].falseTo);
    if (t.trampoline !== null) trampolines.push(t.trampoline);
    compareChains.set(b.id, {
      form: 'compareChain', head: b.id,
      disc: first.root, discBlock: first.block,
      links, trampolines,
      cases: links.map((l) => ({ caseValue: null, testValue: l.label, target: l.trueTo, block: l.block })),
      default: { caseValue: null, target: t.target, edge: null },
      pure: impure === 0,
    });
    stats.compareChains++;
    stats.compareChainLinks += links.length;
  }

  return { jumpTables, compareChains, linkOf, stats };
}

/** Every non-terminator instruction of the block is free of observable effect. */
function nonTerminatorsPure(ir, facts, blockId) {
  const b = ir.blocks[blockId];
  for (let i = b.first; i < b.last; i++) {
    const vid = ir.instructionValue[i];
    if (vid === undefined || vid < 0) continue;
    const v = ir.values[vid];
    if (v && v.kind === 'Op' && v.hasEffect) return false;
  }
  return true;
}

/**
 * The run of `if`s V8 puts in front of a jump table, every one of which
 * branches to the default path. Reported, never removed.
 */
function guardChainOf(ir, facts, g, dispatchBlock, defaultTarget) {
  const out = [];
  if (defaultTarget === null) return out;
  let cur = dispatchBlock;
  for (let guard = 0; guard < 8; guard++) {
    const preds = g.walkPreds[cur];
    if (preds.length !== 1) break;
    const p = preds[0];
    const pb = ir.blocks[p];
    const last = pb.instructions[pb.instructions.length - 1];
    if (!last || !facts.isConditionalJump(last.opcodeValue)) break;
    const succs = g.walkSuccs[p];
    if (succs.length !== 2 || !succs.includes(cur) || !succs.includes(defaultTarget)) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

export { structureFacts };
export default { planSwitches, copyRoot };
