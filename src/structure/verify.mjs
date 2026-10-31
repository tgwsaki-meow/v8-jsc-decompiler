// src/structure/verify.mjs
//
// The invariants of a `StructuredFunction`, asserted on every function by the
// CLI, the self-test and the corpus scan so all three check the same thing.
//
// The first one is ARCHITECTURE.md 11.3 invariant 1, which is the whole point:
//
//   every reachable, non-`removed` block appears exactly ONCE in the region
//   tree -- as a `{r:'block'}` leaf or inside an `{r:'unstructured'}` region
//
// A block that appears twice means T9 emits its statements twice; a block that
// appears nowhere means they are lost. Both are silent, which is why the check
// is total rather than sampled. `removed` carries three kinds of block, each
// with a reason the statements are not lost:
//
//   generatorDispatchers      the dispatch instruction is control flow and
//                             nothing else (checked: the block holds exactly
//                             that one instruction, or it is kept)
//   asyncHandlerBlocks        the implicit promise rejection tail, which the
//                             `async` keyword itself implies
//   loopTestBlocks            the loop condition: every value in the block
//                             feeds the test with exactly one use, which is
//                             the condition ARCHITECTURE.md 4.3 inlines on, so
//                             T7 produces no statement for it (gated in
//                             loops.mjs, and the gate failing degrades the
//                             loop form instead of dropping the block)

export function walkRegions(root, visit, path = []) {
  if (!root) return;
  visit(root, path);
  const p = [...path, root];
  switch (root.r) {
    case 'seq': for (const x of root.body) walkRegions(x, visit, p); break;
    case 'if': walkRegions(root.then, visit, p); walkRegions(root.else, visit, p); break;
    case 'loop': walkRegions(root.init, visit, p); walkRegions(root.update, visit, p); walkRegions(root.body, visit, p); break;
    case 'forIn': case 'forOf': walkRegions(root.body, visit, p); break;
    case 'switch': for (const c of root.cases) walkRegions(c.body, visit, p); break;
    case 'try': walkRegions(root.block, visit, p); walkRegions(root.handler, visit, p); walkRegions(root.finalizer, visit, p); break;
    case 'labeled': walkRegions(root.body, visit, p); break;
    default: break;
  }
}

const REGION_KINDS = new Set([
  'seq', 'block', 'if', 'loop', 'forIn', 'forOf', 'switch', 'try', 'labeled',
  'break', 'continue', 'unstructured',
]);

/** Everything the tree says, collected in one pass. */
export function summarise(sf) {
  const blockLeaves = [];
  const unstructuredBlocks = [];
  const loopHeaders = new Set();
  const loopForms = {};
  const tryHandlerIndices = new Set();
  const switchForms = {};
  const tests = [];
  const labelsUsed = new Set();
  const labelsDeclared = new Set(sf.labels.map((l) => l.id));
  const unstructured = [];
  const unknownKinds = [];
  let regionCount = 0;

  walkRegions(sf.root, (r) => {
    regionCount++;
    if (!REGION_KINDS.has(r.r)) { unknownKinds.push(r.r); return; }
    switch (r.r) {
      case 'block': blockLeaves.push(r.id); break;
      case 'unstructured': unstructured.push(r); for (const b of r.blocks) unstructuredBlocks.push(b); break;
      case 'if': tests.push(r.test); break;
      case 'loop':
        loopHeaders.add(r.header);
        loopForms[r.form] = (loopForms[r.form] ?? 0) + 1;
        if (r.test) tests.push(r.test);
        if (r.label) labelsDeclared.add(r.label);
        break;
      case 'switch':
        switchForms[r.form] = (switchForms[r.form] ?? 0) + 1;
        tests.push(r.disc);
        for (const c of r.cases) if (c.test) tests.push(c.test);
        if (r.label) labelsDeclared.add(r.label);
        break;
      case 'try': tryHandlerIndices.add(r.handlerIndex); break;
      case 'labeled': labelsDeclared.add(r.label); break;
      case 'break': case 'continue': if (r.label) labelsUsed.add(r.label); break;
      default: break;
    }
  });

  return {
    blockLeaves, unstructuredBlocks, loopHeaders, loopForms, tryHandlerIndices,
    switchForms, tests, labelsUsed, labelsDeclared, unstructured, unknownKinds, regionCount,
  };
}

/**
 * @param {object} sf   a StructuredFunction
 * @returns {{checks: Array<{name, violations, total, samples}>, summary: object}}
 */
export function verifyStructure(sf) {
  const { ir } = sf;
  const s = summarise(sf);
  const checks = [];
  const add = (name, violations, total, samples = []) => checks.push({ name, violations, total, samples: samples.slice(0, 3) });

  // ---- 1. coverage: every reachable, non-removed block exactly once
  const removed = new Set([
    ...sf.removed.generatorDispatchers.filter((d) => d.blockRemoved).map((d) => d.block),
    ...(sf.removed.asyncHandlerBlocks ?? []),
    ...(sf.removed.loopTestBlocks ?? []).map((t) => t.block),
  ]);
  const want = new Set();
  for (const b of ir.blocks) {
    if (!ir.dominators.reachable(b.id)) continue;      // includes exception edges, as 11.3 means
    if (removed.has(b.id)) continue;
    want.add(b.id);
  }
  const seen = new Map();
  for (const b of [...s.blockLeaves, ...s.unstructuredBlocks]) seen.set(b, (seen.get(b) ?? 0) + 1);
  const missing = [...want].filter((b) => !seen.has(b));
  const twice = [...seen.entries()].filter(([, c]) => c > 1).map(([b, c]) => ({ block: b, times: c }));
  const extra = [...seen.keys()].filter((b) => !want.has(b));
  add('every reachable non-removed block appears exactly once', missing.length + twice.length + extra.length, want.size,
    [...missing.map((b) => ({ block: b, problem: 'missing' })), ...twice, ...extra.map((b) => ({ block: b, problem: 'placedButRemovedOrUnreachable' }))]);

  // ---- 2. no `try` for an await desugaring (11.2 constraint 3)
  const asyncSet = new Set(sf.removed.asyncHandlerRanges);
  const badTry = [...s.tryHandlerIndices].filter((i) => asyncSet.has(i));
  add('no try region for an ASYNC_AWAIT handler range', badTry.length, s.tryHandlerIndices.size,
    badTry.map((i) => ({ handler: i, prediction: ir.handlers[i]?.predictionName })));

  // ---- 3. every Test names a real SSA value, or says it has none
  const badTests = [];
  for (const t of s.tests) {
    if (!t) continue;
    if (t.value === null || t.value === undefined) { if (!t.valueless && t.predicate !== 'value') badTests.push(t); continue; }
    if (t.value < 0 || t.value >= ir.values.length || !ir.values[t.value]) badTests.push(t);
  }
  add('every Test.value is a real SSA value or is flagged valueless', badTests.length, s.tests.length,
    badTests.map((t) => ({ block: t.block, value: t.value, predicate: t.predicate, opcode: t.opcode })));

  // ---- 4. labels
  const undeclared = [...s.labelsUsed].filter((l) => !s.labelsDeclared.has(l));
  add('every labelled break/continue names a declared label', undeclared.length, s.labelsUsed.size,
    undeclared.map((l) => ({ label: l })));

  // ---- 5. loop regions sit on real loop headers
  const badLoops = [...s.loopHeaders].filter((h) => !sf.loopHeaders.has(h));
  add('every loop region is rooted at a natural loop header', badLoops.length, s.loopHeaders.size,
    badLoops.map((h) => ({ header: h })));

  // ---- 6. region kinds
  add('every region kind is in the 11.2 vocabulary', s.unknownKinds.length, s.regionCount,
    s.unknownKinds.map((k) => ({ kind: k })));

  // ---- 7. a single-block function is a single `{r:'block'}`
  const reachable = ir.blocks.filter((b) => ir.dominators.reachable(b.id)).length;
  let trivialViolation = 0;
  if (reachable === 1 && removed.size === 0) {
    if (!(sf.root && sf.root.r === 'block' && sf.root.id === ir.entry)) trivialViolation = 1;
  }
  add('a single-block function is one {r:block} leaf', trivialViolation, reachable === 1 ? 1 : 0,
    trivialViolation ? [{ root: sf.root?.r, blocks: reachable }] : []);

  // ---- 8. the structuring graph is reducible after stage 1
  add('the structuring graph has no irreducible edge after the dispatcher is removed',
    sf.stats.irreducibleAfterRemoval, 1,
    sf.stats.irreducibleAfterRemovalDetail ?? []);

  return { checks, summary: s };
}

export default { verifyStructure, summarise, walkRegions };
