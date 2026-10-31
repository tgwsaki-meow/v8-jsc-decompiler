// src/ir/cfg.mjs
//
// Instruction[] (ARCHITECTURE.md 8.2) -> basic blocks and edges.
//
// Leaders
// -------
//   entry (offset 0)
//   every jump target
//   every jump-table target                       <- 11 208 tables in the corpus
//   the instruction after a jump, a return or a throw
//   the instruction after a switch (its fall-through)
//   every handler entry offset
//   every handler range boundary (start and end)
//   the instruction after a potentially-throwing instruction inside a
//   protected range                               <- see "Exception edges"
//
// Edges
// -----
//   unconditional   an unconditional jump
//   true / false    a conditional jump: `true` is the target, i.e. the edge
//                   taken when the predicate the opcode NAMES holds. So
//                   JumpIfFalse's `true` edge is its jump target, because its
//                   predicate is "the accumulator is false". edge.predicate
//                   spells it out so nothing rests on reading the label.
//   fallthrough     the next instruction, for a block that ends without a
//                   terminator, and the out-of-range path of a switch
//   switch          one per jumpTable[] entry, carrying caseValue
//   exception       a block inside a protected range -> that range's handler
//
// Exception edges
// ---------------
// V8 maps the offset of the *potentially throwing instruction* to a handler,
// innermost range first:
//
//   int HandlerTable::LookupHandlerIndexForRange(int pc_offset) const;
//       -- src/codegen/handler-table.h (14.4.258.16)
//
// and the body walks the table in order, breaking once `pc < range_start` and
// skipping while `pc >= range_end`, keeping the last match. The table is
// emitted sorted by range start and the ranges are well nested, so the last
// match is the innermost one. (ARCHITECTURE.md 8.4's task text calls this
// method `LookupRange`; that was its name before the 2023 rename. The pinned
// 14.4.258.16 header declares `LookupHandlerIndexForRange`, and the same
// header is where the [range_start, range_end, handler_bits, handler_data]
// layout and the prediction/was_used/offset bitfields come from.)
//
// Ranges are half-open: `pc < start` breaks and `pc >= end` continues, so a
// range covers [start, end).
//
// Only the innermost handler gets an edge, exactly as the machine does. That
// is sound for an outer handler because the inner handler's own block lies
// inside the outer range (asserted per function and counted corpus-wide as
// `handlerNotInsideEnclosingRange`), so a rethrow out of the inner handler
// reaches the outer one through an ordinary exception edge from the inner
// handler's block.
//
// ARCHITECTURE.md 4.2 says to take "the phi of all blocks in the protected
// range" and justifies it with "V8 spills anything live across a try before
// entering it". That is not conservative, it is simply wrong, in both
// directions: with one coarse block per try body, a register assigned in the
// body before the throw is reported with its pre-body value, and a register
// assigned after the throw is reported with a value the handler can never
// see. docs/IR.md has the two-line counterexample.
//
// What is done instead is LLVM's `invoke`: inside a protected range every
// potentially-throwing instruction ENDS its block, so the exception edge
// carries the ordinary exit state of its predecessor and Cytron's placement
// stays valid without any special case. The one residual imprecision -- the
// throwing terminator's own register outputs are modelled as written on the
// exception edge too, when the machine would not have written them -- is
// counted per function as `liveInWrittenByThrowingTerminator` rather than
// assumed away.

import { opcodeFacts } from '../disasm/opcode_facts.mjs';
import { opcodeSemantics } from './opcode_effects.mjs';

export const EDGE_KINDS = Object.freeze(['unconditional', 'true', 'false', 'fallthrough', 'switch', 'exception']);
export const BLOCK_KINDS = Object.freeze(['normal', 'loopHeader', 'handler', 'switchDispatch']);

/**
 * Bytecodes that end a basic block without falling through and are not jumps.
 *
 * These are the only five whose interpreter handler does not end in
 * `Dispatch()`:
 *
 *   Return, Throw, ReThrow   leave the frame
 *   Abort                    calls Runtime::kAbort, which does not return;
 *                            emitted under --debug-code only, 0 in the corpus
 *   SuspendGenerator         "Stores the parameters and the register file in
 *                            the generator ... Then, returns the value in the
 *                            accumulator." Its handler ends in
 *                            `Return(GetAccumulator())`, not `Dispatch()`, and
 *                            BytecodeGenerator::BuildSuspendPoint emits no
 *                            Return after it for exactly that reason.
 *
 * SuspendGenerator being a terminator is not a detail. The instruction
 * immediately after it is the matching ResumeGenerator, which is a jump-table
 * target of the entry dispatcher, so treating the suspend as falling through
 * invents an edge from the suspend straight into the resume -- and that edge
 * then shows up as a second entry into whatever loop the await sits in. Over
 * the first twelve corpus files that one wrong edge alone accounted for five
 * of eight "irreducible" findings.
 *
 * Unconditional jumps are added to this set by derivation, not by name: a jump
 * is unconditional iff it neither reads the accumulator nor takes a register
 * operand. In both profiles that selects exactly Jump, JumpConstant and
 * JumpLoop, which is cross-checked at build time.
 */
const NO_FALLTHROUGH_NAMES = Object.freeze(['Return', 'Throw', 'ReThrow', 'Abort', 'SuspendGenerator']);

/** Per-profile control-flow facts, derived once. */
const cfgFactsCache = new WeakMap();

export function cfgFacts(profile) {
  let f = cfgFactsCache.get(profile);
  if (f) return f;
  const facts = opcodeFacts(profile);
  const sem = opcodeSemantics(profile);
  const problems = [];

  const unconditionalJumps = new Set();
  for (const v of facts.isJump) {
    const op = profile.getOpcode(v);
    const s = sem.of(op.name);
    const takesRegister = s.operands.some((o) => o.isRegister);
    if (!s.accumulator.read && !takesRegister) unconditionalJumps.add(v);
  }
  // Cross-check against the names, in both directions, the way
  // opcode_facts.mjs cross-checks the jump family itself.
  const byName = new Set([...facts.isJump].filter((v) => /^Jump(Constant|Loop)?$/.test(profile.getOpcode(v).name)));
  const onlyDerived = [...unconditionalJumps].filter((v) => !byName.has(v)).map((v) => profile.getOpcode(v).name);
  const onlyNamed = [...byName].filter((v) => !unconditionalJumps.has(v)).map((v) => profile.getOpcode(v).name);
  if (onlyDerived.length || onlyNamed.length) {
    problems.push('unconditional-jump derivation disagrees with the Jump / JumpConstant / JumpLoop names: '
      + `only-derived [${onlyDerived.join(',')}] only-named [${onlyNamed.join(',')}]`);
  }
  if (!unconditionalJumps.has(facts.backwardJumpValue)) {
    problems.push('the backward jump is not classified as unconditional');
  }

  const noFallthrough = new Set(unconditionalJumps);
  for (const name of NO_FALLTHROUGH_NAMES) {
    const op = profile.getOpcode(name);
    if (!op) { problems.push(`profile has no opcode ${name}`); continue; }
    if (facts.isJump.has(op.value)) problems.push(`${name} is in the jump family but listed as a non-jump terminator`);
    noFallthrough.add(op.value);
  }

  // The generator resume dispatcher, derived rather than named: it is the one
  // switch whose handler also installs a context (SetContext(generator.context)
  // on a resume). ARCHITECTURE.md 9.2 counts 10 068 of these against 1 140 real
  // `switch` tables, so telling them apart matters for every statistic.
  const generatorDispatch = new Set();
  for (const v of facts.switchRoles.keys()) {
    if (sem.of(profile.getOpcode(v).name).implicitContextWrite) generatorDispatch.add(v);
  }
  if (generatorDispatch.size !== 1) {
    problems.push(`expected exactly one switch opcode that installs a context (the generator resume `
      + `dispatcher); found ${generatorDispatch.size}`);
  }

  // A conditional jump is a jump that is not unconditional.
  const conditionalJumps = new Set([...facts.isJump].filter((v) => !unconditionalJumps.has(v)));

  // The predicate each conditional jump tests, for edge.predicate. Derived
  // from the opcode name with the one fixed grammar V8 uses
  // (JumpIf<Predicate>[Constant]); unknown shapes keep the raw name.
  const predicateOf = new Map();
  for (const v of conditionalJumps) {
    const name = profile.getOpcode(v).name;
    const m = /^JumpIf(.*?)(Constant)?$/.exec(name);
    predicateOf.set(v, m ? m[1] : name);
  }

  if (problems.length) {
    throw new Error(`profile ${profile.version}: cannot derive control-flow facts:\n  ${problems.join('\n  ')}`);
  }

  f = Object.freeze({
    profile, facts, sem,
    unconditionalJumps, conditionalJumps, noFallthrough, predicateOf, generatorDispatch,
    isSwitch: (v) => facts.switchRoles.has(v),
    isJump: (v) => facts.isJump.has(v),
    isBackwardJump: (v) => v === facts.backwardJumpValue,
    isGeneratorDispatch: (v) => generatorDispatch.has(v),
  });
  cfgFactsCache.set(profile, f);
  return f;
}

/**
 * Replicate HandlerTable::LookupHandlerIndexForRange.
 *
 * @param {Array} handlers  unit.handlers, in table order
 * @param {number} pc
 * @returns {number} the index of the innermost covering range, or -1
 */
export function lookupHandlerIndexForRange(handlers, pc) {
  let innermost = -1;
  for (let i = 0; i < handlers.length; i++) {
    const h = handlers[i];
    if (pc < h.rangeStart) break;       // the table is sorted by range start
    if (pc >= h.rangeEnd) continue;     // ranges are half-open
    innermost = i;
  }
  return innermost;
}

/**
 * Build the CFG.
 *
 * @param {{instructions: Array, byOffset: Map, unit: object, profile: object}} dis
 *        the src/disasm result
 * @param {{exceptionPrecision?: 'instruction'|'block'}} opts
 *        'instruction' (default) splits a protected range at every
 *        potentially-throwing instruction so an exception edge can carry the
 *        exact program point. 'block' is ARCHITECTURE.md 4.2's coarse model,
 *        kept so the two can be compared.
 */
export function buildCFG(dis, opts = {}) {
  const { instructions, byOffset, unit, profile } = dis;
  const F = cfgFacts(profile);
  const sem = F.sem;
  const precision = opts.exceptionPrecision ?? 'instruction';
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, ...detail });

  // ------------------------------------------------------------- handlers
  const handlers = (unit.handlers ?? []).map((h, i) => ({ ...h, index: i }));
  for (let i = 1; i < handlers.length; i++) {
    if (handlers[i].rangeStart < handlers[i - 1].rangeStart) {
      warn('handlerTableNotSortedByRangeStart', {
        index: i,
        message: 'LookupHandlerIndexForRange breaks out of its scan on the first range that starts after pc, '
          + 'so an unsorted table would make V8 itself miss handlers',
      });
    }
  }
  for (const h of handlers) {
    if (h.rangeEnd <= h.rangeStart) warn('handlerRangeEmpty', { handler: h.index, start: h.rangeStart, end: h.rangeEnd });
    if (!byOffset.has(h.handlerOffset)) warn('handlerOffsetNotAnInstruction', { handler: h.index, offset: h.handlerOffset });
    if (!byOffset.has(h.rangeStart)) warn('handlerRangeStartNotAnInstruction', { handler: h.index, offset: h.rangeStart });
  }

  // ------------------------------------------------------------- leaders
  const leaders = new Set();
  const addLeader = (off, why) => {
    if (off === null || off === undefined) return;
    if (!byOffset.has(off)) {
      // rangeEnd == bytecode length is normal and is not a leader.
      if (why !== 'handlerRangeEnd' || off !== unit.bytecode.length) {
        warn('leaderNotAnInstruction', { offset: off, why });
      }
      return;
    }
    leaders.add(off);
  };
  if (instructions.length) leaders.add(instructions[0].offset);

  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i];
    const v = ins.opcodeValue;
    const next = instructions[i + 1];
    if (ins.jumpTarget !== null) addLeader(ins.jumpTarget, 'jumpTarget');
    if (ins.jumpTable) for (const e of ins.jumpTable) addLeader(e.target, 'jumpTableTarget');
    if (F.noFallthrough.has(v) || F.conditionalJumps.has(v) || F.isSwitch(v)) {
      if (next) addLeader(next.offset, 'afterTerminator');
    }
  }
  for (const h of handlers) {
    addLeader(h.handlerOffset, 'handlerEntry');
    addLeader(h.rangeStart, 'handlerRangeStart');
    addLeader(h.rangeEnd, 'handlerRangeEnd');
  }

  // Per-instruction innermost handler, and the extra leaders the precise
  // exception model needs: the instruction AFTER a throwing one, so that the
  // throwing instruction ends up last in its block and can be the terminator
  // carrying the exception edge.
  const handlerOfInstruction = new Int32Array(instructions.length).fill(-1);
  const canThrow = new Uint8Array(instructions.length);
  if (handlers.length) {
    for (let i = 0; i < instructions.length; i++) {
      const ins = instructions[i];
      const hi = lookupHandlerIndexForRange(handlers, ins.offset);
      handlerOfInstruction[i] = hi;
      if (hi < 0) continue;
      const s = sem.of(ins.opcode);
      // "Potentially throwing" is exactly the EFFECTS flags: the handler can
      // raise, or it can enter user code which can raise.
      if (s.effect.throws || s.effect.callsUserCode) {
        canThrow[i] = 1;
        if (precision === 'instruction' && instructions[i + 1]) {
          addLeader(instructions[i + 1].offset, 'afterThrowingInstructionInRange');
        }
      }
    }
  }

  // ------------------------------------------------------------- blocks
  const blocks = [];
  const blockOfInstruction = new Int32Array(instructions.length).fill(-1);
  const blockByOffset = new Map();
  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i];
    if (leaders.has(ins.offset) || blocks.length === 0) {
      const b = {
        id: blocks.length,
        startOffset: ins.offset,
        endOffset: ins.offset + ins.length,
        first: i, last: i,
        instructions: [],
        preds: [], succs: [],
        normalPreds: [], normalSuccs: [],
        exceptionPreds: [], exceptionSuccs: [],
        inEdges: [], outEdges: [],
        kind: 'normal', kinds: [],
        isGeneratorDispatch: false,
        handlerIndex: -1,          // the innermost range covering this block
        isHandlerEntryFor: [],     // the ranges whose handler starts here
        canThrow: false,
        throwingTerminator: false,
        terminator: null,
        reachable: false,
      };
      blocks.push(b);
      blockByOffset.set(ins.offset, b.id);
    }
    const b = blocks[blocks.length - 1];
    b.instructions.push(ins);
    b.last = i;
    b.endOffset = ins.offset + ins.length;
    blockOfInstruction[i] = b.id;
    if (canThrow[i]) b.canThrow = true;
  }

  // Per-block handler, plus the uniformity check that makes one handler per
  // block well defined: range boundaries are leaders, so no block can straddle
  // a range edge and every instruction in a block must agree.
  for (const b of blocks) {
    let hi = handlerOfInstruction[b.first];
    for (let i = b.first; i <= b.last; i++) {
      if (handlerOfInstruction[i] !== hi) {
        warn('blockStraddlesHandlerRange', {
          block: b.id, offset: instructions[i].offset,
          message: `instruction ${instructions[i].offset} is covered by handler ${handlerOfInstruction[i]} `
            + `but the block starts under handler ${hi}; a range boundary was not made a leader`,
        });
        hi = -1;
        break;
      }
    }
    b.handlerIndex = hi;
    b.throwingTerminator = canThrow[b.last] === 1;
    if (precision === 'instruction' && b.handlerIndex >= 0) {
      // With a leader after every throwing instruction, a throwing
      // instruction can only be the last of its block. Anything else means a
      // leader was missed and the exception edge would be attached to the
      // wrong program point.
      for (let i = b.first; i < b.last; i++) {
        if (canThrow[i]) {
          warn('throwingInstructionIsNotTheTerminator', {
            block: b.id, offset: instructions[i].offset, opcode: instructions[i].opcode,
          });
          break;
        }
      }
    }
  }
  for (const h of handlers) {
    const hb = blockByOffset.get(h.handlerOffset);
    if (hb === undefined) continue;
    blocks[hb].isHandlerEntryFor.push(h.index);
  }

  // ------------------------------------------------------------- edges
  const edges = [];
  const link = (fromId, toId, kind, extra = {}) => {
    if (toId === undefined || toId === null) return null;
    const e = { id: edges.length, from: fromId, to: toId, kind, ...extra };
    edges.push(e);
    const a = blocks[fromId], b = blocks[toId];
    a.succs.push(toId); b.preds.push(fromId);
    a.outEdges.push(e.id); b.inEdges.push(e.id);
    if (kind === 'exception') { a.exceptionSuccs.push(toId); b.exceptionPreds.push(fromId); }
    else { a.normalSuccs.push(toId); b.normalPreds.push(fromId); }
    return e;
  };
  const blockAt = (off) => blockByOffset.get(off);

  for (const b of blocks) {
    const last = instructions[b.last];
    const v = last.opcodeValue;
    const nextIns = instructions[b.last + 1];
    const fall = nextIns ? blockAt(nextIns.offset) : undefined;
    b.terminator = {
      offset: last.offset, opcode: last.opcode,
      isJump: F.isJump(v), isSwitch: F.isSwitch(v),
      isConditional: F.conditionalJumps.has(v),
      isBackward: F.isBackwardJump(v),
      endsFunction: F.noFallthrough.has(v) && !F.isJump(v),
    };

    if (F.isSwitch(v)) {
      b.kinds.push('switchDispatch');
      b.isGeneratorDispatch = F.isGeneratorDispatch(v);
      for (const e of last.jumpTable ?? []) {
        if (e.target === null) { warn('switchTargetUnresolved', { block: b.id, caseValue: e.caseValue }); continue; }
        const to = blockAt(e.target);
        if (to === undefined) { warn('switchTargetNotALeader', { block: b.id, target: e.target }); continue; }
        link(b.id, to, 'switch', {
          caseValue: e.caseValue, constantIndex: e.constantIndex,
          generatorResume: b.isGeneratorDispatch,
        });
      }
      // Both switches fall through when the dispatch value is out of range:
      // SwitchOnSmiNoFeedback when the Smi is outside [base, base+len), and
      // SwitchOnGeneratorState when the generator register is undefined, which
      // is the first call into a generator or async function.
      if (fall !== undefined) link(b.id, fall, 'fallthrough', { reason: 'switchOutOfRange' });
      else warn('switchWithoutFallthrough', { block: b.id, offset: last.offset });
    } else if (F.unconditionalJumps.has(v)) {
      const to = last.jumpTarget === null ? undefined : blockAt(last.jumpTarget);
      if (to === undefined) warn('jumpTargetNotALeader', { block: b.id, target: last.jumpTarget });
      else link(b.id, to, 'unconditional', { backward: F.isBackwardJump(v) });
    } else if (F.conditionalJumps.has(v)) {
      const to = last.jumpTarget === null ? undefined : blockAt(last.jumpTarget);
      const predicate = F.predicateOf.get(v);
      if (to === undefined) warn('jumpTargetNotALeader', { block: b.id, target: last.jumpTarget });
      else link(b.id, to, 'true', { predicate });
      if (fall !== undefined) link(b.id, fall, 'false', { predicate });
      else warn('conditionalJumpWithoutFallthrough', { block: b.id, offset: last.offset });
    } else if (F.noFallthrough.has(v)) {
      // Return / Throw / ReThrow / Abort: no normal successor.
    } else if (fall !== undefined) {
      link(b.id, fall, 'fallthrough', { reason: 'nextInstruction' });
    } else {
      warn('fallsOffTheEnd', {
        block: b.id, offset: last.offset, opcode: last.opcode,
        message: 'the last block does not end in a terminator, so control runs past the bytecode',
      });
    }
  }

  // Exception edges. One per (throwing site, innermost handler).
  const rangeWithoutThrow = [];
  for (const h of handlers) {
    const hb = blockAt(h.handlerOffset);
    if (hb === undefined) continue;
    let any = 0;
    for (const b of blocks) {
      if (b.handlerIndex !== h.index) continue;
      if (precision === 'instruction' && !b.throwingTerminator) continue;
      link(b.id, hb, 'exception', { handler: h.index, prediction: h.predictionName ?? h.prediction });
      any++;
    }
    if (any === 0) {
      // A range with nothing that can raise. The handler would be unreachable,
      // so wire the range's first block to it and say so rather than leaving a
      // dangling handler block.
      const rb = blockAt(h.rangeStart);
      if (rb !== undefined) {
        link(rb, hb, 'exception', { handler: h.index, prediction: h.predictionName ?? h.prediction, degenerate: true });
      }
      rangeWithoutThrow.push(h.index);
    }
  }

  // The soundness condition for innermost-only edges: a nested range's handler
  // block must itself lie inside the enclosing range.
  let handlerNotInsideEnclosingRange = 0;
  for (const h of handlers) {
    const outer = lookupHandlerIndexForRange(handlers, h.rangeStart);
    // The innermost range covering our own start, excluding ourselves.
    let enclosing = -1;
    for (let i = 0; i < handlers.length; i++) {
      if (i === h.index) continue;
      const o = handlers[i];
      if (h.rangeStart >= o.rangeStart && h.rangeEnd <= o.rangeEnd) {
        if (enclosing < 0 || o.rangeStart >= handlers[enclosing].rangeStart) enclosing = i;
      }
    }
    void outer;
    if (enclosing < 0) continue;
    const o = handlers[enclosing];
    if (!(h.handlerOffset >= o.rangeStart && h.handlerOffset < o.rangeEnd)) {
      handlerNotInsideEnclosingRange++;
      warn('handlerNotInsideEnclosingRange', {
        handler: h.index, enclosing,
        message: 'the inner handler block is not covered by the enclosing range, so a rethrow out of it has no '
          + 'exception edge to the outer handler; innermost-only edges are not conservative for this function',
      });
    }
  }

  // --------------------------------------------------- reachability + kinds
  const reachable = markReachable(blocks, 0);
  let unreachableBlocks = 0;
  for (const b of blocks) {
    b.reachable = reachable[b.id] === 1;
    if (!b.reachable) unreachableBlocks++;
    if (b.isHandlerEntryFor.length) b.kinds.push('handler');
  }

  // Back edges need dominators, so `loopHeader` is stamped on by
  // src/ir/loops.mjs. Resolve 8.4's single `kind` by priority here and let
  // loops.mjs re-resolve after it knows the headers.
  for (const b of blocks) resolveKind(b);

  const stats = {
    blocks: blocks.length,
    edges: edges.length,
    byKind: countBy(edges, (e) => e.kind),
    handlers: handlers.length,
    handlerBlocks: blocks.filter((b) => b.isHandlerEntryFor.length).length,
    exceptionEdges: edges.filter((e) => e.kind === 'exception').length,
    switchEdges: edges.filter((e) => e.kind === 'switch').length,
    switchDispatchBlocks: blocks.filter((b) => b.kinds.includes('switchDispatch')).length,
    generatorDispatchBlocks: blocks.filter((b) => b.isGeneratorDispatch).length,
    generatorResumeEdges: edges.filter((e) => e.kind === 'switch' && e.generatorResume).length,
    rangesWithoutThrowingInstruction: rangeWithoutThrow.length,
    handlerNotInsideEnclosingRange,
    unreachableBlocks,
    exceptionPrecision: precision,
  };

  return {
    blocks, edges, handlers, entry: 0,
    blockByOffset, blockOfInstruction, handlerOfInstruction, canThrow,
    instructions, unit, profile, facts: F,
    warnings, stats,
    blockAt: (off) => {
      const id = blockByOffset.get(off);
      return id === undefined ? null : blocks[id];
    },
  };
}

export function resolveKind(b) {
  // 8.4 gives `kind` one slot but a block can be several of these at once: a
  // loop header that is also a catch handler is normal in a generator. `kinds`
  // carries all of them; `kind` is the first by this priority, which is the
  // order a consumer cares about.
  for (const k of ['handler', 'switchDispatch', 'loopHeader']) {
    if (b.kinds.includes(k)) { b.kind = k; return; }
  }
  b.kind = 'normal';
}

export function markReachable(blocks, entry) {
  const seen = new Uint8Array(blocks.length);
  if (!blocks.length) return seen;
  const stack = [entry];
  seen[entry] = 1;
  while (stack.length) {
    const b = blocks[stack.pop()];
    for (const s of b.succs) if (!seen[s]) { seen[s] = 1; stack.push(s); }
  }
  return seen;
}

function countBy(xs, f) {
  const m = {};
  for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; }
  return m;
}

export default { buildCFG, cfgFacts, lookupHandlerIndexForRange, EDGE_KINDS, BLOCK_KINDS };
