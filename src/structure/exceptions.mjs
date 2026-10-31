// src/structure/exceptions.mjs
//
// Handler ranges -> `try` regions, and the `await` desugaring -> nothing.
//
// The hard constraint first (ARCHITECTURE.md 9.1 / 11.2 constraint 3). Over
// the whole corpus, 25 189 handler ranges split by catch prediction as:
//
//   ASYNC_AWAIT            13 713  (54.4%)   the `await` desugaring
//   CAUGHT                  5 821  (23.1%)   a real `catch`
//   UNCAUGHT                5 655  (22.5%)   `finally` only
//
// So **two thirds of all handler ranges do not correspond to any source-level
// `try`**. Emitting a `try` for each range would invent 13 713 of them. The
// ASYNC_AWAIT / UNCAUGHT_ASYNC_AWAIT ranges go into
// `removed.asyncHandlerRanges` for T7's `await` pattern, and so do the blocks
// that only their handler can reach -- the implicit promise rejection tail
// (`SetPendingMessage` + `%_AsyncFunctionReject` + `Return`), which the
// `async` keyword itself implies and which no source statement corresponds
// to. Those blocks have no normal predecessor, so if they were neither placed
// nor removed they would simply vanish from the coverage invariant; removing
// them explicitly is what makes 11.3 invariant 1 checkable.
//
// The region arithmetic
// ---------------------
// Ranges are half-open and well nested (docs/IR.md section 5), and V8 keeps a
// nested range's handler block inside the enclosing range -- measured, 0 of
// 25 189 violate it. So for a range h:
//
//   tryBlocks     = { b : h.rangeStart <= b.startOffset < h.rangeEnd }
//                   (a nested range's blocks AND its handler are inside this
//                   set, so a nested `try` falls out as a sub-region)
//   handlerBlocks = reach(handlerBlock, stopping at tryBlocks)
//                   minus everything the entry can reach without the handler
//                   (that subtraction is what excludes the join after the
//                   `try`, which is reachable from the body as well)
//   exits         = successors of tryBlocks u handlerBlocks that are in
//                   neither
//
// A handler block has no normal predecessor at all, which is why the handler
// region cannot be found by walking from the entry and why graph.mjs adds one
// synthetic *dominance* edge rangeEntry -> handlerBlock.
//
// `finally`
// ---------
// ARCHITECTURE.md 4.4.5 says `finally` is "a token register plus a trailing
// `SwitchOnSmiNoFeedback` dispatch". That is only half true, and the half it
// misses is the common one:
//
//     if (deferred_.size() == 1) {
//       builder()->LoadLiteral(Smi::FromInt(entry.token))
//                 .CompareReference(token_register_)
//                 .JumpIfFalse(ToBooleanMode::kAlreadyBoolean, &fall_through);
//     } else {
//       BytecodeJumpTable* jump_table = builder()->AllocateJumpTable(deferred_.size(), 0);
//       builder()->LoadAccumulatorWithRegister(token_register_)
//                 .SwitchOnSmiNoFeedback(jump_table).Jump(&fall_through);
//     }
//               -- BytecodeGenerator::ControlScope::DeferredCommands::ApplyDeferredCommands
//
// With exactly one deferred command -- a single `return` inside the `try`,
// which is the ordinary case -- there is no jump table at all, only
// `TestReferenceEqual` on the token register. Both forms are recognised here.
//
// What is done with the recognition is deliberately conservative: the range is
// still emitted as a `try` whose handler is the token-setting region, which is
// literally what the bytecode does and is correct JavaScript, and the
// recognised shape travels along as `finallyShape` so T9 can render a real
// `finally`. Emitting `finalizer` directly would mean dropping the token
// stores, and those live *inside* blocks that also carry the `return` value
// computation -- a `{r:'block'}` leaf cannot be split. See docs/STRUCTURE.md
// "Known gaps".

/** Catch predictions that are desugaring, not a source `try`. */
const ASYNC_PREDICTIONS = Object.freeze(['ASYNC_AWAIT', 'UNCAUGHT_ASYNC_AWAIT']);
/** The prediction a `finally`-only range carries. */
const FINALLY_PREDICTION = 'UNCAUGHT';

/**
 * Split the handler table by prediction. Nothing graph-shaped here, so it runs
 * before the structuring graph is built.
 */
export function classifyHandlers(ir) {
  const profilePredictions = ir.profile?.constants?.handlerTable?.catchPrediction ?? null;
  const warnings = [];
  if (profilePredictions) {
    for (const p of [...ASYNC_PREDICTIONS, FINALLY_PREDICTION, 'CAUGHT']) {
      if (!(p in profilePredictions)) {
        throw new Error(`profile ${ir.profile.version}: constants.handlerTable.catchPrediction has no '${p}', `
          + 'so src/structure cannot tell an await desugaring from a real catch');
      }
    }
  }
  const byIndex = [];
  const tryRanges = [];
  const asyncRanges = [];
  const byPrediction = {};
  for (const h of ir.handlers) {
    const name = h.predictionName ?? String(h.prediction);
    byPrediction[name] = (byPrediction[name] ?? 0) + 1;
    const isAsync = ASYNC_PREDICTIONS.includes(name);
    const rec = {
      index: h.index, handler: h, prediction: name, isAsync,
      isFinallyOnly: name === FINALLY_PREDICTION,
      empty: h.rangeEnd <= h.rangeStart,
      handlerBlock: ir.cfg.blockByOffset.get(h.handlerOffset) ?? null,
      entryBlock: ir.cfg.blockByOffset.get(h.rangeStart) ?? null,
    };
    if (rec.handlerBlock === null) {
      warnings.push({ code: 'handlerOffsetNotABlock', handler: h.index, offset: h.handlerOffset });
    }
    byIndex.push(rec);
    (isAsync ? asyncRanges : tryRanges).push(rec);
  }
  return { byIndex, tryRanges, asyncRanges, byPrediction, warnings };
}

/**
 * Which blocks only an async-desugaring handler can reach. Those are removed:
 * no statement of the source corresponds to them.
 *
 * @param {object} g0  a structuring graph built with the dispatcher plan only
 */
export function asyncDesugaringBlocks(ir, g0, classification) {
  const removed = new Set();
  const detail = [];
  if (!classification.asyncRanges.length) return { removed, detail };
  const fromEntry = g0.reach([g0.entry]);

  // A handler block of a *non*-async range, and anything only it can reach,
  // must not be swept up: it belongs to that range's `try`.
  const protectedRoots = classification.tryRanges
    .map((r) => r.handlerBlock).filter((b) => b !== null && !g0.removedBlocks.has(b));

  for (const r of classification.asyncRanges) {
    if (r.handlerBlock === null || g0.removedBlocks.has(r.handlerBlock)) continue;
    if (fromEntry.has(r.handlerBlock)) {
      // reachable by ordinary control flow as well, so it is not pure
      // desugaring; leave it to be placed and report it
      detail.push({ handler: r.index, block: r.handlerBlock, kept: true, why: 'handlerBlockReachableFromEntry' });
      continue;
    }
    const owned = g0.reach([r.handlerBlock]);
    const mine = [];
    for (const b of owned) {
      if (fromEntry.has(b)) continue;
      if (protectedRoots.includes(b)) continue;
      mine.push(b);
    }
    for (const b of mine) removed.add(b);
    detail.push({ handler: r.index, block: r.handlerBlock, blocks: mine.length, kept: false });
  }

  // Anything reachable only from a non-async handler must stay placeable.
  for (const b of protectedRoots) removed.delete(b);
  return { removed, detail };
}

/**
 * The end of the innermost range that contains this range's *handler*.
 *
 * Handler ranges are well nested and V8 keeps a nested range's handler block
 * inside the enclosing range (docs/IR.md section 5, measured: 0 of 25 189
 * violate it). So the handler body of a nested range is bounded above by the
 * end of the range it sits in, and that bound is what stops a handler region
 * from swallowing the code that follows the whole construct.
 *
 * Needed because the "reachable from the handler but not from the body"
 * subtraction alone is not enough when the body cannot fall through at all.
 * From a real listing of four nested `try`s whose innermost body is
 * `throw new Error()`:
 *
 *   h3 = [16,31) -> handler @31,  h2 = [13,76) -> handler @76
 *   B4 B5 B6(Throw)  |  B7..B12 = the h3 catch body, B12 jumps to B14 @82
 *
 * Nothing at all is reachable from {B4,B5,B6} -- B6 throws -- so the
 * subtraction removes nothing and the h3 handler region came out as B7..B26,
 * i.e. the rest of the function, which is what `try-nested` measured. B14 is
 * at 82, past the end of the enclosing range at 76, so the bound excludes it
 * and the region is B7..B12.
 *
 * @returns {number} an exclusive bytecode offset bound, or Infinity
 */
function enclosingRangeEnd(ir, r) {
  let bound = Infinity;
  for (const h of ir.handlers) {
    if (h.index === r.index) continue;
    if (h.rangeStart <= r.handler.handlerOffset && r.handler.handlerOffset < h.rangeEnd) {
      if (h.rangeEnd < bound) bound = h.rangeEnd;
    }
  }
  return bound;
}

/**
 * Is this block free of anything that could raise? "No exception edge" is not
 * enough on its own: a block outside every protected range has no exception
 * edge whatever it contains.
 */
function cannotThrow(ir, facts, g, blockId) {
  const b = ir.blocks[blockId];
  for (const eid of b.outEdges) if (ir.edges[eid].kind === 'exception') return false;
  for (const ins of b.instructions) if (facts.canThrow(ins.opcode)) return false;
  return true;
}

/**
 * The *normal-completion tail* of a range: the blocks between the end of the
 * range and its handler that only the range's own blocks can reach.
 *
 * V8 ends a protected range before the code that runs when the body completes
 * normally, so for `for (const x of xs) {}` the range covers the loop and the
 * iterator-close-on-normal-exit sits just after it:
 *
 *   range [20,70) -> handler @76
 *   B5 JumpIfToBooleanTrue -> B10          (the loop's `done` exit)
 *   B10 @70..76  (4 instructions, no exception edge) -> B12
 *   B11 @76..82  the handler                          -> B12
 *
 * B10 belongs to the `try` block lexically -- it runs on the normal path and
 * not after the handler -- but it is outside the range, so with the range as
 * the region bound the body chain walked straight out of its own region, which
 * is what `loop-for-of` measured. Taking the tail in makes B12 the single
 * exit, i.e. the join after the construct, which is what the follow must be.
 *
 * Only blocks that **cannot raise** are taken in: a block that could throw
 * would be caught by this `try` if it were moved inside it, and that is a
 * different program. All of a tail block's predecessors must already be in the
 * region, which is also what keeps the join after the handler (a block the
 * handler reaches too) out.
 */
function normalCompletionTail(ir, facts, g, r, tryBlocks) {
  const own = new Set(tryBlocks);
  const added = [];
  // Reachable from the handler *without re-entering the range*. The stop set
  // matters: a `try` inside a loop has a path handler -> ... -> loop header ->
  // back into the range, so plain reachability from the handler covers the
  // whole loop and rejects every candidate. Measured on
  // `b_357background.jsc` #11994, where it left both of the function's loops
  // unstructured.
  const handlerReach = g.reach([r.handlerBlock], new Set(tryBlocks));
  for (let round = 0; round < 8; round++) {
    let grew = false;
    const frontier = new Set();
    for (const b of own) for (const s of g.walkSuccs[b]) if (!own.has(s)) frontier.add(s);
    for (const t of frontier) {
      if (t === r.handlerBlock || handlerReach.has(t)) continue;
      if (!g.reachable(t)) continue;
      const off = ir.blocks[t].startOffset;
      if (off < r.handler.rangeEnd || off >= r.handler.handlerOffset) continue;
      // at least one predecessor, and all of them inside: no predecessor means
      // this is another range's handler block, which is not a tail
      if (!g.walkPreds[t].length || g.walkPreds[t].some((p) => !own.has(p))) continue;
      if (!cannotThrow(ir, facts, g, t)) continue;
      own.add(t); added.push(t); grew = true;
    }
    if (!grew) break;
  }
  return { blocks: own, added };
}

/**
 * Block sets and exits for every range that is going to become a `try`.
 *
 * @param {object} g   the final structuring graph
 */
export function planTryRegions(ir, facts, g, classification) {
  const plans = new Map();
  const warnings = [];
  const skipped = [];
  const fromEntry = g.reach([g.entry]);

  for (const r of classification.tryRanges) {
    const skip = (why, extra = {}) => {
      skipped.push({ handler: r.index, why, ...extra });
      warnings.push({ code: 'tryRangeNotStructured', handler: r.index, why, ...extra });
    };
    if (r.handlerBlock === null || r.entryBlock === null) { skip('rangeOrHandlerOffsetIsNotABlock'); continue; }
    if (r.empty) { skip('handlerRangeEmpty', { start: r.handler.rangeStart, end: r.handler.rangeEnd }); continue; }
    if (g.removedBlocks.has(r.handlerBlock) || g.removedBlocks.has(r.entryBlock)) { skip('insideARemovedRegion'); continue; }
    if (!g.reachable(r.entryBlock)) { skip('rangeEntryUnreachable'); continue; }

    const inRange = new Set();
    for (const b of ir.blocks) {
      if (g.removedBlocks.has(b.id)) continue;
      if (b.startOffset >= r.handler.rangeStart && b.startOffset < r.handler.rangeEnd) inRange.add(b.id);
    }
    if (!inRange.size) { skip('noBlocksInRange'); continue; }

    // single entry: nothing inside the range may be entered from outside it,
    // except the range's own first block
    let multiEntry = null;
    for (const b of inRange) {
      if (b === r.entryBlock) continue;
      for (const p of g.walkPreds[b]) {
        if (!inRange.has(p)) { multiEntry = { block: b, from: p }; break; }
      }
      if (multiEntry) break;
    }
    if (multiEntry) { skip('tryRangeNotSingleEntry', multiEntry); continue; }

    const tail = normalCompletionTail(ir, facts, g, r, inRange);
    const tryBlocks = tail.blocks;

    // the handler region: reachable from the handler, stopping at the range,
    // minus anything the range's own blocks reach without going through the
    // handler, and bounded by the end of the range the handler sits in
    const withoutHandler = g.reach([g.entry, ...tryBlocks], new Set([r.handlerBlock]));
    const bound = enclosingRangeEnd(ir, r);
    const handlerBlocks = new Set();
    for (const b of g.reach([r.handlerBlock], tryBlocks)) {
      if (withoutHandler.has(b)) continue;
      if (ir.blocks[b].startOffset >= bound) continue;
      handlerBlocks.add(b);
    }
    if (!handlerBlocks.has(r.handlerBlock)) handlerBlocks.add(r.handlerBlock);
    if (g.walkPreds[r.handlerBlock].length) {
      // a handler block with a normal predecessor would be placed twice: once
      // by the try construct and once by whatever jumps to it
      skip('handlerBlockHasNormalPredecessors', { preds: g.walkPreds[r.handlerBlock].slice(0, 4) });
      continue;
    }

    const own = new Set([...tryBlocks, ...handlerBlocks]);
    const exits = new Set();
    for (const b of own) for (const s of g.walkSuccs[b]) if (!own.has(s)) exits.add(s);

    plans.set(r.index, {
      ...r, tryBlocks, inRange, handlerBlocks, exits,
      normalCompletionTail: tail.added,
      handlerBound: bound === Infinity ? null : bound,
      reachableFromEntry: fromEntry.has(r.entryBlock),
    });
  }

  return { plans, warnings, skipped };
}

/**
 * The `finally` token dispatch, both of V8's two forms.
 *
 * @returns {object|null}
 */
export function recogniseFinallyToken(ir, facts, g, plan) {
  if (!plan.isFinallyOnly) return null;
  const hb = ir.blocks[plan.handlerBlock];

  // the token register: the last `Star <r>` in the handler block whose input
  // is a Smi-producing pure op. Found through T6's SSA, not by opcode name.
  let tokenVar = null, tokenStore = null;
  for (let i = hb.first; i <= hb.last; i++) {
    const vid = ir.instructionValue[i];
    if (vid < 0) continue;
    const v = ir.values[vid];
    if (!v || v.kind !== 'Op' || v.hasEffect) continue;
    for (const d of v.defs ?? []) {
      if (d.var === undefined || d.var < 0) continue;
      if (d.reg?.k !== 'local') continue;
      const src = v.inputs?.[0];
      const srcV = src === undefined || src === null || src < 0 ? null : ir.values[src];
      if (!srcV || srcV.kind !== 'Op' || srcV.hasEffect) continue;
      // a Smi literal load has no inputs and no effect
      if ((srcV.inputs ?? []).length !== 0) continue;
      tokenVar = d.var; tokenStore = { value: v.id, source: src, instruction: i };
    }
  }
  if (tokenVar === null) return null;

  // the dispatch: a block reachable from an exit of the range whose terminator
  // either switches on, or reference-compares, a phi of the token register
  const roots = [...plan.exits].filter((b) => g.reachable(b));
  if (!roots.length) return null;
  const region = g.reach(roots, new Set([...plan.tryBlocks, ...plan.handlerBlocks]));

  const tokenPhiOf = (blockId) => {
    for (const p of ir.blocks[blockId].phis) if (ir.values[p].var === tokenVar) return p;
    return null;
  };
  const tracesToToken = (ssaId, depth = 0) => {
    if (ssaId === null || ssaId === undefined || ssaId < 0 || depth > 4) return false;
    const v = ir.values[ssaId];
    if (!v) return false;
    if (v.var === tokenVar) return true;
    if (v.kind === 'Op' && !v.hasEffect && (v.inputs ?? []).length === 1) return tracesToToken(v.inputs[0], depth + 1);
    return false;
  };

  for (const bid of [...region].sort((a, b) => g.rpoNum[a] - g.rpoNum[b])) {
    const b = ir.blocks[bid];
    const last = b.instructions[b.instructions.length - 1];
    if (!last) continue;
    const vid = ir.instructionValue[b.last];
    const term = vid >= 0 ? ir.values[vid] : null;
    if (facts.isSmiSwitch(last.opcodeValue)) {
      const disc = term?.inputs?.[0];
      if (tracesToToken(disc)) {
        return {
          dispatchKind: 'switch', tokenVar, tokenStore, dispatchBlock: bid,
          finalizerEntry: roots.length === 1 ? roots[0] : [...roots].sort((x, y) => g.rpoNum[x] - g.rpoNum[y])[0],
          cases: b.outEdges.map((eid) => ir.edges[eid]).filter((e) => e.kind === 'switch')
            .map((e) => ({ token: e.caseValue, target: e.to })),
          fallThrough: b.outEdges.map((eid) => ir.edges[eid]).find((e) => e.kind === 'fallthrough')?.to ?? null,
          tokenPhi: tokenPhiOf(bid),
        };
      }
    } else if (facts.isConditionalJump(last.opcodeValue)) {
      const disc = term?.inputs?.[0];
      const cmp = disc === undefined || disc === null || disc < 0 ? null : ir.values[disc];
      if (cmp && cmp.kind === 'Op' && cmp.op === facts.op.referenceEqual) {
        const other = (cmp.inputs ?? []).find((x) => tracesToToken(x));
        if (other !== undefined) {
          const trueEdge = b.outEdges.map((eid) => ir.edges[eid]).find((e) => e.kind === 'true');
          const falseEdge = b.outEdges.map((eid) => ir.edges[eid]).find((e) => e.kind === 'false');
          return {
            dispatchKind: 'referenceEqual', tokenVar, tokenStore, dispatchBlock: bid,
            finalizerEntry: [...roots].sort((x, y) => g.rpoNum[x] - g.rpoNum[y])[0],
            cases: [{ token: null, target: trueEdge?.to ?? null }],
            fallThrough: falseEdge?.to ?? null,
            tokenPhi: tokenPhiOf(bid),
            comparedValue: cmp.inputs?.[0] ?? null,
          };
        }
      }
    }
  }
  return null;
}

export { ASYNC_PREDICTIONS, FINALLY_PREDICTION };
export default {
  classifyHandlers, asyncDesugaringBlocks, planTryRegions, recogniseFinallyToken,
  ASYNC_PREDICTIONS, FINALLY_PREDICTION,
};
