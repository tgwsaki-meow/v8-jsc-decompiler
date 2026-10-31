// src/ir/ssa.mjs
//
// SSA construction: phi placement by Cytron's dominance-frontier algorithm,
// then renaming over the dominator tree.
//
//   Ron Cytron, Jeanne Ferrante, Barry K. Rosen, Mark N. Wegman and
//   F. Kenneth Zadeck, "Efficiently computing static single assignment form
//   and the control dependence graph", ACM TOPLAS 13(4), 1991. Phi placement
//   is figure 11 (the iterated dominance frontier of the assignment set);
//   renaming is figure 12 (a stack per variable, walked over the dominator
//   tree).
//
// PRUNED, not minimal. A phi is placed only where the variable is also live-in
// (Choi, Cytron and Ferrante, "Automatic construction of sparse data flow
// evaluation graphs", POPL 1991). That matters here rather than being a
// refinement: the variable set is the whole register file, functions in the
// corpus reach 320 simultaneously live registers, and unpruned SSA would put a
// phi for every register at every join. Pruned SSA is still SSA -- every use
// has exactly one reaching definition -- it just has no dead phis.
//
// The three things ARCHITECTURE.md 4.2 calls out:
//
//  * The accumulator at a handler entry is the caught exception. The
//    interpreter writes the pending exception into the accumulator before
//    dispatching to the handler offset, so the incoming accumulator is dead
//    there. It is modelled as its own CaughtException definition and NOT as a
//    phi over the predecessors. (If the accumulator were ever live-in at a
//    handler the model would be wrong; the count is reported as
//    `accumulatorLiveInAtHandler` and is expected to be 0.)
//
//  * A handler's register state is a merge over the protected range. It comes
//    out of the ordinary phi machinery because the exception edges built by
//    src/ir/cfg.mjs are real CFG edges: the handler block's predecessors are
//    every throwing site in its range. 4.2 proposes a coarser version -- one
//    phi over whole range blocks -- and justifies it with "V8 spills anything
//    live across a try before entering it". That justification does not hold
//    and the coarse model is wrong in both directions; see docs/IR.md.
//
//  * SwitchOnGeneratorState resume points are ordinary joins. They are: the
//    dispatcher's jump-table edge is a normal CFG edge, so a resume block gets
//    phis exactly when a variable is live there and reaches it from more than
//    one place. 10 068 of the corpus's 11 208 jump tables are these, so the
//    common path is this one, not `switch`.

import { varSpace, instructionVars, VAR_ACCUMULATOR, VAR_CONTEXT } from './vars.mjs';

const W = 32;

function bitsetFor(count) { return new Uint32Array(Math.ceil(count / W) || 1); }
const bsGet = (a, i) => (a[(i / W) | 0] >>> (i % W)) & 1;
const bsSet = (a, i) => { a[(i / W) | 0] |= 1 << (i % W); };
const bsClear = (a, i) => { a[(i / W) | 0] &= ~(1 << (i % W)); };

/**
 * @param {object} ctx {cfg, dom, unit, profile, sem}
 * @param {object} opts {scopeInfoById?}
 */
/**
 * @param {{cfg, dom, unit, profile, sem, trace?: (msg: string) => void}} ctx
 *   `trace` is an optional phase-boundary hook. It exists because a diverging
 *   fixpoint in here presents as a hang on one function out of thousands, and
 *   bisecting that without a phase marker means guessing. Four calls, no cost.
 */
export function buildSSA(ctx) {
  const TRACE = ctx.trace ?? (() => {});
  const { cfg, dom, unit, profile, sem } = ctx;
  const { blocks, edges, instructions, handlers } = cfg;
  const vs = varSpace(unit, instructions);
  const nVars = vs.count;
  const nBlocks = blocks.length;
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, ...detail });

  // ------------------------------------------------------------- values
  /** @type {Array<object>} indexed by ssa id */
  const values = [];
  const mk = (v) => { const id = values.length; values.push({ id, ...v }); return values[id]; };

  // entry definitions, one per variable. V8 fills the register file and the
  // accumulator with `undefined` in InterpreterEntryTrampoline before the
  // first bytecode executes, so every register is defined on entry; the
  // parameters and the incoming context carry real values.
  const incomingReg = unit.incomingNewTargetOrGeneratorRegister ?? null;
  const entryDef = new Int32Array(nVars).fill(-1);
  for (let v = 0; v < nVars; v++) {
    const reg = vs.regOf(v);
    if (v === VAR_ACCUMULATOR) {
      entryDef[v] = mk({ kind: 'FrameEntry', reg, var: v, what: 'accumulatorUndefinedOnEntry' }).id;
    } else if (v === VAR_CONTEXT) {
      entryDef[v] = mk({ kind: 'FrameEntry', reg, var: v, what: 'incomingContext' }).id;
    } else if (vs.isParam(v)) {
      entryDef[v] = mk({
        kind: 'Param', reg, var: v, index: reg.i,
        isReceiver: reg.i === 0, name: reg.i === 0 ? 'this' : null,
      }).id;
    } else {
      const isIncoming = incomingReg !== null && incomingReg >= 0 && reg.i === incomingReg;
      entryDef[v] = mk({
        kind: 'FrameEntry', reg, var: v,
        what: isIncoming
          // docs/DISASM.md section 9: this is a register-file slot like any
          // other, filled by the prologue, not a register kind of its own.
          ? (unit.isGenerator || unit.isAsync ? 'incomingGeneratorObject' : 'incomingNewTarget')
          : 'registerFileUndefinedOnEntry',
        incomingNewTargetOrGenerator: isIncoming,
      }).id;
    }
  }
  // read-only frame-header registers: one value each, created on demand
  const frameHeaderValue = new Map();
  const headerValueFor = (reg) => {
    const key = reg.k + ':' + (reg.i ?? '');
    let v = frameHeaderValue.get(key);
    if (v === undefined) {
      v = mk({ kind: 'FrameEntry', reg, var: -1, what: 'frameHeaderRegister', readOnly: true }).id;
      frameHeaderValue.set(key, v);
    }
    return v;
  };

  // ------------------------------------------------- gen / kill / liveness
  TRACE(`entry values done, nVars=${nVars}, nBlocks=${nBlocks}, instructions=${instructions.length}`);
  const gen = [], kill = [], liveIn = [], liveOut = [];
  const insVars = new Array(instructions.length);
  const handlerEntryBlocks = new Set();
  for (const b of blocks) if (b.isHandlerEntryFor.length) handlerEntryBlocks.add(b.id);

  for (const b of blocks) {
    const g = bitsetFor(nVars), k = bitsetFor(nVars);
    if (handlerEntryBlocks.has(b.id)) bsSet(k, VAR_ACCUMULATOR);   // CaughtException
    for (let i = b.first; i <= b.last; i++) {
      const iv = instructionVars(instructions[i], sem, vs);
      insVars[i] = iv;
      for (const v of iv.reads) if (v >= 0 && !bsGet(k, v)) bsSet(g, v);
      for (const v of iv.writes) if (v >= 0) bsSet(k, v);
    }
    gen[b.id] = g; kill[b.id] = k;
    liveIn[b.id] = bitsetFor(nVars); liveOut[b.id] = bitsetFor(nVars);
  }

  // Backward fixpoint over reachable blocks, in reverse rpo.
  //
  //   liveOut(b) = union over successors s of liveIn(s)
  //   liveIn(b)  = gen(b) union (liveOut(b) minus kill(b))
  //
  // Exception edges are ordinary successors here, which is what makes the
  // handler's live-in propagate back into every throwing site of its range.
  //
  // Every merged word is forced back to unsigned with `>>> 0`. JS bitwise
  // operators produce a SIGNED int32, and a Uint32Array element reads back
  // unsigned, so for any variable set that uses bit 31 of a word the
  // comparison `merged !== set[w]` would be true forever and the fixpoint
  // would never terminate. It bites at 32 variables, which is one small
  // function with a dozen registers.
  const rpo = dom.rpo;
  const words = liveIn[0] ? liveIn[0].length : 1;
  let changed = true, livenessRounds = 0;
  while (changed) {
    changed = false; livenessRounds++;
    for (let x = rpo.length - 1; x >= 0; x--) {
      const id = rpo[x];
      const b = blocks[id];
      const out = liveOut[id];
      let dirty = false;
      for (const s of b.succs) {
        if (!dom.reachable(s)) continue;
        const si = liveIn[s];
        for (let w = 0; w < words; w++) {
          const merged = (out[w] | si[w]) >>> 0;
          if (merged !== out[w]) { out[w] = merged; dirty = true; }
        }
      }
      const inn = liveIn[id], g = gen[id], kl = kill[id];
      for (let w = 0; w < words; w++) {
        const merged = (g[w] | (out[w] & ~kl[w])) >>> 0;
        if (merged !== inn[w]) { inn[w] = merged; dirty = true; }
      }
      if (dirty) changed = true;
    }
  }

  let accumulatorLiveInAtHandler = 0;
  for (const id of handlerEntryBlocks) if (bsGet(liveIn[id], VAR_ACCUMULATOR)) accumulatorLiveInAtHandler++;

  let liveAtEntry = 0;
  for (let v = 0; v < nVars; v++) if (bsGet(liveIn[0], v)) liveAtEntry++;
  TRACE('liveness done, rounds=' + livenessRounds);

  // ----------------------------------------------------- phi placement
  // Cytron figure 11, restricted to variables live-in at the candidate block.
  const defBlocks = Array.from({ length: nVars }, () => []);
  for (const id of rpo) {
    const k = kill[id];
    for (let v = 0; v < nVars; v++) if (bsGet(k, v)) defBlocks[v].push(id);
  }
  const phisOf = Array.from({ length: nBlocks }, () => []);
  const hasPhi = Array.from({ length: nBlocks }, () => bitsetFor(nVars));
  const onWork = new Int32Array(nBlocks).fill(-1);
  for (let v = 0; v < nVars; v++) {
    const work = [...defBlocks[v]];
    if (dom.reachable(0)) work.push(0);                   // the entry definition
    for (const b of work) onWork[b] = v;
    while (work.length) {
      const x = work.pop();
      for (const y of dom.domFrontier[x] ?? []) {
        if (bsGet(hasPhi[y], v)) continue;
        if (!bsGet(liveIn[y], v)) continue;               // pruned
        if (y === 0) continue;                            // the entry has no preds
        bsSet(hasPhi[y], v);
        phisOf[y].push(v);
        if (onWork[y] !== v) { onWork[y] = v; work.push(y); }
      }
    }
  }
  for (const b of blocks) phisOf[b.id].sort((a, c) => a - c);

  TRACE('phi placement done');
  // position of each edge in its target's predecessor list
  const predIndexOfEdge = new Int32Array(edges.length).fill(-1);
  for (const b of blocks) b.inEdges.forEach((eid, i) => { predIndexOfEdge[eid] = i; });

  // phi value objects
  const phiValues = Array.from({ length: nBlocks }, () => []);
  for (const b of blocks) {
    if (!dom.reachable(b.id)) continue;
    for (const v of phisOf[b.id]) {
      const p = mk({
        kind: 'Phi', var: v, block: b.id, varName: vs.name(v),
        reg: vs.regOf(v), operands: new Array(b.preds.length).fill(null),
      });
      phiValues[b.id].push(p);
    }
  }

  // ------------------------------------------------------------ renaming
  // Cytron figure 12, iteratively so a deep dominator tree cannot overflow.
  const stacks = Array.from({ length: nVars }, () => []);
  for (let v = 0; v < nVars; v++) stacks[v].push(entryDef[v]);

  const caughtException = new Map();          // block id -> value id
  const defUse = new Map();                   // ssa id -> [user ssa id]
  const addUse = (defId, userId) => {
    if (defId === null || defId === undefined || defId < 0) return;
    const l = defUse.get(defId);
    if (l) l.push(userId); else defUse.set(defId, [userId]);
  };
  const instructionValue = new Int32Array(instructions.length).fill(-1);
  const blockEntryVersion = Array.from({ length: nBlocks }, () => null);
  const blockExitVersion = Array.from({ length: nBlocks }, () => null);
  let clobberedUses = 0;

  const top = (v) => {
    const s = stacks[v];
    return s.length ? s[s.length - 1] : -1;
  };

  TRACE('renaming start');
  const trail = [];
  const frame = [{ block: 0, child: 0, mark: 0 }];
  if (!dom.reachable(0)) frame.length = 0;
  while (frame.length) {
    const f = frame[frame.length - 1];
    const b = blocks[f.block];
    if (f.child === 0) {
      f.mark = trail.length;
      // 1. phis define their variables
      for (const p of phiValues[b.id]) { stacks[p.var].push(p.id); trail.push(p.var); }
      // 2. a handler entry defines the accumulator as the caught exception
      if (handlerEntryBlocks.has(b.id)) {
        const ce = mk({
          kind: 'CaughtException', var: VAR_ACCUMULATOR, block: b.id,
          handlers: b.isHandlerEntryFor.slice(),
          predictions: b.isHandlerEntryFor.map((hi) => handlers[hi]?.predictionName ?? handlers[hi]?.prediction ?? null),
        });
        caughtException.set(b.id, ce.id);
        stacks[VAR_ACCUMULATOR].push(ce.id); trail.push(VAR_ACCUMULATOR);
        if (phiValues[b.id].some((p) => p.var === VAR_ACCUMULATOR)) {
          warn('accumulatorPhiAtHandlerEntry', {
            block: b.id,
            message: 'the accumulator was live-in at a handler, so something reads the pre-throw accumulator; '
              + 'the caught-exception model assumes it is dead there',
          });
        }
      }
      blockEntryVersion[b.id] = snapshot(stacks, nVars);

      // 3. the instructions
      for (let i = b.first; i <= b.last; i++) {
        const ins = instructions[i];
        const iv = insVars[i];
        const s = iv.sem;

        const inputs = [];
        const inputVars = [];
        for (let r = 0; r < iv.reads.length; r++) {
          const v = iv.reads[r];
          let id;
          if (v >= 0) {
            id = top(v);
            const d = values[id];
            if (d && d.clobbered) clobberedUses++;
          } else {
            id = headerValueFor(iv.readRegs[r]);
          }
          inputs.push(id); inputVars.push(v);
        }
        const contextIn = top(VAR_CONTEXT);

        const op = mk({
          kind: 'Op', op: ins.opcode, instruction: i, offset: ins.offset,
          block: b.id, sem: s,
          hasEffect: s.hasEffect,
          allocatesIdentity: s.allocatesIdentity,
          allocationKind: s.allocationKind,
          effect: s.effect,
          inEffectChain: s.inEffectChain,
          inputs, inputVars, contextIn,
          var: -1, defs: [], projections: [],
          clobbered: false,
          sourcePosition: ins.sourcePosition, isStatement: ins.isStatement,
        });
        instructionValue[i] = op.id;
        for (const inId of inputs) addUse(inId, op.id);
        // `contextIn` is an annotation, not a use: it records which context
        // object was installed at this point so src/ir/context.mjs can resolve
        // a (depth, index) pair. The ops that genuinely consume the context
        // value are in `inputs` already, through IMPLICIT_CONTEXT_READ.

        // which written variable the Op value itself defines, and which become
        // projections. Preference: a real accumulator write, then the context
        // (so PushContext/PopContext/SwitchOnGeneratorState's Op value IS the
        // new context), then the first register output, then a clobbered
        // accumulator.
        const written = [];
        const seenVar = new Set();
        for (let w = 0; w < iv.writes.length; w++) {
          const v = iv.writes[w];
          const reg = iv.writeRegs[w];
          const key = v >= 0 ? `v${v}` : `x${reg.k}${reg.i ?? ''}`;
          if (seenVar.has(key)) continue;
          seenVar.add(key);
          written.push({ v, reg });
        }
        let primary = -1;
        const accWrite = written.findIndex((x) => x.v === VAR_ACCUMULATOR);
        const ctxWrite = written.findIndex((x) => x.v === VAR_CONTEXT);
        if (accWrite >= 0 && !s.accumulator.clobber) primary = accWrite;
        else if (ctxWrite >= 0 && s.implicitContextWrite) primary = ctxWrite;
        else {
          const reg = written.findIndex((x) => x.v !== VAR_ACCUMULATOR);
          primary = reg >= 0 ? reg : accWrite;
        }
        written.forEach((x, idx) => {
          if (x.v < 0) return;                 // a write to a read-only header register: impossible
          let defId;
          if (idx === primary) {
            op.var = x.v; op.reg = x.reg;
            op.clobbered = x.v === VAR_ACCUMULATOR && s.accumulator.clobber;
            defId = op.id;
          } else {
            const pr = mk({
              kind: 'Proj', of: op.id, slot: idx, var: x.v, reg: x.reg,
              op: ins.opcode, instruction: i, offset: ins.offset, block: b.id,
              clobbered: x.v === VAR_ACCUMULATOR && s.accumulator.clobber,
            });
            op.projections.push(pr.id);
            addUse(op.id, pr.id);
            defId = pr.id;
          }
          op.defs.push({ var: x.v, value: defId, reg: x.reg });
          stacks[x.v].push(defId); trail.push(x.v);
        });
      }
      blockExitVersion[b.id] = snapshot(stacks, nVars);

      // 4. fill the successors' phi operands, per EDGE so that two edges to
      //    the same block get two operands
      for (const eid of b.outEdges) {
        const e = edges[eid];
        if (!dom.reachable(e.to)) continue;
        const j = predIndexOfEdge[eid];
        for (const p of phiValues[e.to]) {
          const id = top(p.var);
          p.operands[j] = id;
          addUse(id, p.id);
        }
      }
    }
    const kids = dom.children[b.id] ?? [];
    if (f.child < kids.length) {
      const c = kids[f.child++];
      frame.push({ block: c, child: 0, mark: 0 });
    } else {
      while (trail.length > f.mark) stacks[trail.pop()].pop();
      frame.pop();
    }
  }

  // phi operands for unreachable predecessors stay null
  let unreachablePredOperands = 0;
  for (const b of blocks) {
    for (const p of phiValues[b.id]) {
      p.operands.forEach((o, i) => {
        if (o === null) {
          unreachablePredOperands++;
          if (dom.reachable(b.preds[i])) {
            warn('phiOperandMissing', { block: b.id, phi: p.id, predIndex: i, pred: b.preds[i] });
          }
        }
      });
    }
  }

  const phis = [];
  for (const b of blocks) for (const p of phiValues[b.id]) phis.push(p.id);

  return {
    vs, values, phis, phiValues, defUse, instructionValue, insVars,
    entryDef, caughtException, blockEntryVersion, blockExitVersion,
    liveIn, liveOut, gen, kill, predIndexOfEdge,
    bsGet: (set, i) => bsGet(set, i),
    warnings,
    stats: {
      variables: nVars,
      values: values.length,
      phis: phis.length,
      maxPhiArity: phis.length ? Math.max(...phis.map((p) => values[p].operands.length)) : 0,
      phiOperands: phis.reduce((a, p) => a + values[p].operands.length, 0),
      livenessRounds,
      liveAtEntry,
      accumulatorLiveInAtHandler,
      caughtExceptionDefs: caughtException.size,
      clobberedUses,
      unreachablePredOperands,
      projections: values.filter((v) => v.kind === 'Proj').length,
      derivedVarBounds: vs.derived,
    },
  };
}

function snapshot(stacks, n) {
  const a = new Int32Array(n);
  for (let v = 0; v < n; v++) { const s = stacks[v]; a[v] = s.length ? s[s.length - 1] : -1; }
  return a;
}

export default { buildSSA };
export { VAR_ACCUMULATOR, VAR_CONTEXT };
