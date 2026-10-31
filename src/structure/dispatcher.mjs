// src/structure/dispatcher.mjs
//
// STAGE 1: delete the `SwitchOnGeneratorState` resume dispatcher.
//
// Why this is stage 1 and not an afterthought
// -------------------------------------------
// ARCHITECTURE.md 10.1 / docs/IR.md section 9, measured over all 239 979
// corpus functions:
//
//   irreducible retreating edges                                 163
//   functions containing one                121 (0.0504%), 80 async, 42 generator
//   functions that are neither async nor a generator               0
//   functions still irreducible once the resume edges are removed   0
//
// Every irreducible function in the corpus is irreducible *because of* the
// entry dispatcher jumping into the middle of a loop body, and nothing else.
// So the order is the whole fix: remove the dispatcher, then structure loops.
// The other way round needs a goto-elimination pass for 121 functions and
// still gets the loops wrong.
//
// And the dual measurement, docs/IR.md section 9's `JumpLoop` table:
//
//   a back edge (target dominates source)        18 201   97.91%
//   in an irreducible region                        130    0.70%
//   a forward edge, cycle broken by a suspend       259    1.39%
//
// The third row is 243 functions where `await` sits inside a loop: the body
// ends in `SuspendGenerator`, which *returns*, so one invocation's CFG is
// acyclic and there is no back edge to find at all. For those, "find the loop"
// is not a CFG question until the suspend is reconnected to its resume.
//
// What "delete the dispatcher" means precisely
// --------------------------------------------
//   1. drop every resume edge (`edge.kind === 'switch' && edge.generatorResume`);
//   2. splice each `SuspendGenerator` block to its matching `ResumeGenerator`
//      block, because that is the control flow of the source: `await e` runs
//      e, suspends, and continues at the next statement. This both restores
//      the loop in the 243 `await`-in-a-loop functions and removes the second
//      entry that made 121 functions irreducible;
//   3. drop the dispatcher block itself and start at its fall-through, which
//      is the first-call path.
//
// The pairing is read from T6's `ir.contextChain.suspendByIdIns` (suspend id ->
// instruction index) and `suspendOfResume`, as ARCHITECTURE.md 11.2 constraint
// 1 requires -- not guessed from opcodes. The one invariant that has to hold
// for the splice to be sound is V8's own emission order:
//
//     builder()->SuspendGenerator(generator_object(), registers, suspend_id);
//     builder()->Bind(generator_jump_table_, suspend_id);
//     builder()->ResumeGenerator(generator_object(), registers);
//                              -- BytecodeGenerator::BuildSuspendPoint
//
// so the resume for suspend id j is the instruction immediately after the
// suspend carrying j, and the table entry for case j targets it. That is
// checked per splice and reported as `resumeEdgeNotAfterSuspend` when it does
// not hold, in which case the resume edge is kept and nothing is spliced.

/**
 * @param {object} ir
 * @param {object} facts   structureFacts(profile)
 * @returns {{removedBlocks:Set<number>, removedEdges:Set<number>, splices:Array,
 *            entry:number, dispatchers:Array, warnings:Array, stats:object}}
 */
export function planDispatcherRemoval(ir, facts) {
  const removedBlocks = new Set();
  const removedEdges = new Set();
  const splices = [];
  const dispatchers = [];
  const warnings = [];
  let entry = ir.entry;
  const stats = {
    dispatchers: 0, dispatcherBlocksRemoved: 0, dispatcherBlocksKept: 0,
    resumeEdgesRemoved: 0, splices: 0, unsplicedResumeEdges: 0,
    suspendPoints: ir.contextChain?.suspendByIdIns?.size ?? 0,
    unpairedResumes: ir.contextChain?.unpairedResumes ?? 0,
  };

  const dispatchBlocks = ir.blocks.filter((b) => b.isGeneratorDispatch && ir.dominators.reachable(b.id));
  if (!dispatchBlocks.length) return { removedBlocks, removedEdges, splices, entry, dispatchers, warnings, stats };

  const suspendByIdIns = ir.contextChain?.suspendByIdIns ?? new Map();
  const blockOfInstruction = ir.cfg.blockOfInstruction;

  for (const d of dispatchBlocks) {
    stats.dispatchers++;
    const resumeEdges = [];
    const mySplices = [];
    let fallThrough = null;

    for (const eid of d.outEdges) {
      const e = ir.edges[eid];
      if (e.kind === 'switch' && e.generatorResume) { resumeEdges.push(e); continue; }
      if (e.kind === 'fallthrough') fallThrough = e.to;
    }

    for (const e of resumeEdges) {
      const suspendIns = suspendByIdIns.get(e.caseValue);
      if (suspendIns === undefined) {
        warnings.push({
          code: 'resumeEdgeWithoutSuspend', block: d.id, edge: e.id, caseValue: e.caseValue,
          message: 'the dispatcher has a jump-table entry for a suspend id T6 never saw a SuspendGenerator for, '
            + 'so there is nothing to splice it to; the edge is kept',
        });
        stats.unsplicedResumeEdges++;
        continue;
      }
      const suspendBlock = blockOfInstruction[suspendIns];
      const afterSuspend = blockOfInstruction[suspendIns + 1];
      if (afterSuspend !== e.to) {
        warnings.push({
          code: 'resumeEdgeNotAfterSuspend', block: d.id, edge: e.id, caseValue: e.caseValue,
          suspendBlock, expected: afterSuspend, actual: e.to,
          message: 'BuildSuspendPoint binds the jump-table entry to the instruction right after the suspend; '
            + 'this table entry points elsewhere, so the suspend is not spliced and the resume edge is kept',
        });
        stats.unsplicedResumeEdges++;
        continue;
      }
      removedEdges.add(e.id);
      stats.resumeEdgesRemoved++;
      mySplices.push({
        from: suspendBlock, to: e.to, why: 'suspendToResume',
        suspendInstruction: suspendIns, suspendId: e.caseValue, resumeBlock: e.to, dispatcher: d.id,
      });
    }

    // The dispatcher block only exists to route a re-entry. Drop it when it is
    // nothing but the dispatch instruction -- otherwise its other instructions
    // would be lost, so the block is kept as an ordinary leaf (it then falls
    // straight through to the first-call path, which is what is left of it
    // once the resume edges are gone).
    const onlyTheDispatch = d.instructions.length === 1;
    const hasNormalPreds = d.normalPreds.length > 0;
    if (onlyTheDispatch && !hasNormalPreds && fallThrough !== null) {
      removedBlocks.add(d.id);
      stats.dispatcherBlocksRemoved++;
      if (entry === d.id) entry = fallThrough;
    } else {
      stats.dispatcherBlocksKept++;
      warnings.push({
        code: 'dispatcherBlockKept', block: d.id,
        instructions: d.instructions.length, normalPreds: d.normalPreds.length, fallThrough,
        message: onlyTheDispatch
          ? (fallThrough === null
            ? 'the dispatcher has no fall-through (no first-call path), so removing the block would drop control flow'
            : 'the dispatcher block has normal predecessors, so removing it would drop their edges')
          : 'the dispatcher block holds instructions besides the dispatch, which would be lost if it were removed',
      });
    }

    for (const s of mySplices) splices.push(s);
    stats.splices += mySplices.length;
    dispatchers.push({
      block: d.id,
      resumeEdges: resumeEdges.map((e) => e.id),
      removedResumeEdges: resumeEdges.filter((e) => removedEdges.has(e.id)).map((e) => e.id),
      blockRemoved: removedBlocks.has(d.id),
      fallThrough,
      splices: mySplices,
    });
  }

  return { removedBlocks, removedEdges, splices, entry, dispatchers, warnings, stats };
}

export default { planDispatcherRemoval };
