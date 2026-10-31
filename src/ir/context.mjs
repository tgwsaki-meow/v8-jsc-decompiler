// src/ir/context.mjs
//
// Context slots, as names instead of `ctx[d][i]`.
//
// An Lda/StaContextSlot names a slot by (context, index, depth):
//
//   LdaContextSlot        <context> <slot_index> <depth>
//   LdaCurrentContextSlot <slot_index>                     (depth 0, current)
//
// Depth counts PREVIOUS_INDEX hops up from the context the instruction starts
// at, which for the Current* forms is whatever the frame's context register
// holds at that point -- not the function's own scope. PushContext and
// PopContext move that register around, and SwitchOnGeneratorState replaces it
// with the resumed generator's own context, so resolving a name means knowing
// which context object the register holds at that instruction. That is what
// `contextChain()` computes.
//
// Two analyses, because the question has two forms:
//
//   * a VALUE lattice, for `LdaContextSlot <context> ...`, whose base is a
//     register holding a context. Each SSA value maps to a context frame, or
//     to "not statically one context".
//   * a per-INSTRUCTION frame, for the Current* forms, computed by a forward
//     dataflow over the CFG. A value lattice alone cannot answer this one,
//     because SwitchOnGeneratorState installs a context on its resume edges
//     and leaves it alone on its fall-through edge, so the one SSA value it
//     defines means different things on different edges.
//
// The chain has three kinds of link:
//
//   incoming    the context the function was entered with: unit.scope.outer
//   outerScope  one PREVIOUS_INDEX hop above it: .outer, .outer, ...
//   created     a context this function built: Create{Block,Catch,Function,
//               FunctionWithCells,Eval,With}Context, whose ScopeInfo is named
//               by a constant-pool operand and whose previous link is the
//               context current at the point of creation
//
// Resolving the slot index
// ------------------------
// ScopeInfo::ContextSlotIndex returns `ContextHeaderLength() + index`, and
//
//   int ScopeInfo::ContextHeaderLength() const {
//     return HasContextExtensionSlot() ? Context::MIN_CONTEXT_EXTENDED_SLOTS
//                                      : Context::MIN_CONTEXT_SLOTS;
//   }
//                                 -- src/objects/scope-info.h (14.4.258.16)
//
// so the local index is `slot - ContextHeaderLength(scope)` and the name is
// `scope.contextLocalNames[localIndex]`.
//
// ARCHITECTURE.md 8.1 says the subtrahend is `kVariablePartIndex`. That is
// wrong: kVariablePartIndex is an index into the ScopeInfo's own field list
// (`enum Fields { kFlags, kParameterCount, kContextLocalCount,
// kPositionInfoStart, kPositionInfoEnd, kVariablePartIndex }`, so it is 5),
// not into the Context. Using it would shift every name by three or two.
//
// Where MIN_CONTEXT_SLOTS comes from
// ----------------------------------
// It is read from the profile when the profile has it. Today it does not:
// profiles/*/layouts.json records `enums.ContextSlot.members` as
// `{ MIN_CONTEXT_SLOTS: 0 }`, because profilegen's Torque enum reader skips
// members with a `Slot<Context, T>` type and then numbers what is left from
// zero. That is a fifth silent profilegen gap on top of the four in
// ARCHITECTURE.md 9.6 and is reported, not patched around.
//
// The fall-back does not hardcode a number either: it counts the slots that
// every Context has, which src/objects/contexts.tq declares as the only two
// `Slot<Context, ...>` members of the ContextSlot enum before the
// NativeContext-only ones begin --
//
//   enum ContextSlot extends intptr constexpr 'Context::Field' {
//     SCOPE_INFO_INDEX: Slot<Context, ScopeInfo>,
//     PREVIOUS_INDEX: Slot<Context, Context|Zero|Undefined>,
//     AGGREGATE_ERROR_FUNCTION_INDEX: Slot<NativeContext, JSFunction>,
//     ...
//
// -- and adds one for the extension slot. The result is checked against the
// data on every function: a context slot operand must land inside
// [0, contextLocalCount) of the scope the chain says it belongs to, and
// tools/ir/corpus_scan.mjs reports the rate over the whole corpus. An
// off-by-one here would take that rate to roughly zero.

import { VAR_CONTEXT } from './vars.mjs';

const UNIVERSAL_CONTEXT_SLOTS = Object.freeze(['SCOPE_INFO_INDEX', 'PREVIOUS_INDEX']);

const TOP = -1;        // not statically one context
const BOTTOM = -2;     // nothing known yet

/**
 * Context::MIN_CONTEXT_SLOTS and MIN_CONTEXT_EXTENDED_SLOTS for a profile.
 * @returns {{min: number, extended: number, source: string, gap: string|null}}
 */
export function contextHeaderConstants(profile) {
  const members = profile.tables.layouts?.enums?.ContextSlot?.members ?? null;
  const min = members?.MIN_CONTEXT_SLOTS;
  const ext = members?.MIN_CONTEXT_EXTENDED_SLOTS;
  if (typeof min === 'number' && typeof ext === 'number' && min > 0 && ext === min + 1) {
    return { min, extended: ext, source: 'profile layouts.json enums.ContextSlot', gap: null };
  }
  return {
    min: UNIVERSAL_CONTEXT_SLOTS.length,
    extended: UNIVERSAL_CONTEXT_SLOTS.length + 1,
    source: `derived from the ${UNIVERSAL_CONTEXT_SLOTS.length} Slot<Context,...> members of `
      + `contexts.tq's ContextSlot enum (${UNIVERSAL_CONTEXT_SLOTS.join(', ')}) plus the extension slot`,
    gap: 'profiles/*/layouts.json enums.ContextSlot carries only {MIN_CONTEXT_SLOTS: 0}: profilegen\'s Torque '
      + 'enum reader drops members whose type is Slot<Context, T> and renumbers the rest from zero',
  };
}

/** ScopeInfo::ContextHeaderLength(). */
export function contextHeaderLength(scope, hc) {
  if (!scope) return hc.min;
  return scope.flags?.has_context_extension_slot ? hc.extended : hc.min;
}

const meet = (a, b) => (a === BOTTOM ? b : b === BOTTOM ? a : a === b ? a : TOP);

/**
 * @param {object} ir  {unit, profile, values, cfg, dom, instructionValue, vs, scopeInfoById}
 */
export function contextChain(ir) {
  const { unit, profile, values, cfg, dom, instructionValue, vs } = ir;
  const { blocks, edges, instructions } = cfg;
  const hc = contextHeaderConstants(profile);
  const scopeInfoById = ir.scopeInfoById ?? null;
  const notes = [];

  // ------------------------------------------------------------- frames
  const frames = [];
  const newFrame = (f) => { const id = frames.length; frames.push({ id, ...f }); return id; };

  // The context the frame is ENTERED with is the one the closure captured,
  // which is `unit.scope.outer`, not `unit.scope`:
  //
  //   Scope* Scope::GetOuterScopeWithContext() {
  //     Scope* s = outer_scope_;
  //     while (s != nullptr && !s->NeedsContext()) s = s->outer_scope_;
  //     return s;
  //   }                                            -- src/ast/scopes.cc
  //
  // and ScopeInfo::Create stores exactly that scope's ScopeInfo in
  // outer_scope_info. Scope::ContextChainLength counts only scopes that need a
  // context, so the depth operand walks this same chain, one link per
  // context-allocating scope.
  //
  // A function's OWN context, when it has one, is not the entry context: the
  // prologue builds it with CreateFunctionContext and installs it with
  // PushContext, and only from there is depth 0 the function's own scope. Two
  // measurements from a real listing of corpus/features/disasm/
  // closures_context.js settle it:
  //
  //   outer()  @0 CreateFunctionContext [0:ScopeInfo FUNCTION_SCOPE], [3]
  //            @3 PushContext r1
  //            @7 StaCurrentContextSlotNoCell [2]     <- first local at 2
  //   inner()  no CreateFunctionContext at all, and
  //            @43 LdaImmutableCurrentContextSlot [2] -> "f", the `let f` of
  //                 the enclosing block, i.e. depth 0 is already the OUTER
  //                 context
  //
  // Treating unit.scope as depth 0 would name every slot one scope too deep
  // for a function that allocates no context of its own -- and would read a
  // plausible wrong name rather than failing.
  const incoming = newFrame({
    kind: 'incoming', scope: unit.scope?.outer ?? null,
    scopeInfoId: unit.scope?.outer?.scopeInfoId ?? null,
    ownScopeInfoId: unit.scope?.scopeInfoId ?? null,
    outer: undefined, depthFromIncoming: 0,
    note: 'the context the closure captured: unit.scope.outer',
  });
  const linkOuter = (frameId) => {
    const f = frames[frameId];
    if (f.outer !== undefined) return f.outer;
    const parentScope = f.scope?.outer ?? null;
    if (f.kind === 'incoming' || f.kind === 'outerScope') {
      f.outer = parentScope
        ? newFrame({
          kind: 'outerScope', scope: parentScope, scopeInfoId: parentScope.scopeInfoId ?? null,
          outer: undefined, depthFromIncoming: f.depthFromIncoming + 1,
        })
        : null;
    } else {
      f.outer = null;
    }
    return f.outer;
  };

  // One frame per Create*Context instruction, created up front so the fixpoint
  // only has to resolve the previous link.
  const createdFrame = new Map();        // value id -> frame id
  for (const v of values) {
    if (v.kind !== 'Op') continue;
    const creator = v.sem?.contextCreator;
    if (!creator) continue;
    const ins = instructions[v.instruction];
    const operand = ins.operands[creator.scopeInfoOperand];
    const c = operand?.constant ?? null;
    const scopeInfoId = c && c.t === 'scopeInfo' ? c.scopeInfoId : null;
    // The function's own activation context names unit.scope's own ScopeInfo,
    // which 8.1 already hands over decoded; anything else (a block, catch or
    // with context) is only an id in the constant pool and needs the
    // scopeInfoById map tools/ir/units.mjs builds.
    let scope = null, source = null;
    if (scopeInfoId !== null) {
      if (unit.scope && unit.scope.scopeInfoId === scopeInfoId) { scope = unit.scope; source = 'unit.scope'; }
      else if (scopeInfoById && scopeInfoById.has(scopeInfoId)) { scope = scopeInfoById.get(scopeInfoId); source = 'scopeInfoById'; }
    }
    createdFrame.set(v.id, newFrame({
      kind: 'created', op: v.op, offset: ins.offset,
      scope, scopeInfoId, scopeSource: source, scopeInfoResolved: !!scope,
      outer: undefined, createdBy: v.id,
    }));
  }

  // ------------------------------------------- suspend / resume pairing
  //
  //   builder()->SuspendGenerator(generator_object(), registers, suspend_id);
  //   builder()->Bind(generator_jump_table_, suspend_id);
  //   builder()->ResumeGenerator(generator_object(), registers);
  //                      -- BytecodeGenerator::BuildSuspendPoint
  //
  // So the ResumeGenerator for suspend id j is the instruction immediately
  // after the SuspendGenerator carrying that id, with the same register list,
  // and the jump-table entry for case j targets it. Two things follow and both
  // are needed:
  //
  //   * the context the generator resumes with is the context that was current
  //     at that suspend, because SuspendGenerator spilled it there;
  //   * ResumeGenerator's register outputs hold the values SuspendGenerator's
  //     register inputs held, so a context parked in a register survives the
  //     round trip and can be followed through it.
  const suspendByIdIns = new Map();      // suspend id -> instruction index
  const resumeOfSuspendIns = new Map();  // suspend instruction index -> resume value id
  const suspendOfResume = new Map();     // resume value id -> suspend value id
  let unpairedResumes = 0;
  for (const v of values) {
    if (v.kind !== 'Op') continue;
    if (v.op === 'SuspendGenerator') {
      const ins = instructions[v.instruction];
      const idOperand = ins.operands.find((o) => o.type === 'kUImm');
      if (idOperand) suspendByIdIns.set(idOperand.value, v.instruction);
      const next = instructionValue[v.instruction + 1];
      if (next >= 0 && values[next]?.op === 'ResumeGenerator') {
        resumeOfSuspendIns.set(v.instruction, next);
        suspendOfResume.set(next, v.id);
      }
    }
  }
  for (const v of values) {
    if (v.kind === 'Op' && v.op === 'ResumeGenerator' && !suspendOfResume.has(v.id)) unpairedResumes++;
  }
  if (unpairedResumes) {
    notes.push(`${unpairedResumes} ResumeGenerator(s) are not immediately preceded by a SuspendGenerator, `
      + 'so their restored register values could not be paired');
  }

  // A switch edge out of a generator dispatcher carries the context of its
  // matching suspend rather than the dispatcher's own outgoing context.
  const resumeEdgeSuspendIns = new Map();   // edge id -> suspend instruction index
  for (const e of edges) {
    if (e.kind !== 'switch' || !e.generatorResume) continue;
    const si = suspendByIdIns.get(e.caseValue);
    if (si !== undefined) resumeEdgeSuspendIns.set(e.id, si);
  }

  // ------------------------------------------------------------ the fixpoint
  const ctxOf = new Int32Array(values.length).fill(BOTTOM);
  const insFrame = new Int32Array(instructions.length).fill(BOTTOM);
  const blockOut = new Int32Array(blocks.length).fill(BOTTOM);
  for (const v of values) {
    if (v.kind === 'FrameEntry' && v.reg?.k === 'context') ctxOf[v.id] = incoming;
  }

  /** The value a register input of a paired ResumeGenerator came from. */
  const throughResume = (proj) => {
    const resume = values[proj.of];
    const suspendId = suspendOfResume.get(resume.id);
    if (suspendId === undefined) return TOP;
    const suspend = values[suspendId];
    const want = vs.varOf(proj.reg);
    const k = suspend.inputVars.indexOf(want);
    return k < 0 ? TOP : ctxOf[suspend.inputs[k]];
  };

  let changed = true, rounds = 0;
  const MAX_ROUNDS = 64;
  while (changed && rounds < MAX_ROUNDS) {
    changed = false; rounds++;
    const set = (arr, i, val) => { if (arr[i] !== val) { arr[i] = val; changed = true; } };

    // ---- values
    for (let vid = 0; vid < values.length; vid++) {
      const v = values[vid];
      if (!v) continue;
      if (v.kind === 'Phi') {
        let acc = BOTTOM;
        for (const o of v.operands) acc = meet(acc, o === null ? TOP : ctxOf[o]);
        set(ctxOf, v.id, acc);
      } else if (v.kind === 'Proj') {
        const of = values[v.of];
        if (!of) continue;
        if (of.op === 'PushContext') {
          // the register operand receives the OUTGOING context
          set(ctxOf, v.id, of.contextIn === null || of.contextIn === undefined ? TOP : ctxOf[of.contextIn]);
        } else if (of.op === 'ResumeGenerator') {
          set(ctxOf, v.id, throughResume(v));
        }
      } else if (v.kind === 'Op') {
        const f = createdFrame.get(v.id);
        if (f !== undefined) {
          const outer = insFrame[v.instruction];
          const want = outer < 0 ? null : outer;
          if (frames[f].outer === undefined || frames[f].outer !== want) {
            frames[f].outer = want;
            frames[f].outerUnknown = outer === TOP;
            changed = true;
          }
          set(ctxOf, v.id, f);
        } else if (v.op === 'PushContext') {
          // SetContext(accumulator); the accumulator is the first read, since
          // instructionVars() records the implicit accumulator read before any
          // operand and PushContext's own kRegOut operand is a write.
          const k = v.inputVars.indexOf(0);
          set(ctxOf, v.id, k >= 0 ? ctxOf[v.inputs[k]] : TOP);
        } else if (v.op === 'PopContext' || v.op === 'Ldar' || v.op === 'Star' || v.op === 'Mov') {
          set(ctxOf, v.id, v.inputs.length ? ctxOf[v.inputs[0]] : TOP);
        } else if (v.op === 'SwitchOnGeneratorState') {
          // One SSA value, two meanings: unchanged on the fall-through edge
          // (the generator register is undefined on the first call, so the
          // handler falls through before touching the context) and the
          // generator's own context on a resume edge. The value is therefore
          // the meet of the incoming context and every matching suspend's
          // context -- and that is also what breaks the circularity, because
          // the incoming context is known from the start.
          let acc = v.contextIn === null || v.contextIn === undefined ? TOP : ctxOf[v.contextIn];
          for (const si of suspendByIdIns.values()) acc = meet(acc, insFrame[si]);
          set(ctxOf, v.id, acc);
        } else if (v.var === VAR_CONTEXT) {
          set(ctxOf, v.id, TOP);
        }
      }
    }

    // ---- per-instruction frames, forward over the CFG in reverse postorder
    for (const bid of dom.rpo) {
      const b = blocks[bid];
      let f;
      if (bid === cfg.entry) f = incoming;
      else {
        f = BOTTOM;
        for (const eid of b.inEdges) {
          const e = edges[eid];
          if (!dom.reachable(e.from)) continue;
          const si = resumeEdgeSuspendIns.get(eid);
          f = meet(f, si !== undefined ? insFrame[si] : blockOut[e.from]);
        }
      }
      for (let i = b.first; i <= b.last; i++) {
        set(insFrame, i, f);
        const vid = instructionValue[i];
        const v = vid >= 0 ? values[vid] : null;
        if (!v) continue;
        if (v.op === 'PushContext') {
          const k = v.inputVars.indexOf(0);
          f = k >= 0 ? ctxOf[v.inputs[k]] : TOP;
        } else if (v.op === 'PopContext') {
          f = v.inputs.length ? ctxOf[v.inputs[0]] : TOP;
        }
        // SwitchOnGeneratorState deliberately leaves `f` alone: the resume
        // edges carry their suspend's frame and are handled above, and the
        // fall-through path does not change the context.
      }
      set(blockOut, bid, f);
    }
  }
  if (rounds >= MAX_ROUNDS) notes.push(`the context fixpoint hit its ${MAX_ROUNDS}-round cap`);

  // ------------------------------------------------------- slot resolution
  /**
   * @param {number} insIndex    the instruction asking
   * @param {number|null} baseValue  the SSA value of the <context> operand, or
   *                                 null for the Current* forms
   */
  const resolve = (insIndex, baseValue, depth, slot) => {
    const start = baseValue === null || baseValue === undefined ? insFrame[insIndex] : ctxOf[baseValue];
    if (start < 0) {
      return {
        resolved: false, chain: [],
        why: start === BOTTOM ? 'contextValueNotReached' : 'contextValueNotStaticallyKnown',
      };
    }
    let f = start;
    const chain = [f];
    for (let d = 0; d < depth; d++) {
      const next = linkOuter(f);
      if (next === null || next === undefined) {
        return { resolved: false, why: 'contextChainShorterThanDepth', chain, atDepth: d };
      }
      f = next; chain.push(f);
    }
    const frame = frames[f];
    const scope = frame.scope;
    if (!scope) {
      return {
        resolved: false, chain, frame: f,
        why: frame.kind === 'created' && !frame.scopeInfoResolved
          ? 'createdContextScopeInfoNotDecoded' : 'frameHasNoScopeInfo',
        scopeInfoId: frame.scopeInfoId,
      };
    }
    const header = contextHeaderLength(scope, hc);
    const local = slot - header;
    const n = scope.contextLocalCount ?? scope.contextLocalNames?.length ?? 0;
    if (local < 0 || local >= n) {
      return { resolved: false, chain, frame: f, why: 'slotOutsideContextLocals', localIndex: local, contextLocalCount: n, header };
    }
    const name = scope.contextLocalNames?.[local] ?? null;
    const info = scope.contextLocalInfos?.[local] ?? null;
    if (name === null) return { resolved: false, chain, frame: f, why: 'contextLocalNameMissing', localIndex: local, header };
    return {
      resolved: true, chain, frame: f, localIndex: local, header, name,
      mode: info?.mode ?? null, maybeAssigned: info?.maybeAssigned ?? null,
      scopeType: scope.scopeType ?? null, scopeInfoId: frame.scopeInfoId,
    };
  };

  return {
    frames, ctxOf, insFrame, blockOut, resolve,
    headerConstants: hc, rounds, notes,
    suspendByIdIns, suspendOfResume, unpairedResumes,
    TOP, BOTTOM,
  };
}

export default { contextChain, contextHeaderConstants, contextHeaderLength };
