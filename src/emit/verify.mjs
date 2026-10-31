// src/emit/verify.mjs
//
// ARCHITECTURE.md 11.3's six join invariants, asserted on EVERY function.
//
// Four of the six are statements about the two input trees and two are
// statements about the OUTPUT. The difference matters and is the reason this
// file exists rather than a note in the report: T7 measured "0 values emitted
// twice outside `duplicable`" and "0 occurrences of `ctx`" on its own output,
// and those are promises about what T7 PRODUCED. Invariant 4 and invariant 5
// are about what T9 EMITTED, so both are checked on the Babel AST this layer
// built, where a bug in this layer can still show up.
//
//   1  coverage        every reachable, non-`removed` block appears exactly
//                      once -- as a `{r:'block'}` leaf or inside an
//                      `{r:'unstructured'}` region. All FIVE kinds of
//                      `removed` are accounted for: the three that name
//                      blocks (`generatorDispatchers`, `asyncHandlerBlocks`,
//                      `loopTestBlocks`) are subtracted, and the two that name
//                      handler RANGES (`asyncHandlerRanges`,
//                      `skippedHandlerRanges`) are checked separately --
//                      `asyncHandlerRanges` must own no `try` (11.2
//                      constraint 3) and a `skippedHandlerRange`'s handler
//                      block must still be covered, which is the exact failure
//                      docs/STRUCTURE.md 1 describes (`rangeEntryUnreachable`
//                      made three blocks vanish silently).
//
//   2  join solvable   every `Test.value` / `Target.value` the tree mentions
//                      has an entry in `recovered.exprs`. A miss is a T7 gap
//                      and becomes a counted hole, never silence.
//
//   3  statement       a placed block's statements are emitted exactly once.
//      uniqueness      Checked by counting what stmt.mjs actually emitted per
//                      block against `recovered.stmts.get(block).length`, and
//                      by requiring that a `removed` block contributed no
//                      statement -- which is the half of invariant 3 only T9
//                      can check (docs/STRUCTURE.md 9.5).
//
//   4  no re-evaluation  an `ssaId` appears more than once in the output IFF
//                      it is in `recovered.duplicable`. Measured on the T7
//                      Expr OBJECTS this layer reached: T7 memoises one object
//                      per value, so a second visit is a second emission. A
//                      shared object can stand for several values when a
//                      pattern aliases them (docs/RECOVER.md 2.2), so it is a
//                      violation only when NONE of those values is duplicable.
//
//   5  `ctx` absent    no Identifier named `ctx` anywhere in the emitted AST.
//                      Baseline: 1 710 336 occurrences.
//
//   6  holes counted   every hole and every unstructured region is both
//                      counted in the report and visible in the text. Checked
//                      by counting the `HOLE`/`UNSTRUCTURED` markers in the
//                      AST against the report's own total, so a hole that was
//                      counted but not rendered fails just as loudly as one
//                      rendered but not counted.

import { walkRegions } from '../structure/verify.mjs';
import { BANNED_IDENTIFIER } from './names.mjs';

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'tokens']);
const COMMENT_KEYS = ['leadingComments', 'innerComments', 'trailingComments'];

/** A generic Babel AST walk. @babel/traverse is a devDependency, so not here. */
export function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walkAst(x, visit); return; }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const k in node) {
    if (SKIP_KEYS.has(k) || COMMENT_KEYS.includes(k)) continue;
    const v = node[k];
    if (v && typeof v === 'object') walkAst(v, visit);
  }
}

const FUNCTION_LIKE = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);

/**
 * The same walk, stopping at a NESTED function.
 *
 * Functions are emitted nested (index.mjs), so a per-function check has to
 * look at that function's own text and not at its children's -- otherwise one
 * hole in a closure is counted once in the closure's report and again in
 * every ancestor's marker count, and a name a closure declares looks
 * undeclared to the parent.
 */
export function walkOwn(root, visit, depth = 0) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) { for (const x of root) walkOwn(x, visit, depth); return; }
  if (typeof root.type !== 'string') return;
  if (depth > 0 && FUNCTION_LIKE.has(root.type)) return;
  visit(root);
  for (const k in root) {
    if (SKIP_KEYS.has(k) || COMMENT_KEYS.includes(k)) continue;
    const v = root[k];
    if (v && typeof v === 'object') walkOwn(v, visit, depth + 1);
  }
}

/** Every comment attached in a subtree, not counting nested functions. */
export function commentsOf(root) {
  const out = [];
  walkOwn(root, (n) => {
    for (const k of COMMENT_KEYS) for (const c of n[k] ?? []) out.push(c.value ?? '');
  });
  return out;
}

/**
 * Every Identifier in a VARIABLE position, not counting nested functions.
 *
 * Invariant 5 is about the identifier `ctx` as a NAME: the baseline's
 * 1 710 336 occurrences were free references to a context object the old
 * emitter invented. A property called `ctx` is not that -- `o.ctx` and
 * `{ctx: 1}` are recovered source, and `names.mjs::sanitise` guarantees no
 * variable can be spelled that way. Measured: without this distinction
 * `r_23495.jsc` #146 `setup$2` reported one violation for a member access on a
 * property the original program really does call `ctx`.
 */
export function variableIdentifiers(root) {
  const out = [];
  const skip = new Set();
  walkOwn(root, (n) => {
    switch (n.type) {
      case 'MemberExpression': case 'OptionalMemberExpression':
        if (!n.computed) skip.add(n.property);
        break;
      case 'ObjectProperty': case 'ObjectMethod': case 'ClassMethod':
      case 'ClassProperty': case 'ClassPrivateMethod':
        if (!n.computed && n.key) skip.add(n.key);
        break;
      case 'MetaProperty':
        skip.add(n.meta); skip.add(n.property);
        break;
      case 'LabeledStatement':
        skip.add(n.label);
        break;
      case 'BreakStatement': case 'ContinueStatement':
        if (n.label) skip.add(n.label);
        break;
      default: break;
    }
    if (n.type === 'Identifier' && !skip.has(n)) out.push(n);
  });
  // A key can be visited before its parent in no case here (the parent is
  // always visited first), so one pass is enough.
  return out.filter((n) => !skip.has(n));
}

/** Collect the Tests and Targets a region tree mentions. */
export function joinPoints(sf) {
  const tests = [];
  const targets = [];
  walkRegions(sf.root, (r) => {
    switch (r.r) {
      case 'if': tests.push({ test: r.test, where: 'if' }); break;
      case 'loop': if (r.test) tests.push({ test: r.test, where: `loop:${r.form}` }); break;
      case 'switch':
        tests.push({ test: r.disc, where: 'switch:disc' });
        for (const c of r.cases ?? []) if (c.test) tests.push({ test: c.test, where: 'switch:case' });
        break;
      case 'try': if (r.param) targets.push({ target: r.param, where: `try:${r.handlerIndex}` }); break;
      case 'forIn': case 'forOf':
        if (r.left) targets.push({ target: r.left, where: r.r });
        if (r.right) tests.push({ test: r.right, where: r.r });
        break;
      default: break;
    }
  });
  return { tests, targets };
}

/**
 * @param {object} args
 * @param {object} args.rec   RecoveredFunction
 * @param {object} args.sf    StructuredFunction
 * @param {object} args.ast   the Babel node this function was emitted as
 * @param {object} args.ctx   the per-function emit context
 */
export function verifyEmitted({ rec, sf, ast, ctx }) {
  const ir = sf.ir;
  const checks = [];
  const add = (id, name, violations, total, samples = []) => checks.push({
    id, name, violations, total, samples: samples.slice(0, 3),
  });

  // ------------------------------------------------------------ 1. coverage
  const removedBlocks = new Set([
    ...(sf.removed.generatorDispatchers ?? []).filter((d) => d.blockRemoved).map((d) => d.block),
    ...(sf.removed.asyncHandlerBlocks ?? []),
    ...(sf.removed.loopTestBlocks ?? []).map((x) => x.block),
  ]);
  const want = new Set();
  for (const b of ir.blocks) {
    if (!ir.dominators.reachable(b.id)) continue;
    if (removedBlocks.has(b.id)) continue;
    want.add(b.id);
  }
  const seen = new Map();
  walkRegions(sf.root, (r) => {
    if (r.r === 'block') seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    else if (r.r === 'unstructured') for (const b of r.blocks ?? []) seen.set(b, (seen.get(b) ?? 0) + 1);
  });
  const missing = [...want].filter((b) => !seen.has(b));
  const twice = [...seen.entries()].filter(([, c]) => c > 1).map(([b, c]) => ({ block: b, times: c }));
  const extra = [...seen.keys()].filter((b) => !want.has(b));
  add(1, 'coverage: every reachable non-removed block exactly once',
    missing.length + twice.length + extra.length, want.size,
    [...missing.map((b) => ({ block: b, problem: 'missing' })), ...twice,
      ...extra.map((b) => ({ block: b, problem: 'placedButRemovedOrUnreachable' }))]);

  // the two `removed` kinds that name handler RANGES, not blocks
  const asyncRanges = new Set(sf.removed.asyncHandlerRanges ?? []);
  const tryIndices = new Set();
  walkRegions(sf.root, (r) => { if (r.r === 'try') tryIndices.add(r.handlerIndex); });
  const asyncTries = [...tryIndices].filter((i) => asyncRanges.has(i));
  add('1b', 'no try emitted for an ASYNC_AWAIT handler range', asyncTries.length, tryIndices.size,
    asyncTries.map((i) => ({ handler: i })));
  const skipped = sf.removed.skippedHandlerRanges ?? [];
  const skippedUncovered = [];
  for (const s of skipped) {
    const hb = s.handlerBlock ?? (ir.handlers[s.index]?.handlerOffset !== undefined
      ? ir.blockAtOffset?.(ir.handlers[s.index].handlerOffset) ?? null : null);
    if (hb === null || hb === undefined) continue;
    if (!seen.has(hb) && !removedBlocks.has(hb) && ir.dominators.reachable(hb)) {
      skippedUncovered.push({ range: s.index, why: s.why, handlerBlock: hb });
    }
  }
  add('1c', 'a skipped handler range leaves no block uncovered', skippedUncovered.length, skipped.length, skippedUncovered);

  // ------------------------------------------------------- 2. join solvable
  const { tests, targets } = joinPoints(sf);
  const unresolved = [];
  for (const { test, where } of tests) {
    if (!test) continue;
    if (test.valueless) {
      for (const v of test.values ?? []) if (!rec.exprs.has(v)) unresolved.push({ where, value: v, predicate: test.predicate });
      continue;
    }
    if (test.value === null || test.value === undefined) { unresolved.push({ where, value: null, predicate: test.predicate }); continue; }
    if (!rec.exprs.has(test.value)) unresolved.push({ where, value: test.value, predicate: test.predicate });
  }
  for (const { target, where } of targets) {
    if (!target) continue;
    const v = target.value ?? target.slotValue;
    if (v === null || v === undefined || !rec.exprs.has(v)) unresolved.push({ where, value: v ?? null, target: true });
  }
  add(2, 'join solvable: every Test/Target value has an exprs entry',
    unresolved.length, tests.length + targets.length, unresolved);

  // ------------------------------------------------- 3. statement uniqueness
  const stmtProblems = [];
  for (const [bid, count] of ctx.blockStatementCounts) {
    const have = rec.stmts.get(bid)?.length ?? 0;
    if (count !== have) stmtProblems.push({ block: bid, emitted: count, available: have });
  }
  for (const [bid, times] of ctx.blockEmitCounts) {
    if (times > 1) stmtProblems.push({ block: bid, problem: 'blockEmittedTwice', times });
  }
  // 11.3 invariant 3's other half, and the one only T9 can check
  // (docs/STRUCTURE.md 9.5): `removed` is a CLAIM that T7 produces no
  // statement for that block. A declaration with no initialiser emits nothing
  // -- its name is in the prologue -- so it is not a loss; anything else is,
  // unless this layer emitted the block anyway (region.mjs's materialised
  // loop-test chain).
  const droppedOnRemoved = [];
  const emittedAnyway = [];
  for (const b of removedBlocks) {
    const list = rec.stmts.get(b);
    if (!list || !list.length) continue;
    const effective = list.filter(producesOutput);
    if (ctx.blockEmitCounts.has(b)) {
      emittedAnyway.push({ block: b, statements: list.length });
      continue;
    }
    if (!effective.length) continue;
    droppedOnRemoved.push({ block: b, statements: effective.length, tags: effective.map((s) => s.s) });
  }
  add(3, 'statement uniqueness: every statement of a placed block emitted once',
    stmtProblems.length, ctx.blockStatementCounts.size, stmtProblems);
  add('3b', 'a removed block contributed no statement that was dropped',
    droppedOnRemoved.length, removedBlocks.size, droppedOnRemoved);

  // Not one of the six, but the measurement that tells whether a dropped
  // definition went unnoticed: a name read in the emitted text that nothing in
  // the same function ever writes. Reported, never fatal.
  const unwritten = readButNeverWritten(ast, ctx.boundNames);
  add('3c', 'no local name is read without ever being written', unwritten.length, unwritten.total,
    unwritten.slice(0, 3).map((n) => ({ name: n })));

  // -------------------------------------------------- 4. no re-evaluation
  //
  // One narrow exemption, stated rather than hidden: a shared `{e:'name'}`
  // object. Invariant 4 exists to stop a value being EVALUATED twice -- that
  // is what metrics 6 and 7 measure, a side-effecting call run again or an
  // allocation's identity lost. Reading a variable twice evaluates nothing,
  // which is exactly why T7 puts every materialised value in `duplicable`
  // (docs/RECOVER.md 2). Measured on `r_25918.jsc` #54
  // `setMainShortcutsReminder`: four values resolve to one
  // `{e:'name'}` object that T7 did NOT add to `duplicable`, and both reads
  // are plain identifier reads. So those are counted as `namesReadTwice` and
  // reported next to the invariant instead of inside it; anything with
  // structure -- a call, an allocation, an operator -- is still a violation.
  const dup = [];
  const nameReads = [];
  for (const [obj, count] of ctx.visitCounts) {
    if (count <= 1) continue;
    const ids = ctx.exprOwners.get(obj);
    if (!ids || !ids.length) { ctx.report.sharedExprWithNoValue++; continue; }
    if (ids.some((id) => rec.duplicable.has(id))) continue;
    const row = { values: ids.slice(0, 4), times: count, tag: obj.e };
    if (obj.e === 'name') nameReads.push(row); else dup.push(row);
  }
  ctx.report.namesReadTwice += nameReads.length;
  add(4, 'no value emitted twice outside `duplicable`', dup.length, ctx.visitCounts.size, dup);
  add('4b', 'a shared `{e:name}` read more than once (re-evaluates nothing)',
    0, nameReads.length, nameReads.slice(0, 3));

  // -------------------------------------------------------- 5. `ctx` absent
  const names = variableIdentifiers(ast);
  const banned = names.filter((n) => n.name === BANNED_IDENTIFIER);
  add(5, 'the identifier `ctx` does not occur in the output as a variable',
    banned.length, names.length, banned.slice(0, 3).map((n) => ({ name: n.name })));

  // ------------------------------------------------------- 6. holes counted
  const comments = commentsOf(ast);
  const markerTexts = comments.filter((c) => /^\s*(HOLE|UNSTRUCTURED)\b/.test(c));
  const markers = markerTexts.length;
  const counted = ctx.report.holes.total;
  add(6, 'every hole is counted and visible', markers === counted ? 0 : 1, counted,
    markers === counted ? [] : [{
      countedInReport: counted, markersInTheAst: markers,
      texts: markerTexts.slice(0, 3).map((s) => s.trim().slice(0, 80)),
      countedWhy: Object.keys(ctx.report.holes.byWhy),
    }]);

  const violations = checks
    .filter((c) => c.id !== '3c')                 // a measurement, not an invariant
    .reduce((a, c) => a + c.violations, 0);
  return {
    checks, violations, droppedOnRemoved, unresolved, duplicated: dup,
    emittedAnyway, readButNeverWritten: unwritten,
  };
}

/** Does this Stmt produce any text? A declarator with no initialiser does not. */
function producesOutput(s) {
  if (!s) return false;
  if (s.s !== 'decl') return true;
  return (s.decls ?? []).some((d) => d.init !== null && d.init !== undefined);
}

/**
 * Names the emitted function declares, reads, and never writes.
 *
 * A dropped definition shows up here and nowhere else: the name is declared
 * (so 11.3 invariant 5 still holds and nothing is free) but it reads
 * `undefined` for the rest of the function. Scope-free on purpose -- one
 * function's text, one name set -- which is sound because names.mjs declares
 * every local at the top of the body and T7's naming is unique per function.
 */
export function readButNeverWritten(ast, alreadyBound = []) {
  const declared = new Set();
  const written = new Set();
  const read = new Map();
  const bound = new Set(alreadyBound);
  walkOwn(ast, (n) => {
    switch (n.type) {
      case 'VariableDeclarator':
        if (n.id?.type === 'Identifier') {
          declared.add(n.id.name);
          if (n.init) written.add(n.id.name);
        }
        break;
      case 'AssignmentExpression':
        if (n.left?.type === 'Identifier') written.add(n.left.name);
        break;
      case 'UpdateExpression':
        if (n.argument?.type === 'Identifier') written.add(n.argument.name);
        break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        // the root of this walk, or a nested one walkOwn stops at: either way
        // its own id and parameters are bindings, not undefined reads
        if (n.id) bound.add(n.id.name);
        for (const p of n.params ?? []) collectBound(p, bound);
        break;
      case 'VariableDeclaration':
        // `var f = () => {}` -- the arrow binds the name
        for (const d of n.declarations ?? []) {
          if (d.id?.type === 'Identifier' && d.init
            && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) {
            bound.add(d.id.name);
          }
        }
        break;
      case 'CatchClause':
        if (n.param) collectBound(n.param, bound);
        break;
      case 'ClassDeclaration': case 'ClassExpression':
        if (n.id) bound.add(n.id.name);
        break;
      case 'Identifier':
        read.set(n.name, (read.get(n.name) ?? 0) + 1);
        break;
      default: break;
    }
  });
  const out = [];
  for (const name of declared) {
    if (written.has(name) || bound.has(name)) continue;
    if (!read.has(name)) continue;
    out.push(name);
  }
  out.sort();
  out.total = declared.size;
  return out;
}

function collectBound(p, into) {
  if (!p || typeof p !== 'object') return;
  if (p.type === 'Identifier') { into.add(p.name); return; }
  walkAst(p, (n) => { if (n.type === 'Identifier') into.add(n.name); });
}

export default { verifyEmitted, walkAst, joinPoints, commentsOf };
