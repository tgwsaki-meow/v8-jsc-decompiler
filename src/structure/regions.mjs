// src/structure/regions.mjs
//
// The region tree: acyclic regions by immediate post-dominator -> if/else,
// with loops, switches and try ranges opened where they begin.
//
// Algorithms, cited
// -----------------
// * **Dominators / post-dominators / dominance frontiers**: Cooper, Harvey and
//   Kennedy, *A Simple, Fast Dominance Algorithm*, Rice TR-06-33870 (2001),
//   as implemented by T6 in `src/ir/dominators.mjs` and run by `graph.mjs`
//   over the structuring graph.
// * **Natural loops and the nesting forest**: Aho, Lam, Sethi and Ullman,
//   *Compilers* (2nd ed.) ch. 9.6.6, as implemented by T6 in
//   `src/ir/loops.mjs`.
// * **Choosing the follow node of a two-way header**: Cristina Cifuentes,
//   *Reverse Compilation Techniques* (PhD, QUT 1994) ch. 6, structuring
//   algorithm `structConds`: the follow of a two-way conditional is the node
//   it immediately dominates that has two or more in-edges, earliest in
//   reverse postorder. The immediate post-dominator is used as a cross-check
//   and as the fall-back, and `src/relooper.js`'s "lowest-numbered block
//   reachable from both branches" -- which is neither -- is what this
//   replaces.
// * **Interval / structural analysis** in the general sense (Sharir 1980,
//   Allen & Cocke 1976) is what "open the construct where it begins, recurse
//   into its body, continue at its follow" is an instance of.
//
// Deliberately *not* used: a goto-elimination framework (Yakdan et al., DREAM,
// NDSS 2015 / Erosa & Hendren's "no more gotos"). docs/IR.md section 9
// measures the corpus as fully reducible once the generator resume dispatcher
// is removed -- 0 of 239 979 functions irreducible -- so natural loops plus
// post-dominator regions are sufficient, and ARCHITECTURE.md 4.4.7's
// `unstructured` fall-back is the insurance rather than the main path.
//
// What makes "every block exactly once" true by construction
// ----------------------------------------------------------
// One counter per block: `pending[b]` = how many of its structuring-graph
// predecessors have not been emitted yet, back edges excluded (a loop header's
// latch edge belongs to the loop construct, so counting it would stop the
// header from ever being ready). A block is emitted only when its counter
// reaches zero; arriving at a block whose counter is still positive ends the
// current chain and hands the block to the ancestor that owns it, which is
// exactly the follow relation. So a block can neither be emitted twice (the
// first emission sets its `emitted` flag and the invariant check would catch a
// second) nor be skipped (if it is reachable, all its predecessors are
// eventually emitted and it becomes ready).

import { conditionalTest, negated, valueTest, caughtTarget, terminatorInputs } from './conditions.mjs';
import { resolveJump, resolveForwardJoin, labelFor } from './jumps.mjs';

// Work budgets. Neither is a property of the bytecode -- they exist so that a
// bug in the step relation shows up as a counted failure on one function
// instead of a corpus scan that never finishes.
const TRACE_LIMIT = 4096;
const BUDGET_SLACK = 4096;
const BUDGET_PER_BLOCK = 64;

export function buildRegions(C) {
  const { ir, facts, g, loopPlans, tryPlans, switchPlan, finallyShapes } = C;
  const n = ir.blocks.length;

  const emitted = new Uint8Array(n);
  const pending = Int32Array.from(g.inDeg);
  const placedBlocks = new Set();
  const consumedBlocks = new Set();
  const placedEdges = new Set();
  const labels = [];
  const warnings = [];
  const openLoops = new Set();
  const openTries = new Set();
  let chainSeq = 0;
  let failure = null;
  // Total work budget. Each chain is bounded on its own (see `steps` below),
  // but a chain spawns sub-chains, so an unbounded *number* of chains is still
  // possible if some step makes no progress -- and the cost of that on a
  // 239 979-function scan is a run that never finishes rather than a number.
  // Progress means "a block was emitted", of which there are at most n, so
  // any budget linear in n with slack is safe for a correct step relation.
  let budget = BUDGET_PER_BLOCK * (n + 8) + BUDGET_SLACK;
  const trace = [];
  const stats = {
    ifs: 0, ifsWithoutFollow: 0, ifsNegated: 0, seqs: 0,
    loops: 0, loopForms: {}, switches: 0, switchForms: {},
    tries: 0, triesWithFinallyShape: 0, breaks: 0, continues: 0,
    labelledBreaks: 0, labelledContinues: 0, labelledChains: 0, labelledJoins: 0,
    joinNeverReached: 0,
    followFromDomChildren: 0, followFromIpdom: 0, followNull: 0,
    doubleEmitAttempts: 0,
  };

  // The last few chain steps travel with the failure. A fall-back is reported
  // (ARCHITECTURE.md 4.4.7) rather than hidden, and "which chain was walking
  // where" is the only part of a fall-back that is not reconstructible from
  // the plans, so it belongs in the report rather than in a debug build.
  const fail = (why, detail) => {
    if (!failure) failure = { why, detail: { ...detail, trace: trace.slice(-16) } };
    return null;
  };

  /** Mark a block as structurally accounted for and release its successors. */
  const consume = (b, asLeaf) => {
    if (emitted[b]) { stats.doubleEmitAttempts++; fail('blockEmittedTwice', { block: b }); return false; }
    emitted[b] = 1;
    (asLeaf ? placedBlocks : consumedBlocks).add(b);
    for (const s of g.walkSuccs[b]) {
      if (g.isBackEdge(b, s)) continue;
      pending[s]--;
    }
    for (const eid of ir.blocks[b].outEdges) {
      const e = ir.edges[eid];
      if (e.kind === 'exception' || g.removedEdges.has(e.id)) continue;
      placedEdges.add(e.id);
    }
    return true;
  };

  const leaf = (b) => (consume(b, true) ? { r: 'block', id: b } : null);

  /**
   * What the labelled-join rule needs to know. `reserve` makes a claim
   * binding: block -> the chain frame that owes the labelled block.
   */
  const reservedJoins = new Map();
  const joinEnv = {
    offsetOf: (b) => ir.blocks[b]?.startOffset ?? Number.MAX_SAFE_INTEGER,
    emitted: (b) => !!emitted[b],
    ownerOf: (b) => reservedJoins.get(b),
    reserve: (b, frame) => { if (!reservedJoins.has(b)) reservedJoins.set(b, frame); },
  };

  // ----------------------------------------------------------------- follow
  /**
   * Cifuentes' rule, with the immediate post-dominator as the fall-back.
   * `allowed` and the frame targets bound the answer: a follow outside the
   * region being built, or one that is already an enclosing construct's
   * break/continue target, would place a block in the wrong body.
   */
  const followOf = (h, ctx, exclude = null) => {
    const ok = (x) => {
      if (x === undefined || x === null || x < 0 || x >= n) return false;
      if (g.removedBlocks.has(x) || emitted[x]) return false;
      if (exclude && exclude.has(x)) return false;
      if (ctx.allowed && !ctx.allowed.has(x)) return false;
      if (ctx.claim && ctx.claim.has(x)) return true;
      for (const f of ctx.frames) {
        if (f.isLoop && f.continueTarget === x) return false;
        if (f.isBreakable && f.breakTarget === x) return false;
      }
      return true;
    };
    // Earliest by bytecode offset, not by reverse postorder. Cifuentes' rule
    // says "earliest in the depth-first ordering"; for Ignition the emission
    // order IS the source order, while a depth-first numbering depends on
    // which branch the walk took first and picks the wrong join when a
    // `switch` has fall-through between cases.
    const off = (x) => ir.blocks[x].startOffset;
    let best = null;
    for (const x of g.dom.children[h] ?? []) {
      if (g.inDeg[x] < 2 || !ok(x)) continue;
      if (best === null || off(x) < off(best)) best = x;
    }
    if (best !== null) { stats.followFromDomChildren++; return best; }
    const p = g.pdom().ipdom[h];
    if (p !== undefined && p >= 0 && p < n && p !== h && g.dom.strictlyDominates(h, p) && ok(p)) {
      stats.followFromIpdom++;
      return p;
    }
    stats.followNull++;
    return null;
  };

  // ------------------------------------------------------------------ chain
  /**
   * A straight-line run of regions, ending at `fallOut`, at a jump, at a
   * terminator, or at a block an ancestor owns.
   *
   * @param {number} start
   * @param {{fallOut:number|null, frames:Array, allowed:Set|null, claim:Set|null,
   *          emitStart?:boolean}} ctx
   *        `emitStart` means "this chain exists in order to emit `start`", so
   *        the first step may not resolve `start` as a jump to an enclosing
   *        construct. Exactly one caller needs it and it cannot be skipped:
   *        the body of a `forever` loop begins at the header, which is also
   *        the loop's own continue target, so without it the body comes out as
   *        the single statement `continue` and every block of the loop goes
   *        unplaced. It is deliberately per-chain and never inherited -- a
   *        nested `if (x) continue;` inside that same body still has to
   *        resolve to `continue`.
   * @returns {{region: object, fellTo: number|null}|null}
   */
  const chain = (start, ctx) => {
    const body = [];
    const frame = {
      kind: 'chain', id: chainSeq++, head: start, fallOut: ctx.fallOut,
      isLoop: false, isBreakable: false, breakTarget: null, continueTarget: null,
      label: null, needsLabel: false,
      // the labelled-join rule (jumps.mjs resolveForwardJoin)
      allowed: ctx.allowed, pendingJoins: new Map(), bodyLen: () => body.length,
    };
    const frames = [...ctx.frames, frame];
    const sub = { ...ctx, frames };
    let cur = start;
    let fellTo = null;
    let first = true;
    // A chain can visit each block at most once (every step either emits a
    // block or ends the chain), so anything past that is a bug in the step
    // relation. Reported as a failure rather than left to hang: a corpus scan
    // over 239 979 functions cannot afford one non-terminating input.
    let steps = 0;

    // The chain does not end while it still owes a labelled join. When every
    // path into the join left through its `break`, control reaches the join by
    // falling off the end of the labelled block, so the chain resumes *at* the
    // join -- which is also what makes the label end in exactly the right
    // place. See jumps.mjs resolveForwardJoin.
    const resumeAtOwedJoin = () => {
      let best = null;
      for (const t of frame.pendingJoins.keys()) {
        if (best === null || joinEnv.offsetOf(t) < joinEnv.offsetOf(best)) best = t;
      }
      return best;
    };

    while (cur !== null && cur !== undefined) {
      if (failure) return null;
      if (++steps > n + 4) return fail('chainDidNotTerminate', { start, at: cur, fallOut: ctx.fallOut, steps });
      if (--budget < 0) return fail('structuringBudgetExhausted', { start, at: cur, fallOut: ctx.fallOut, trace: trace.slice(-24) });
      if (trace.length < TRACE_LIMIT) trace.push(`${start}@${ctx.fallOut}:${cur}`);
      // A chain whose fall-out IS its start means "emit the start, then run
      // until control comes back here" -- which is what a `do/while` whose
      // test lives in the header needs. So the fall-out only ends the chain
      // from the second arrival on.
      const isFirst = first;
      if (cur === ctx.fallOut && !isFirst) {
        const owed = fellTo === null ? resumeAtOwedJoin() : null;
        if (owed === null) { fellTo = cur; break; }
        // Control leaves this region here, but a labelled join still has to be
        // emitted after the label closes, so falling off the end would put the
        // join's blocks on this path too. The exit becomes an explicit break
        // out of this chain -- which is what wraps the chain in
        // `{r:'labeled'}` -- and the chain carries on at the join.
        const label = labelFor(frame, labels);
        frame.labelRecord.usedBy.push({ kind: 'break', target: cur });
        frame.needsLabel = true;
        body.push({ r: 'break', label });
        stats.breaks++; stats.labelledBreaks++;
        fellTo = cur;
        cur = owed;
        continue;
      }
      first = false;

      // `ctx.frames`, not `frames`: this chain's own frame must not resolve
      // its own fall-out as a labelled break -- that is what the explicit
      // `cur === ctx.fallOut` test above is for. Descendants do see it, which
      // is the point of having chain frames at all.
      if (!(isFirst && ctx.emitStart) && !ctx.claim?.has(cur)) {
        const j = resolveJump(cur, ctx.frames, labels);
        if (j) {
          body.push(j.region);
          if (j.kind === 'break') { stats.breaks++; if (j.region.label) stats.labelledBreaks++; }
          else if (j.kind === 'continue') { stats.continues++; if (j.region.label) stats.labelledContinues++; }
          else if (j.kind === 'labelledBreak') { stats.breaks++; stats.labelledBreaks++; }
          cur = resumeAtOwedJoin();
          if (cur !== null) continue;
          break;
        }
      }

      // A join another chain has claimed. The claim is binding: whoever else
      // arrives here breaks to the same label instead of emitting the block,
      // or the labelled block and the block it is supposed to end before
      // would be emitted in two different places.
      const owner = reservedJoins.get(cur);
      if (owner !== undefined && owner !== frame) {
        const j = resolveForwardJoin(cur, ctx.frames, labels, joinEnv);
        if (j) {
          body.push(j.region);
          stats.breaks++; stats.labelledBreaks++;
          cur = resumeAtOwedJoin();
          if (cur !== null) continue;
          break;
        }
        return fail('reservedJoinNotReachableAsABreak', { block: cur, from: start, owner: owner.head });
      }

      if (g.removedBlocks.has(cur) || !g.reachable(cur)) {
        return fail('stepIntoRemovedOrUnreachableBlock', { block: cur, from: start });
      }
      if (ctx.allowed && !ctx.allowed.has(cur)) {
        // A block outside this region, and not the construct's break or
        // continue target: the second exit of a multi-exit loop, which leaves
        // for a join further out. An enclosing chain can own it as a labelled
        // block -- `break J` out of a label that contains the loop is exactly
        // what the source would have written.
        const j = resolveForwardJoin(cur, ctx.frames, labels, joinEnv);
        if (j) {
          body.push(j.region);
          stats.breaks++; stats.labelledBreaks++;
          cur = resumeAtOwedJoin();
          if (cur !== null) continue;
          break;
        }
        return fail('stepOutsideRegion', { block: cur, from: start, fallOut: ctx.fallOut });
      }
      if (emitted[cur]) return fail('stepIntoEmittedBlock', { block: cur, from: start });

      // A join this chain is going to emit later, requested by a descendant:
      // close the labelled block here, right before it (jumps.mjs
      // resolveForwardJoin). Done before the readiness test because the whole
      // point of the label is that the target is NOT ready yet.
      const req = frame.pendingJoins.get(cur);
      if (req) {
        frame.pendingJoins.delete(cur);
        reservedJoins.delete(cur);
        const at = Math.min(req.at, body.length);
        const inside = body.splice(at);
        body.push({
          r: 'labeled', label: req.label, forJoin: cur,
          body: inside.length === 1 ? inside[0] : { r: 'seq', body: inside },
        });
        for (const other of frame.pendingJoins.values()) other.at = Math.min(other.at, at);
        stats.labelledJoins++;
      }

      if (pending[cur] > 0) {
        // An ancestor owns it. If no ancestor is *expecting* it -- i.e. it is
        // not any enclosing chain's fall-out, which `resolveJump` above would
        // already have turned into a labelled break -- then handing it
        // upwards only moves the failure, so try the labelled-join rule.
        const j = ctx.claim?.has(cur) ? null : resolveForwardJoin(cur, ctx.frames, labels, joinEnv);
        if (j) {
          body.push(j.region);
          stats.breaks++; stats.labelledBreaks++;
          cur = resumeAtOwedJoin();
          if (cur !== null) continue;
          break;
        }
        fellTo = cur; break;
      }

      // `undefined` means no construct starts here; `null` means one does and
      // it failed. Collapsing the two would silently re-walk a failed
      // construct as a plain block.
      let step = openConstructs(cur, sub);
      if (step === undefined) step = stepBlock(cur, sub);
      if (step === null) return null;
      for (const r of step.regions) body.push(r);
      if (step.fellTo !== undefined && step.fellTo !== null) {
        // A sub-region fell out to something this chain does not own. Going
        // back round the loop rather than breaking out here is what lets the
        // fall-out test at the top apply the labelled-join rule: this chain
        // may still owe a join that has to be emitted after the exit.
        cur = step.fellTo;
        continue;
      }
      cur = step.next ?? null;
      if (cur === null || cur === undefined) cur = resumeAtOwedJoin();
    }

    if (failure) return null;
    if (frame.pendingJoins.size) {
      // A `break <label>` was emitted for a join this chain then never
      // reached, so the labelled block would end in the wrong place. Counted
      // and failed into the fall-back rather than emitted.
      stats.joinNeverReached++;
      return fail('labelledJoinNeverReached', {
        chain: start, fallOut: ctx.fallOut, targets: [...frame.pendingJoins.keys()],
      });
    }

    let region = body.length === 1 ? body[0] : { r: 'seq', body };
    if (body.length !== 1) stats.seqs++;
    if (frame.needsLabel) {
      stats.labelledChains++;
      region = { r: 'labeled', label: frame.label, body: region };
    }
    return { region, fellTo };
  };

  // ------------------------------------------------- loops / tries / switches
  /**
   * Does a construct start at this block? Returns `undefined` when none does.
   * A handler index of 0 is a perfectly ordinary answer, so every test here is
   * against `null` rather than truthiness.
   */
  const openConstructs = (b, ctx) => {
    const lp = loopPlans.get(b);
    const tr = tryStartingAt(b, ctx);
    if (lp && !openLoops.has(b)) {
      // A try range that contains the whole loop has to be opened first, or
      // the loop would swallow the `try`.
      if (tr !== null && containsAll(tryPlans.get(tr).tryBlocks, lp.body)) return buildTry(tr, b, ctx);
      return buildLoop(lp, ctx);
    }
    if (tr !== null) return buildTry(tr, b, ctx);
    return undefined;
  };

  const tryStartingAt = (b, ctx) => {
    let best = null;
    for (const [index, plan] of tryPlans) {
      if (openTries.has(index)) continue;
      if (plan.entryBlock !== b) continue;
      if (ctx.allowed && !containsAll(ctx.allowed, plan.tryBlocks)) continue;
      // several ranges can start at the same offset; open the widest first so
      // the narrower one nests inside it
      if (best === null || plan.tryBlocks.size > tryPlans.get(best).tryBlocks.size) best = index;
    }
    return best;
  };

  const buildLoop = (lp, ctx) => {
    openLoops.add(lp.header);
    stats.loops++;
    stats.loopForms[lp.form] = (stats.loopForms[lp.form] ?? 0) + 1;

    const frame = {
      kind: 'loop', head: lp.header, isLoop: true, isBreakable: true,
      breakTarget: lp.follow, continueTarget: lp.continueTarget,
      fallOut: null, label: null, plan: lp,
    };
    const frames = [...ctx.frames, frame];

    // `lp.region`, not `lp.body`: a block whose only exit is a `break` is
    // inside the loop in the source but outside the natural loop, because it
    // cannot reach a latch. See loops.mjs `loopRegion`.
    const allowed = new Set(lp.region);
    const claim = new Set(ctx.claim ?? []);
    const pre = [];

    let test = null;
    if (lp.testBlock !== null && lp.testValue !== null && lp.testValue !== undefined) {
      // `negate === false` has to mean "the loop keeps going", for every form,
      // so the then-side is whichever of the two edges stays in the body.
      const thenIsJumpTarget = (() => {
        const tb = ir.blocks[lp.testBlock];
        const trueEdge = tb.outEdges.map((eid) => ir.edges[eid]).find((e) => e.kind === 'true');
        if (!trueEdge) return true;
        return lp.body.has(trueEdge.to);
      })();
      test = conditionalTest(ir, facts, lp.testBlock, thenIsJumpTarget);
    }

    // Where the body chain naturally ends. For every form but the classic
    // `do/while` that is the block the back edge targets: arriving there means
    // "the iteration is over". The classic `do/while` ends at its test block
    // instead, which it has to emit rather than jump to, hence the claim.
    let bodyFallOut = lp.header;
    if (lp.form === 'for' || lp.form === 'while') {
      // the whole test chain, not just the header: when the leader rule split
      // the condition (loops.mjs point 0) every block of the chain is part of
      // the test and none of them is emitted as a statement
      for (const b of lp.testChain) {
        allowed.delete(b);
        if (!consume(b, false)) return null;
      }
      if (lp.form === 'for') {
        allowed.delete(lp.updateBlock);
        bodyFallOut = lp.updateBlock;
      }
    } else if (lp.form === 'doWhile' && !lp.testAtHeader) {
      claim.add(lp.testBlock);
      bodyFallOut = null;
    } else if (lp.form === 'forever' && lp.headerPlacedInBody) {
      // the header could not be consumed by the test, so it is placed as an
      // ordinary leaf and the exit becomes an explicit break
      const hl = leaf(lp.header);
      if (hl === null) return null;
      pre.push(hl);
      if (test !== null) {
        const brk = { r: 'break', label: null };
        stats.breaks++;
        pre.push({ r: 'if', test: negated(test), then: brk, else: null });
        stats.ifs++;
      }
      allowed.delete(lp.header);
    }

    const bodyStart = lp.headerPlacedInBody
      ? (g.walkSuccs[lp.header].find((s) => lp.body.has(s)) ?? null)
      : lp.bodyEntry;

    let bodyRegion = { r: 'seq', body: [] };
    if (bodyStart !== null && bodyStart !== undefined) {
      const r = chain(bodyStart, { fallOut: bodyFallOut, frames, allowed, claim, emitStart: true });
      if (r === null) return null;
      if (r.fellTo !== null && r.fellTo !== bodyFallOut) {
        return fail('loopBodyFellOutOfTheLoop', { loop: lp.header, fellTo: r.fellTo, form: lp.form });
      }
      bodyRegion = r.region;
    }
    if (pre.length) bodyRegion = { r: 'seq', body: [...pre, bodyRegion] };

    let update = null;
    if (lp.form === 'for') {
      // the update block IS the loop's continue target, so the chain that
      // emits it has to claim it or `resolveJump` would turn it into the
      // `continue` that jumps to it
      const u = chain(lp.updateBlock, {
        fallOut: lp.header, frames, allowed: new Set([lp.updateBlock]),
        claim: new Set([lp.updateBlock]),
      });
      if (u === null) return null;
      update = u.region;
    }
    if (lp.form === 'doWhile' && !emitted[lp.testBlock]) {
      return fail('doWhileTestBlockNotPlaced', { loop: lp.header, testBlock: lp.testBlock });
    }

    // the loop's own edges
    for (const eid of ir.blocks[lp.header].inEdges) {
      const e = ir.edges[eid];
      if (e.kind !== 'exception' && g.isBackEdge(e.from, e.to)) placedEdges.add(e.id);
    }

    const region = {
      r: 'loop',
      form: lp.headerPlacedInBody ? 'forever' : lp.form,
      test: lp.headerPlacedInBody ? null : test,
      init: null, update, body: bodyRegion,
      label: frame.label,
      testBlock: lp.headerPlacedInBody ? null : lp.testBlock,
      header: lp.header,
      idiom: lp.idiom ? lp.idiom.kind : null,
      idiomDetail: lp.idiom ?? null,
      endless: lp.endless,
    };
    if (frame.label) frame.labelRecord.forRegion = 'loop';
    return { regions: [region], next: lp.follow ?? null };
  };

  const buildTry = (index, entryBlock, ctx) => {
    const plan = tryPlans.get(index);
    openTries.add(index);
    stats.tries++;

    const frame = {
      kind: 'try', head: entryBlock, isLoop: false, isBreakable: false,
      breakTarget: null, continueTarget: null, fallOut: null, label: null,
    };
    const frames = [...ctx.frames, frame];

    // the follow: the earliest exit of the range that this region may own
    let follow = null;
    for (const x of [...plan.exits].sort((a, b) => g.rpoNum[a] - g.rpoNum[b])) {
      if (g.removedBlocks.has(x) || emitted[x]) continue;
      if (ctx.allowed && !ctx.allowed.has(x)) continue;
      let isFrameTarget = false;
      for (const f of ctx.frames) {
        if ((f.isLoop && f.continueTarget === x) || (f.isBreakable && f.breakTarget === x)) isFrameTarget = true;
      }
      if (isFrameTarget) continue;
      follow = x; break;
    }
    const inner = follow ?? ctx.fallOut;

    const blockR = chain(entryBlock, {
      fallOut: inner, frames, allowed: plan.tryBlocks, claim: ctx.claim,
    });
    if (blockR === null) return null;
    if (blockR.fellTo !== null && blockR.fellTo !== inner) {
      return fail('tryBodyFellOutOfItsRange', { handler: index, fellTo: blockR.fellTo });
    }

    let handlerR = null;
    if (!emitted[plan.handlerBlock]) {
      const h = chain(plan.handlerBlock, {
        fallOut: inner, frames, allowed: plan.handlerBlocks, claim: ctx.claim,
      });
      if (h === null) return null;
      if (h.fellTo !== null && h.fellTo !== inner) {
        return fail('handlerFellOutOfItsRegion', { handler: index, fellTo: h.fellTo });
      }
      handlerR = h.region;
    }

    const shape = finallyShapes.get(index) ?? null;
    if (shape) stats.triesWithFinallyShape++;
    const region = {
      r: 'try',
      block: blockR.region,
      param: caughtTarget(ir, plan.handlerBlock),
      handler: handlerR,
      finalizer: null,
      handlerIndex: index,
      prediction: plan.prediction,
      form: shape ? 'finallyToken' : 'catch',
      finallyShape: shape,
    };
    return { regions: [region], next: follow ?? null, fellTo: follow === null && inner !== null ? inner : null };
  };

  const buildSwitch = (sw, ctx) => {
    stats.switches++;
    stats.switchForms[sw.form] = (stats.switchForms[sw.form] ?? 0) + 1;

    const heads = [
      ...(sw.form === 'compareChain' ? sw.links.map((l) => l.block) : [sw.head]),
      ...(sw.trampolines ?? []),
    ];
    const pre = [];
    for (const h of heads) {
      if (emitted[h]) {
        if (h !== sw.head) return fail('switchLinkAlreadyPlaced', { head: sw.head, link: h });
        continue;
      }
      const l = leaf(h);
      if (l === null) return null;
      pre.push(l);
    }

    // Finding the block after a `switch` takes three tries, because a case
    // entry with fall-through has two or more in-edges and is an immediate
    // dominator child of the head -- so it satisfies Cifuentes' rule for a
    // follow node and would be mistaken for one.
    //
    //   1. ignore every case entry, including the default's: what is left is
    //      the real join (`case 1: ...; break; ... } after;`)
    //   2. a default target the head does not even dominate is not a default
    //      body at all, it is the out-of-range path leaving the switch -- which
    //      is what a jump table guarded by range checks looks like
    //   3. otherwise, if the default's target is itself the join, the switch
    //      has no `default` clause and that block is the follow
    const realCaseTargets = new Set(sw.cases.map((c) => c.target).filter((x) => x !== null && x !== undefined));
    const defaultTarget = sw.default?.target ?? null;
    let follow = followOf(sw.head, ctx, new Set([...realCaseTargets, ...(defaultTarget === null ? [] : [defaultTarget])]));
    if (follow === null && defaultTarget !== null && !g.dom.strictlyDominates(sw.head, defaultTarget)) {
      follow = defaultTarget;
    }
    if (follow === null && defaultTarget !== null) {
      const f2 = followOf(sw.head, ctx, realCaseTargets);
      if (f2 === defaultTarget) follow = f2;
    }
    const frame = {
      kind: 'switch', head: sw.head, isLoop: false, isBreakable: true,
      breakTarget: follow, continueTarget: null, fallOut: null, label: null,
    };
    const frames = [...ctx.frames, frame];

    // every (case value -> target) plus the default, ordered the way the
    // bodies are laid out, so a body that falls into the next case comes out
    // as JavaScript's implicit fall-through
    const entries = sw.cases.map((c) => ({ ...c, isDefault: false }));
    if (sw.default && sw.default.target !== null && sw.default.target !== follow) {
      entries.push({ ...sw.default, isDefault: true, testValue: null });
    }
    // Ordered by bytecode offset, not by reverse postorder. `BytecodeGenerator`
    // is a single pass over the AST, so the case bodies lie in the bytecode in
    // source order -- which is the order a body that falls into the next case
    // needs. Reverse postorder is a property of the depth-first walk and puts
    // the first-taken branch last, which inverts the cases and would turn an
    // implicit fall-through into a jump to the wrong body.
    const offsetOf = (b) => ir.blocks[b]?.startOffset ?? Number.MAX_SAFE_INTEGER;
    entries.sort((a, b) => {
      const oa = offsetOf(a.target), ob = offsetOf(b.target);
      if (oa !== ob) return oa - ob;
      if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
      return (a.caseValue ?? 0) - (b.caseValue ?? 0);
    });

    const distinct = [];
    for (const e of entries) if (!distinct.includes(e.target)) distinct.push(e.target);

    const cases = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isLastOfTarget = i + 1 >= entries.length || entries[i + 1].target !== e.target;
      const test = e.isDefault ? null
        : (e.testValue !== null && e.testValue !== undefined
          ? valueTest(ir, e.block ?? sw.head, e.testValue, 'compareChainCaseLabel')
          : null);
      const rec = { test, caseValue: e.caseValue ?? null, body: { r: 'seq', body: [] }, isDefault: e.isDefault };
      if (isLastOfTarget) {
        const k = distinct.indexOf(e.target);
        const nextEntry = k >= 0 && k + 1 < distinct.length ? distinct[k + 1] : null;
        const bodyFallOut = nextEntry ?? follow ?? ctx.fallOut;
        if (e.target === bodyFallOut || emitted[e.target] || pending[e.target] > 0) {
          rec.body = { r: 'seq', body: [] };
        } else {
          const r = chain(e.target, { fallOut: bodyFallOut, frames, allowed: ctx.allowed, claim: ctx.claim });
          if (r === null) return null;
          if (r.fellTo !== null && r.fellTo !== bodyFallOut) {
            return fail('switchCaseFellOutOfTheSwitch', { head: sw.head, caseValue: e.caseValue, fellTo: r.fellTo });
          }
          rec.body = r.region;
        }
      }
      cases.push(rec);
    }

    const discBlock = sw.form === 'compareChain' ? sw.discBlock : sw.head;
    const region = {
      r: 'switch',
      disc: valueTest(ir, discBlock, sw.disc, sw.form === 'compareChain' ? 'compareChainDiscriminant' : 'jumpTableDiscriminant'),
      cases, form: sw.form, label: frame.label,
      head: sw.head,
      finallyToken: !!sw.finallyToken,
      guardBlocks: sw.guardBlocks ?? [],
      links: sw.form === 'compareChain' ? sw.links.map((l) => l.block) : null,
    };
    if (frame.label) frame.labelRecord.forRegion = 'switch';
    const regions = pre.length ? [...pre, region] : [region];
    return { regions, next: follow ?? null, fellTo: follow === null && ctx.fallOut !== null ? ctx.fallOut : null };
  };

  // -------------------------------------------------------- a plain block
  const stepBlock = (b, ctx) => {
    const sw = switchPlan.jumpTables.get(b) ?? switchPlan.compareChains.get(b);
    if (sw) return buildSwitch(sw, ctx);

    const l = leaf(b);
    if (l === null) return null;
    const regions = [l];
    const succs = g.walkSuccs[b];

    if (succs.length === 0) return { regions, next: null };

    // The two edges of a `do/while` test belong to the loop construct: one is
    // the back edge, the other is the exit. `afterTest` is the rest of the
    // body for the shape where the test sits in the header block.
    const lp = [...ctx.frames].reverse().find((f) => f.isLoop)?.plan ?? null;
    if (lp && lp.form === 'doWhile' && b === lp.testBlock) {
      const after = lp.afterTest;
      if (after === null || after === undefined || emitted[after]) return { regions, next: null };
      return { regions, next: after };
    }

    if (succs.length === 1) return { regions, next: succs[0] };

    const last = ir.blocks[b].instructions[ir.blocks[b].instructions.length - 1];
    if (facts.isSwitch(last.opcodeValue)) {
      // a switch the planner declined (a `finally` token dispatch, or a table
      // with no entries); fall back to an unstructured region for the function
      return fail('unplannedSwitchTerminator', { block: b, opcode: last.opcode });
    }
    if (!facts.isConditionalJump(last.opcodeValue) || succs.length !== 2) {
      return fail('multiwayTerminatorThatIsNotASwitch', { block: b, opcode: last.opcode, succs: succs.length });
    }

    // ------------------------------------------------------------- if/else
    const edges = ir.blocks[b].outEdges.map((eid) => ir.edges[eid]).filter((e) => !g.removedEdges.has(e.id));
    const trueTo = edges.find((e) => e.kind === 'true')?.to ?? null;
    const falseTo = edges.find((e) => e.kind === 'false')?.to ?? null;
    if (trueTo === null || falseTo === null) {
      return fail('conditionalWithoutBothEdges', { block: b, opcode: last.opcode });
    }

    const follow = followOf(b, ctx);
    if (follow === null) stats.ifsWithoutFollow++;
    const inner = follow ?? ctx.fallOut;
    let test = conditionalTest(ir, facts, b, true);
    if (test === null) return fail('noPredicateForConditional', { block: b, opcode: last.opcode });

    const branch = (to) => {
      if (to === inner) return { region: null, fellTo: inner };
      const r = chain(to, { fallOut: inner, frames: ctx.frames, allowed: ctx.allowed, claim: ctx.claim });
      if (r === null) return null;
      return r;
    };
    const tb = branch(trueTo);
    if (tb === null) return null;
    const fb = branch(falseTo);
    if (fb === null) return null;
    for (const side of [tb, fb]) {
      if (side.fellTo !== null && side.fellTo !== inner) {
        return fail('branchFellOutOfTheRegion', { block: b, fellTo: side.fellTo, follow, inner });
      }
    }

    let thenR = tb.region, elseR = fb.region;
    if (thenR === null && elseR === null) {
      // both sides go straight to the join: the conditional is dead shape
      return { regions, next: follow, fellTo: follow === null ? inner : null };
    }
    if (thenR === null) { thenR = elseR; elseR = null; test = negated(test); stats.ifsNegated++; }
    stats.ifs++;
    regions.push({ r: 'if', test, then: thenR, else: elseR });

    return { regions, next: follow, fellTo: follow === null ? inner : null };
  };

  // ------------------------------------------------------------------- run
  const allowedRoot = new Set();
  for (const b of ir.blocks) if (g.reachable(b.id)) allowedRoot.add(b.id);

  const top = chain(g.entry, { fallOut: null, frames: [], allowed: allowedRoot, claim: null });
  if (top === null || failure) {
    return { root: null, failure: failure ?? { why: 'chainReturnedNothing' }, placedBlocks, consumedBlocks, placedEdges, labels, warnings, stats };
  }
  if (top.fellTo !== null) {
    return {
      root: null,
      failure: { why: 'functionChainFellOut', detail: { fellTo: top.fellTo } },
      placedBlocks, consumedBlocks, placedEdges, labels, warnings, stats,
    };
  }

  return { root: top.region, failure: null, placedBlocks, consumedBlocks, placedEdges, labels, warnings, stats };
}

function containsAll(superset, subset) {
  for (const x of subset) if (!superset.has(x)) return false;
  return true;
}

export { labelFor, terminatorInputs };
export default { buildRegions };
