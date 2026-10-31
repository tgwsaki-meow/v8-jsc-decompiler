// src/structure/loops.mjs
//
// Natural loops -> `while` / `doWhile` / `for` / `forever`.
//
// The loops themselves are T6's (src/ir/loops.mjs, Aho/Lam/Sethi/Ullman ch.
// 9.6: a back edge n -> h with h dominating n, and the natural loop as the
// backward closure from the latches stopping at the header), run by graph.mjs
// over the structuring graph. What is left is choosing the statement form,
// which is a question about where the test sits relative to the header and the
// latch -- V8's `LoopBuilder` shape, as ARCHITECTURE.md 4.4.1 says.
//
// Four things decided by measurement rather than by taste:
//
// 0. **The test is not always in the header block.** `LoopBuilder` puts the
//    condition at the top of the loop, but docs/IR.md section 3's leader rule
//    ends a block after *every potentially-throwing instruction inside a
//    protected handler range* (ARCHITECTURE.md 10.2, LLVM's `invoke` model).
//    A comparison can call `valueOf`, so inside an `async` function -- whose
//    whole body is one ASYNC_AWAIT range -- `while (i < n)` comes out as
//
//      B3  Ldar/LdaSmi/TestLessThan                (the block ends here)
//      B4  JumpIfFalse -> exit
//
//    with the comparison in the header and the branch in the block after it.
//    Requiring the two-way terminator to be in the header itself classifies
//    that as `forever`, which is what `async-await-in-loop` measured. So the
//    test is looked for along the *test chain*: the header plus the run of
//    single-successor blocks after it that the header is the only way into.
//    Every block of that chain is in the loop body, post-dominates the header
//    and is dominated by it (a single-successor run gives all three for free
//    and needs no post-dominator query).
//
// 1. **The test block has to be accounted for.** `while (test) body` does not
//    emit the header block's statements anywhere, because the test is an SSA
//    value and T7 inlines its whole dependency cone into the expression. That
//    is only safe when the header holds *nothing but* the test: every
//    non-terminator value either feeds the test with exactly one use (the
//    condition ARCHITECTURE.md 4.3 inlines on) or is dead and pure. When it
//    does not hold -- `while (log(), cond)` -- the form degrades to `forever`
//    with the header placed as an ordinary `{r:'block'}` leaf followed by
//    `if (!test) break`. Always correct, occasionally uglier, and counted.
//    `doWhile` never needs the gate: its test block is the latch, which sits
//    inside the body anyway.
//
// 2. **`for` is emitted only when `while` would be wrong.** V8's `LoopBuilder`
//    gives a `for` loop a separate continue target -- the update block -- and
//    `continue` jumps there, not to the header. Structuring that as
//    `while (test) { body; update }` turns `continue` into a jump into the
//    middle of the body, which is not expressible. So `for` is used exactly
//    when the single latch is not the header and something inside the body
//    jumps to it; otherwise `while` is both simpler and correct. `init` is
//    always null: V8 puts the initialiser in the block before the header,
//    which also carries whatever preceded the loop, and a `{r:'block'}` leaf
//    cannot be split.
//
// 3. **`for-in` and `for-of` are annotations, not region kinds.** See
//    docs/STRUCTURE.md "Known gaps": their head instructions
//    (`ForInEnumerate`/`ForInPrepare`/`ForInNext`/`ForInStep`, or
//    `GetIterator` + the `next`/`done` protocol) straddle block boundaries
//    that `{r:'block'}` cannot split, so emitting `{r:'forIn'}` would drop
//    whatever else lives in those blocks. The loop is emitted as an ordinary
//    loop, every block is still placed exactly once, and `loop.idiom` carries
//    the recognition for T7/T9 to use.

/**
 * Is every value defined in `blocks` consumed by the computation of
 * `valueId`? That is ARCHITECTURE.md 4.3's inlining condition, evaluated with
 * T6's `defUse` and `hasEffect` and no opcode name.
 *
 * `blocks` is the test chain (one block in the common case, more when the
 * leader rule split the condition -- see point 0 of the header comment). The
 * instruction excluded from the check is the *last* one of `testBlock`, the
 * two-way terminator itself; every other instruction of every chain block,
 * including the last instruction of the blocks before `testBlock`, has to
 * either feed the test with exactly one use or be dead and pure.
 *
 * @param {Iterable<number>} blocks
 * @param {number} testBlock
 * @param {number|null} valueId
 */
export function chainConsumedBy(ir, blocks, testBlock, valueId) {
  const inChain = new Set(blocks);
  // A valueless test is the `for-in` done check, whose operands are registers
  // rather than the accumulator: the cone is empty and the question becomes
  // "does the chain hold anything at all besides the terminator".
  const cone = new Set();
  const st = valueId === null || valueId === undefined || valueId < 0 ? [] : [valueId];
  while (st.length) {
    const id = st.pop();
    if (id === null || id === undefined || id < 0 || cone.has(id)) continue;
    const v = ir.values[id];
    if (!v || v.kind !== 'Op') continue;
    if (!inChain.has(v.block)) continue;
    cone.add(id);
    for (const i of v.inputs ?? []) st.push(i);
  }
  for (const blockId of inChain) {
    const b = ir.blocks[blockId];
    const stop = blockId === testBlock ? b.last : b.last + 1;
    for (let i = b.first; i < stop; i++) {
      const vid = ir.instructionValue[i];
      if (vid === undefined || vid < 0) continue;
      const v = ir.values[vid];
      if (!v) continue;
      const uses = ir.defUse.get(vid) ?? [];
      if (cone.has(vid)) {
        if (uses.length > 1) return false;       // would be duplicated or named
        continue;
      }
      if (!v.hasEffect && uses.length === 0) continue; // dead pure code
      return false;
    }
  }
  return true;
}

/** The one-block case, kept as its own name because that is what it reads as. */
export function blockConsumedBy(ir, blockId, valueId) {
  return chainConsumedBy(ir, [blockId], blockId, valueId);
}

/**
 * The test chain of a loop: the header, plus the run of blocks after it that
 * form one straight line with it, up to the first two-way terminator.
 *
 * A block joins the chain only when its predecessor is its *only* predecessor
 * and the edge is not a back edge, so the chain is a single-entry single-exit
 * straight line -- dominated by the header and post-dominating it by
 * construction.
 *
 * @returns {{chain:number[], testBlock:number, bodyEntry:number,
 *            follow:number}|null}
 */
export function testChainOf(ir, facts, g, header, body) {
  const chain = [header];
  const inChain = new Set(chain);
  let cur = header;
  for (let guard = 0; guard <= body.size + 1; guard++) {
    const succs = g.walkSuccs[cur];
    if (succs.length === 2) {
      const b = ir.blocks[cur];
      const last = b.instructions[b.instructions.length - 1];
      if (!last || !facts.isConditionalJump(last.opcodeValue)) return null;
      const inBody = succs.filter((s) => body.has(s));
      if (inBody.length !== 1) return null;
      // An in-body successor that is already in the chain means the "exit"
      // branch closes the loop rather than entering a body: that is a
      // `do/while` whose test sits in the latch, handled separately.
      if (inChain.has(inBody[0])) return null;
      return {
        chain, testBlock: cur, bodyEntry: inBody[0],
        follow: succs.find((s) => !body.has(s)),
      };
    }
    if (succs.length !== 1) return null;
    const next = succs[0];
    if (!body.has(next) || inChain.has(next)) return null;
    if (g.isBackEdge(cur, next)) return null;
    if (g.walkPreds[next].length !== 1 || g.walkPreds[next][0] !== cur) return null;
    chain.push(next); inChain.add(next);
    cur = next;
  }
  return null;
}

/**
 * Where control resumes after a loop, for the forms that have no test to read
 * it off.
 *
 * Ignition emits a single pass over the AST and never reorders, so the bytes
 * between the loop header and the first byte after the loop are exactly the
 * loop's source text. The follow is therefore the earliest exit target that
 * lies *after* the whole loop body -- which is also what excludes an exit that
 * is really a `throw` or a `return` written inside the body. On
 * `async-await-in-loop` the exit set is {B13, B17}: B13 is the `ReThrow` of
 * the await desugaring at offset 80, inside the body's offset span, and B17 at
 * 97 is the real exit. Picking the earliest exit by reverse postorder -- which
 * is what this replaces -- picked B13 and put the loop's own body after it.
 */
function followAfterBody(ir, g, body, exitTargets) {
  if (!exitTargets.length) return null;
  let maxOffset = -1;
  for (const b of body) {
    const o = ir.blocks[b]?.startOffset ?? -1;
    if (o > maxOffset) maxOffset = o;
  }
  let after = null, last = null;
  for (const t of exitTargets) {
    const o = ir.blocks[t]?.startOffset ?? -1;
    if (o > maxOffset && (after === null || o < ir.blocks[after].startOffset)) after = t;
    if (last === null || o > ir.blocks[last].startOffset) last = t;
  }
  return after ?? last;
}

/**
 * @param {object} ir
 * @param {object} facts   structureFacts(profile)
 * @param {object} g       the structuring graph
 */
export function planLoops(ir, facts, g) {
  const plans = new Map();
  const warnings = [];
  const stats = {
    loops: 0, while: 0, doWhile: 0, for: 0, forever: 0,
    testBlockNotConsumed: 0, multiExit: 0, multiLatch: 0, endless: 0,
    forIn: 0, forOf: 0, noFollow: 0,
    testInHeader: 0, testBelowHeader: 0, testChainBlocks: 0,
    testChainNotConsumed: 0, followAfterBody: 0,
  };

  for (const l of g.loops) {
    stats.loops++;
    const body = new Set(l.body);
    const header = l.header;
    const hb = ir.blocks[header];
    const headerSuccs = g.walkSuccs[header];
    const latches = l.latches.slice();
    if (latches.length > 1) stats.multiLatch++;

    // every target an exit edge leads to, outside the body
    const exitTargets = [];
    for (const b of body) {
      for (const s of g.walkSuccs[b]) {
        if (!body.has(s) && !exitTargets.includes(s)) exitTargets.push(s);
      }
    }
    exitTargets.sort((a, b2) => g.rpoNum[a] - g.rpoNum[b2]);
    if (exitTargets.length > 1) stats.multiExit++;
    if (!exitTargets.length) stats.endless++;

    const tc = testChainOf(ir, facts, g, header, body);

    let form = 'forever';
    let testBlock = null;
    let testChain = [];
    let bodyEntry = header;
    let follow = followAfterBody(ir, g, body, exitTargets);
    if (follow !== null && exitTargets.length > 1) stats.followAfterBody++;
    let updateBlock = null;
    let headerPlacedInBody = false;
    let testAtHeader = false;
    let afterTest = null;

    if (tc) {
      testBlock = tc.testBlock;
      testChain = tc.chain;
      bodyEntry = tc.bodyEntry;
      follow = tc.follow;
      form = 'while';
      if (tc.chain.length === 1) stats.testInHeader++;
      else { stats.testBelowHeader++; stats.testChainBlocks += tc.chain.length; }
    } else if (latches.length === 1 && latches[0] !== header) {
      // do/while: the single latch carries the test
      const lb = ir.blocks[latches[0]];
      const ls = g.walkSuccs[latches[0]];
      if (ls.length === 2 && facts.isConditionalJump(lb.instructions[lb.instructions.length - 1].opcodeValue)
        && ls.includes(header) && ls.some((s) => !body.has(s))) {
        form = 'doWhile';
        testBlock = latches[0];
        follow = ls.find((s) => !body.has(s));
        bodyEntry = header;
      }
    }

    // `for`: the single latch is a dedicated continue target that something
    // inside the body jumps to
    if (form === 'while' && latches.length === 1 && latches[0] !== header) {
      const u = latches[0];
      let inBodyPreds = 0;
      for (const p of g.walkPreds[u]) if (body.has(p)) inBodyPreds++;
      const uSuccsInBody = g.walkSuccs[u].filter((s) => body.has(s));
      if (inBodyPreds >= 2 && uSuccsInBody.length === 1 && uSuccsInBody[0] === header) {
        form = 'for';
        updateBlock = u;
      }
    }

    // the test-block gate (see the header comment)
    let test = null;
    if (testBlock !== null) {
      const vid = ir.instructionValue[ir.blocks[testBlock].last];
      const term = vid >= 0 ? ir.values[vid] : null;
      const testValue = term?.sem?.accumulator?.read ? (term.inputs?.[0] ?? null) : null;
      if ((form === 'while' || form === 'for')
        && !chainConsumedBy(ir, testChain, testBlock, testValue)) {
        // The test chain carries statements the test does not consume, so
        // `while (test)` would drop them. Two readings are left, in order.
        //
        // (a) `do { ... } while (c)`. V8 emits no backward conditional jump --
        //     every loop closes with `JumpLoop` -- so a `do/while` puts the
        //     body AND the test ahead of the back edge and leaves the latch
        //     holding nothing but the jump. From a real listing of
        //     `do { s += i; i++; } while (i < n)`:
        //
        //       B1  Ldar/Add/Mov/Star/Inc/Star/TestLessThan  JumpIfFalse -> B3
        //       B2  JumpLoop -> B1
        //
        //     So when everything between the test and the back edge is free of
        //     statements, the chain is the body and this is a `do/while`.
        //
        // (b) otherwise `forever`. For a multi-block chain that is not a
        //     degradation but the exact reading: a straight run of code with a
        //     conditional exit at the end of it is
        //     `while (true) { ...; if (x) break; ... }`, and the generic
        //     machinery produces precisely that -- the chain as ordinary
        //     blocks, the conditional as an ordinary `if`, the exit edge as a
        //     `break`. Only the single-block case needs the explicit
        //     `if (!test) break` in front of the body, because there the test
        //     IS the header's terminator.
        const tail = statementFreeTailToLatch(ir, g, { header, body, from: bodyEntry });
        if (tail.ok) {
          form = 'doWhile';
          testAtHeader = true;
          afterTest = bodyEntry;
          bodyEntry = header;
        } else if (testChain.length > 1) {
          stats.testChainNotConsumed++;
          form = 'forever';
          testBlock = null;
          testChain = [];
          bodyEntry = header;
        } else {
          stats.testBlockNotConsumed++;
          warnings.push({
            code: 'loopTestBlockNotConsumedByTest', block: testBlock, form, why: tail.why,
            message: 'the header holds a value the test does not consume and the tail after the test is not '
              + 'statement-free, so neither `while (test)` nor `do/while` can express it; the loop degrades to '
              + '`forever` with the header placed as a block and an `if (!test) break`',
          });
          form = 'forever';
          headerPlacedInBody = true;
          bodyEntry = header;
          // follow stays: it is still where the exit goes
        }
      }
      if (testBlock !== null) test = { block: testBlock, value: testValue };
    }

    const continueTarget = form === 'for' ? updateBlock
      : form === 'doWhile' ? (testAtHeader ? null : testBlock)
        : header;

    if (follow === null) stats.noFollow++;
    stats[form]++;

    const region = loopRegion(ir, g, { header, body, follow });
    const idiom = detectIdiom(ir, facts, g, { header, body, testBlock, form });
    if (idiom?.kind === 'forIn') stats.forIn++;
    if (idiom?.kind === 'forOf') stats.forOf++;

    plans.set(header, {
      loop: l, header, body, region, latches, form,
      testBlock, testChain, testValue: test?.value ?? null,
      bodyEntry, follow, updateBlock, continueTarget,
      headerPlacedInBody, testAtHeader, afterTest,
      exitTargets,
      otherExits: exitTargets.filter((t) => t !== follow),
      endless: !exitTargets.length,
      depth: l.depth,
      idiom,
      label: null,
    });
  }

  return { plans, warnings, stats };
}

/**
 * The loop's *lexical* extent, which is what the body chain is allowed to
 * emit -- and it is strictly bigger than the natural loop.
 *
 * A natural loop is "the header plus everything that can reach a latch", so a
 * block whose only exit is a `break` is NOT in it: it cannot reach the latch.
 * From a real listing of
 * `outer: for(..){ inner: for(..){ if(j===2) continue outer; if(i===2) break outer; ... } }`:
 *
 *   B3 inner header   B4 test j===2   B5 Jump -> B9 (continue outer)
 *   B6 test i===2     B7 Jump -> B10 (break outer)     B8 JumpLoop -> B3
 *
 * B5 and B7 are inside the inner loop in the source and in neither natural
 * loop body, because neither can reach a latch. Structuring the body with the
 * natural body as its bounds therefore fails on exactly the functions labelled
 * break and continue exist for.
 *
 * The extent used instead is dominance plus bytecode order: everything the
 * header dominates that lies before the follow in the bytecode. That is sound
 * for Ignition specifically, because `BytecodeGenerator` is a single pass over
 * the AST that never reorders -- the bytes between the loop header and the
 * loop's follow are exactly the loop's source text (Cifuentes' interval
 * ordering, with the emission order standing in for the DFS numbering).
 */
function loopRegion(ir, g, { header, body, follow }) {
  const out = new Set(body);
  const limit = follow === null || follow === undefined ? null : ir.blocks[follow]?.startOffset ?? null;
  const headerOffset = ir.blocks[header].startOffset;
  for (const b of ir.blocks) {
    if (g.removedBlocks.has(b.id) || !g.reachable(b.id)) continue;
    if (b.id === follow) continue;
    if (!g.dom.dominates(header, b.id)) continue;
    if (limit !== null && limit > headerOffset && b.startOffset >= limit) continue;
    out.add(b.id);
  }
  return out;
}

/**
 * Is everything between a header-resident test and the back edge free of
 * statements? That is the condition for reading the loop as a `do/while` whose
 * body is the header block: those blocks are still placed, so if they hold
 * nothing observable their position relative to the test cannot matter.
 */
function statementFreeTailToLatch(ir, g, { header, body, from }) {
  let cur = from;
  for (let guard = 0; guard <= body.size; guard++) {
    if (cur === undefined || cur === null) return { ok: false, why: 'noInLoopSuccessor' };
    if (cur === header) return { ok: true };
    if (!body.has(cur)) return { ok: false, why: 'tailLeavesTheLoop' };
    const b = ir.blocks[cur];
    for (let i = b.first; i < b.last; i++) {
      const vid = ir.instructionValue[i];
      if (vid === undefined || vid < 0) continue;
      const v = ir.values[vid];
      if (v && v.kind === 'Op' && v.hasEffect) return { ok: false, why: 'tailHasAnEffect' };
    }
    const succs = g.walkSuccs[cur];
    if (succs.length !== 1) return { ok: false, why: 'tailBranches' };
    cur = succs[0];
  }
  return { ok: false, why: 'tailDidNotReachTheHeader' };
}

/**
 * `for-in` / `for-of` recognition. Annotation only; see the header comment and
 * docs/STRUCTURE.md "Known gaps".
 */
function detectIdiom(ir, facts, g, { header, body, testBlock }) {
  const hb = ir.blocks[header];
  const lastIns = hb.instructions[hb.instructions.length - 1];

  // for-in: the header's terminator IS the for-in done test. That is a
  // derivation, not a name match: `JumpIfForInDone` is the one conditional
  // jump of either profile that does not read the accumulator, and facts.mjs
  // asserts that correspondence against the profile.
  if (facts.predicateOf(lastIns.opcodeValue)?.kind === 'forInDone') {
    const found = { prepare: null, enumerate: null, next: null, step: null, index: null, subject: null };
    const scan = (blockId) => {
      const b = ir.blocks[blockId];
      for (let i = b.first; i <= b.last; i++) {
        const vid = ir.instructionValue[i];
        if (vid < 0) continue;
        const v = ir.values[vid];
        if (!v || v.kind !== 'Op') continue;
        if (v.op === facts.op.forInPrepare) found.prepare = v.id;
        else if (v.op === facts.op.forInEnumerate) { found.enumerate = v.id; found.subject = v.inputs?.[0] ?? null; }
        else if (v.op === facts.op.forInNext) found.next = v.id;
        else if (v.op === facts.op.forInStep) found.step = v.id;
      }
    };
    for (const b of body) scan(b);
    for (const p of g.walkPreds[header]) if (!body.has(p)) scan(p);
    if (found.next !== null || found.prepare !== null) {
      const term = ir.values[ir.instructionValue[hb.last]];
      return {
        kind: 'forIn', confidence: found.prepare !== null && found.next !== null ? 'exact' : 'shape',
        ...found,
        key: found.next,
        doneInputs: term?.inputs?.slice() ?? [],
        headerBlock: header, testBlock,
      };
    }
  }

  // for-of: an iterator obtained before the loop and consumed inside it. This
  // one is genuinely a shape guess -- T7's `forOf` pattern is authoritative --
  // so it is labelled `shape` and nothing structural depends on it.
  for (const v of ir.values) {
    if (!v || v.kind !== 'Op' || v.op !== facts.op.getIterator) continue;
    if (v.block === undefined || v.block === null) continue;
    if (body.has(v.block)) continue;
    if (!g.dom.dominates(v.block, header)) continue;
    const consumedInLoop = (ir.defUse.get(v.id) ?? []).some((u) => {
      const uv = ir.values[u];
      return uv && uv.block !== undefined && body.has(uv.block);
    });
    const viaProjection = (v.projections ?? []).some((p) => (ir.defUse.get(p) ?? []).some((u) => {
      const uv = ir.values[u];
      return uv && uv.block !== undefined && body.has(uv.block);
    }));
    if (consumedInLoop || viaProjection) {
      return { kind: 'forOf', confidence: 'shape', iterator: v.id, iteratorBlock: v.block, headerBlock: header };
    }
  }
  return null;
}

export default { planLoops, blockConsumedBy };
