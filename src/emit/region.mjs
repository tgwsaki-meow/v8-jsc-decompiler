// src/emit/region.mjs
//
// T8's `Region` -> `@babel/types` statements, and with it THE JOIN: a region
// says which block or which SSA value, and T7 says what that value is.
//
// ------------------------------------------------------------------ the join
//
//   {r:'block', id}      -> stmt.mjs emits `recovered.stmts.get(id)`, in order,
//                           exactly once (11.3 invariant 3)
//   Test                 -> expr.mjs's testExpr, which resolves `Test.value`
//                           through `recovered.exprs` (11.3 invariant 2) and
//                           reads `predicate` / `toBoolean`
//   Target               -> `recovered.exprs` as a binding pattern
//
// Nothing else crosses: T8 never mentions an expression and T7 never mentions
// the shape of the graph, so this file is the only place the two meet.
//
// ------------------------- the four things 11.2 promises and T8 never emits
//
// docs/STRUCTURE.md 9 lists them, with a measured reason for each, and each
// one is handled here the same way: emit what the bytecode LITERALLY does and
// keep the recognition visible and counted. Silently dropping the annotation
// is the one option that is not allowed.
//
//  1. `{r:'forIn'}` / `{r:'forOf'}` are never produced; a for-in/for-of
//     arrives as `{r:'loop'}` with `idiom` / `idiomDetail`. This layer emits
//     the lowered loop and marks it `/* for-in (idiom) ... */`, counted in
//     `report.loopIdioms`. Reconstructing `for (const k in o)` would mean
//     deleting the head instructions (ForInEnumerate/Prepare/Next/Step) that
//     T8 left inside `{r:'block'}` leaves which ALSO carry unrelated
//     statements -- so it would either drop real code or emit a block twice,
//     breaking invariant 1 or 3. T8 declined for exactly that reason and this
//     layer cannot undo the block boundaries either.
//
//  2. `finalizer` is always `null`; a `finally` arrives as
//     `{r:'try', form:'finallyToken', finallyShape}` whose handler IS the
//     token-setting region. Emitted as that `try`/`catch` -- which is what the
//     bytecode does and is correct JavaScript -- marked
//     `/* finally: token dispatch ... */` and counted in
//     `report.finallyShapes`. Lifting the finalizer out of the handler would
//     drop the token stores and the return-value computation that live in the
//     same blocks (docs/STRUCTURE.md 9.2).
//
//  3. `init` is always `null` on a loop: V8 puts the initialiser in the block
//     before the header, which also carries whatever preceded the loop. That
//     block is emitted as an ordinary leaf before the loop, which is where it
//     belongs; `for (;test;update)` is emitted with an empty init and counted.
//
//  4. `{r:'continue'}` is essentially never produced (0 against 9821 breaks in
//     T8's corpus run) because V8 gives a loop a separate continue target that
//     paths fall into. The branch is here and correct; its count is reported
//     so "never" stays a measurement.

import * as t from '@babel/types';
import { blockStatements } from './stmt.mjs';
import { expr, testExpr, toPattern } from './expr.mjs';
import { holeStmt, mark, noteStmt } from './holes.mjs';
import { unstructured } from './fallback.mjs';
import { sanitise, walkExprsOfStmt } from './names.mjs';

const block = (stmts) => t.blockStatement(stmts);

/** A region as a block statement, which is what every construct body needs. */
function bodyOf(ctx, region) {
  return block(regionStatements(ctx, region));
}

function labelled(ctx, node, label, kind) {
  if (!label) return node;
  ctx.report.labels++;
  return t.labeledStatement(t.identifier(sanitise(label)), node);
}

/**
 * The statements of this loop's test chain, when T8's claim about them is
 * false.
 *
 * `removed.loopTestBlocks` is a claim that T7 produces NO statement for the
 * blocks holding the loop condition, because every value in them feeds the
 * test with exactly one use and is therefore inlined (docs/STRUCTURE.md 4 and
 * 9.5). 11.3 invariant 3 says T9 is the layer that can check that claim, and
 * on `tests/t8/fixtures/async-await-in-loop.jsc` #15 `f` it does not hold:
 * block 3 carries BOTH `let t$16 = v$3 < p0` -- the test, materialised rather
 * than inlined -- and a phi copy `v$11 = v`. Emitting `while (t$16)` and
 * dropping that block gives a loop whose condition reads a variable nothing
 * ever assigns, and loses the copy. Silently wrong, which 7 forbids.
 *
 * So when the chain has statements they are emitted where V8 put them: at the
 * top of every iteration, ahead of the test. `while (c) body` becomes
 * `for (;;) { chain; if (!c) break; body }` and `for (;c;u) body` becomes
 * `for (;;u) { chain; if (!c) break; body }` -- which keeps `continue`
 * targeting the update, the whole reason T8 distinguishes the `for` form.
 */
function testChainStatements(ctx, r) {
  const rows = (ctx.sf.removed?.loopTestBlocks ?? []).filter((x) => x.loop === r.header);
  if (!rows.length) return [];
  const offset = (b) => ctx.ir.blocks[b]?.startOffset ?? 0;
  rows.sort((a, b) => offset(a.block) - offset(b.block));
  const out = [];
  for (const row of rows) {
    const list = ctx.rec.stmts.get(row.block);
    if (!list || !list.length) continue;
    out.push(...blockStatements(ctx, row.block));
  }
  return out;
}

/**
 * `idiom:'forIn'` -> a real `for (k in o)`, because the lowered form does not
 * terminate.
 *
 * This is the one place where docs/STRUCTURE.md 9.1's "emit the honest lowered
 * loop" is not an option, and the reason is measured on
 * `tests/t8/fixtures/loop-for-in.jsc` #15 `f`:
 *
 *   loopPlan { form:'for', testBlock:2, testValue:NULL, testChain:[2],
 *              updateBlock:5, idiom:'forIn' }
 *
 * `testValue` is null because the loop's exit test is `ForInContinue`, whose
 * predicate (`forInDone`, src/structure/facts.mjs) reads no accumulator -- so
 * T8 builds a `for` region with `test: null`. Block 2, which holds the
 * `ForInNext` that produces the key, is in `removed.loopTestBlocks` and T7
 * emits no statement for it either, because its `forIn` pattern consumed those
 * instructions expecting a `{r:'forIn'}` region to put them back. The lowered
 * emission is therefore `for (;;u) { if (key !== undefined) body }` with
 * nothing assigning `key` and nothing leaving the loop: an infinite loop over
 * an undefined key. Ugly would be acceptable; non-terminating is not.
 *
 * Everything needed is in the annotation T8 attached, which is why it carries
 * one: `idiomDetail.subject` is the enumerated object and `idiomDetail.key` is
 * the SSA value of the key, which T7 has materialised under a name. So the
 * head is rebuilt from `(key, subject)` and the body keeps V8's own
 * `key !== undefined` filter -- redundant in a real `for-in`, and kept because
 * dropping an emitted region is not this layer's call.
 *
 * The update region is still emitted, at the end of the body: its `ForInStep`
 * bookkeeping is dead once the head is a real `for-in`, but 11.3 invariant 3
 * says a placed block's statements are emitted exactly once, and "dead" is not
 * a licence to drop them.
 */
function forInFromIdiom(ctx, r) {
  const d = r.idiomDetail;
  if (!d || d.key === null || d.key === undefined || d.subject === null || d.subject === undefined) return null;
  if (!ctx.rec.exprs.has(d.key) || !ctx.rec.exprs.has(d.subject)) return null;
  const keyExpr = ctx.rec.exprs.get(d.key);
  if (!keyExpr || keyExpr.e !== 'name') return null;        // no name to bind
  const left = toPattern(ctx, keyExpr);
  const right = ctx.exprOfValue(d.subject, 'forIn.subject');
  const body = bodyOf(ctx, r.body);
  if (r.update) body.body.push(...regionStatements(ctx, r.update));
  const node = t.forInStatement(left, right, body);
  mark(node, `for-in rebuilt from loop.idiomDetail (confidence ${d.confidence ?? 'unknown'}); `
    + 'the lowered form has no exit test because ForInContinue reads no accumulator');
  ctx.report.forInRebuilt++;
  return node;
}

/** `{r:'loop'}` -> while / do-while / for / while(true). */
function loop(ctx, r) {
  ctx.report.loops++;
  ctx.report.loopForms[r.form] = (ctx.report.loopForms[r.form] ?? 0) + 1;
  if (r.idiom === 'forIn') {
    const node = forInFromIdiom(ctx, r);
    if (node) {
      ctx.report.loopIdioms[r.idiom] = (ctx.report.loopIdioms[r.idiom] ?? 0) + 1;
      return [labelled(ctx, node, r.label, 'loop')];
    }
    ctx.report.forInNotRebuilt++;
  }
  const chain = (r.form === 'while' || r.form === 'for') ? testChainStatements(ctx, r) : [];
  const body = bodyOf(ctx, r.body);
  let node;
  if (chain.length) {
    ctx.report.loopTestChainsMaterialised++;
    ctx.report.loopTestChainStatements += chain.length;
    const guard = t.ifStatement(testExpr(ctx, r.test, { negateExtra: true }), t.blockStatement([t.breakStatement(null)]), null);
    const inner = t.blockStatement([...chain, guard, ...body.body]);
    const updateStmts = r.form === 'for' && r.update ? regionStatements(ctx, r.update) : [];
    const update = asSequence(updateStmts);
    if (update === null && updateStmts.length) {
      ctx.countHole('forUpdateNotAnExpression', 'region');
      inner.body.push(...updateStmts);
    }
    node = t.forStatement(null, null, update, inner);
    mark(node, `${r.form}: the loop test is materialised, so the test chain runs at the top of the body`);
    if (r.idiom) {
      ctx.report.loopIdioms[r.idiom] = (ctx.report.loopIdioms[r.idiom] ?? 0) + 1;
      mark(node, `${r.idiom} (lowered; confidence ${r.idiomDetail?.confidence ?? 'unknown'})`);
    }
    if (r.endless) ctx.report.endlessLoops++;
    return [labelled(ctx, node, r.label, 'loop')];
  }
  switch (r.form) {
    case 'while':
      node = t.whileStatement(testExpr(ctx, r.test), body);
      break;
    case 'doWhile':
      node = t.doWhileStatement(testExpr(ctx, r.test), body);
      break;
    case 'for': {
      // The update region is emitted ONCE and then classified. Emitting it,
      // deciding it is not an expression and emitting it again counted every
      // statement and every hole inside it twice -- which 11.3 invariants 3
      // and 6 then reported, correctly, as this layer's own bug.
      const updateStmts = r.update ? regionStatements(ctx, r.update) : [];
      const update = asSequence(updateStmts);
      if (update === null && updateStmts.length) {
        // Not a run of expressions, so it cannot be a `for` update. The
        // statements stay where they run -- at the end of the body -- and the
        // degradation is counted: a `continue` in the body would skip them,
        // which is why this is a hole and not a style choice.
        ctx.countHole('forUpdateNotAnExpression', 'region');
        body.body.push(...updateStmts);
        node = t.whileStatement(testExpr(ctx, r.test), body);
        mark(node, 'HOLE forUpdateNotAnExpression: appended to the body');
      } else {
        node = t.forStatement(null, r.test ? testExpr(ctx, r.test) : null, update, body);
        if (r.init === null) ctx.report.loopsWithoutAnInit++;
      }
      break;
    }
    case 'forever':
    default:
      node = t.whileStatement(t.booleanLiteral(true), body);
      break;
  }
  if (r.idiom) {
    // docs/STRUCTURE.md 9.1: the recognition is an annotation, and this is
    // where it stays visible instead of being dropped.
    ctx.report.loopIdioms[r.idiom] = (ctx.report.loopIdioms[r.idiom] ?? 0) + 1;
    const d = r.idiomDetail ?? {};
    mark(node, `${r.idiom} (lowered; confidence ${d.confidence ?? 'unknown'})`);
  }
  if (r.endless) ctx.report.endlessLoops++;
  return [labelled(ctx, node, r.label, 'loop')];
}

/**
 * A `for` update clause: already-emitted statements, if every one of them is
 * an expression. `null` means "these cannot be a `for` update".
 */
function asSequence(stmts) {
  if (!stmts.length) return null;
  const exprs = [];
  for (const s of stmts) {
    if (!t.isExpressionStatement(s)) return null;
    exprs.push(s.expression);
  }
  return exprs.length === 1 ? exprs[0] : t.sequenceExpression(exprs);
}

/** `{r:'try'}`, including T8's `form:'finallyToken'`. */
function tryRegion(ctx, r) {
  ctx.report.tries++;
  ctx.report.triesByPrediction[r.prediction ?? 'unknown'] = (ctx.report.triesByPrediction[r.prediction ?? 'unknown'] ?? 0) + 1;
  const blockBody = bodyOf(ctx, r.block);
  let handler = null;
  if (r.handler) {
    const param = catchParam(ctx, r.param);
    const hBody = bodyOf(ctx, r.handler);
    const bind = catchContextBinding(ctx, r, param);
    if (bind) hBody.body.unshift(bind);
    handler = t.catchClause(param, hBody);
  }
  const finalizer = r.finalizer ? bodyOf(ctx, r.finalizer) : null;
  if (!handler && !finalizer) {
    // A `try` with neither is not expressible. The body still has to run, so
    // it is emitted as a block and the loss of the protection is counted.
    ctx.countHole('tryWithoutAHandler', 'region');
    return [mark(blockBody, `HOLE tryWithoutAHandler ${r.handlerIndex}`)];
  }
  const node = t.tryStatement(blockBody, handler, finalizer);
  if (r.form === 'finallyToken' && r.finallyShape) {
    const s = r.finallyShape;
    ctx.report.finallyShapes++;
    ctx.report.finallyShapeKinds[s.dispatchKind] = (ctx.report.finallyShapeKinds[s.dispatchKind] ?? 0) + 1;
    mark(node, `finally: token dispatch ${s.dispatchKind}, finalizer enters at block ${s.finalizerEntry}`
      + `, ${(s.cases ?? []).length} deferred command(s); emitted as the catch the bytecode builds`);
  }
  if (r.finalizer === null) ctx.report.triesWithoutAFinalizer++;
  return [node];
}

/**
 * `catch (e) { ... e ... }` needs one statement nothing upstream produces.
 *
 * Measured on `tests/t8/fixtures/try-catch.jsc` #15 `f`. The source is
 * `catch (e) { return 'caught:' + e.message }`, and V8 compiles the binding as
 * a CATCH CONTEXT: `CreateCatchContext <exception> <scopeInfo>` allocates a
 * context whose slot 2 holds the exception, and the body reads it with
 * `LdaImmutableCurrentContextSlot [2]`. So two different storage locations
 * spell the same source variable: T6's `CaughtException` value (which `catch`
 * binds, named `e$3` by T7) and the context slot (named `e` from the
 * ScopeInfo). The IR shows the gap exactly -- `ContextSlot 36` has
 * `loads:[29]` and `stores:[]` -- because the store is performed BY the
 * context-creating instruction and so has no store op to attribute it to.
 *
 * Emitted, that reads `undefined.message`. So when a handler loads a depth-0
 * context slot that nothing in the function stores, the binding is emitted:
 * `<slot> = <catch param>`. The condition is derived from T6's own
 * `ContextSlot.stores`, not from an opcode name, and when more than one slot
 * qualifies nothing is emitted and the ambiguity is counted -- guessing which
 * of two unstored slots holds the exception would be exactly the plausible
 * placeholder 7 forbids.
 */
function catchContextBinding(ctx, r, param) {
  if (!param || param.type !== 'Identifier') return null;
  const slots = new Map();
  const seen = new Set();
  const collectBlocks = (reg) => {
    if (!reg) return;
    if (reg.r === 'block') { seen.add(reg.id); return; }
    if (reg.r === 'unstructured') { for (const b of reg.blocks ?? []) seen.add(b); return; }
    for (const k of ['body', 'then', 'else', 'block', 'handler', 'finalizer', 'update', 'init']) {
      const v = reg[k];
      if (Array.isArray(v)) for (const x of v) collectBlocks(x);
      else if (v && typeof v === 'object') collectBlocks(v);
    }
    for (const c of reg.cases ?? []) collectBlocks(c.body);
  };
  collectBlocks(r.handler);
  for (const b of seen) {
    for (const s of ctx.rec.stmts.get(b) ?? []) {
      walkExprsOfStmt(s, (e) => {
        if (e.e !== 'name' || e.ref?.k !== 'contextSlot') return;
        if ((e.ref.depth ?? 0) !== 0) return;
        const loc = ctx.ir.values[e.ref.slotValue];
        if (!loc || loc.kind !== 'ContextSlot') return;
        if ((loc.stores ?? []).length) return;
        slots.set(e.ref.slotValue, e);
      });
    }
  }
  if (slots.size === 0) return null;
  if (slots.size > 1) { ctx.report.catchContextBindingsAmbiguous++; return null; }
  const [, nameExpr] = [...slots.entries()][0];
  const target = t.identifier(ctx.nameOfExpr(nameExpr));
  if (target.name === param.name) return null;
  ctx.report.catchContextBindings++;
  const s = t.expressionStatement(t.assignmentExpression('=', target, t.identifier(param.name)));
  return mark(s, 'catch binding: V8 stores the caught value in a catch context, '
    + 'whose slot has loads and no store');
}

/** `catch (e)` binds T6's `CaughtException` value; T7 named it. */
function catchParam(ctx, target) {
  if (!target || target.value === null || target.value === undefined) {
    ctx.report.catchWithoutAParam++;
    return null;
  }
  const e = ctx.rec.exprs.get(target.value);
  if (e && e.e === 'name') {
    ctx.visit(e);
    return t.identifier(ctx.nameOfExpr(e));
  }
  const m = ctx.rec.materialised?.get(target.value);
  if (m?.name) return t.identifier(sanitise(m.name));
  ctx.countHole('joinUnresolved', 'expr');
  const n = ctx.scratchName('e');
  return mark(t.identifier(n), `HOLE joinUnresolved catch param, value ${target.value}`);
}

/** `{r:'switch'}`: both the jump table and the compare chain. */
function switchRegion(ctx, r) {
  ctx.report.switches++;
  ctx.report.switchForms[r.form] = (ctx.report.switchForms[r.form] ?? 0) + 1;
  ctx.report.switchGuardBlocks += (r.guardBlocks ?? []).length;
  const disc = testExpr(ctx, r.disc);
  const cases = [];
  for (const c of r.cases ?? []) {
    const body = regionStatements(ctx, c.body);
    let test = null;
    if (c.isDefault) test = null;
    else if (c.test) test = testExpr(ctx, c.test);
    else if (c.caseValue !== null && c.caseValue !== undefined) test = t.numericLiteral(Number(c.caseValue));
    else {
      ctx.countHole('switchCaseWithoutALabel', 'region');
      test = mark(t.identifier('__hole'), 'HOLE switchCaseWithoutALabel');
      ctx.needHoleIdentifier();
    }
    cases.push(t.switchCase(test, body));
  }
  const node = t.switchStatement(disc, cases);
  if (r.finallyToken) mark(node, 'finally token dispatch');
  return [labelled(ctx, node, r.label, 'switch')];
}

/**
 * A Region -> statements. The one function every construct recurses through,
 * so every block leaf passes through `blockStatements` exactly once.
 */
export function regionStatements(ctx, r) {
  if (!r) return [];
  ctx.regionCount++;
  switch (r.r) {
    case 'seq': {
      const out = [];
      for (const x of r.body ?? []) out.push(...regionStatements(ctx, x));
      return out;
    }
    case 'block':
      return blockStatements(ctx, r.id);
    case 'if': {
      ctx.report.ifs++;
      const test = testExpr(ctx, r.test);
      const then = r.then ? bodyOf(ctx, r.then) : block([]);
      const alt = r.else ? bodyOf(ctx, r.else) : null;
      return [t.ifStatement(test, then, alt)];
    }
    case 'loop': return loop(ctx, r);
    case 'try': return tryRegion(ctx, r);
    case 'switch': return switchRegion(ctx, r);
    case 'labeled': {
      ctx.report.labels++;
      return [t.labeledStatement(t.identifier(sanitise(r.label)), bodyOf(ctx, r.body))];
    }
    case 'break':
      ctx.report.breaks++;
      return [t.breakStatement(r.label ? t.identifier(sanitise(r.label)) : null)];
    case 'continue':
      ctx.report.continues++;
      return [t.continueStatement(r.label ? t.identifier(sanitise(r.label)) : null)];
    case 'forIn': case 'forOf': {
      // 11.2 lists these and T8 never emits them (docs/STRUCTURE.md 9.1). The
      // branch exists so that a future T8 that does emit them is not silently
      // dropped here, and its use is counted.
      ctx.report.regionKindsNot112[r.r] = (ctx.report.regionKindsNot112[r.r] ?? 0) + 1;
      const left = r.left ? expr(ctx, ctx.rec.exprs.get(r.left.value) ?? { e: 'hole', why: 'joinUnresolved' }) : t.identifier('__hole');
      const right = testExpr(ctx, r.right);
      const body = bodyOf(ctx, r.body);
      const node = r.r === 'forIn'
        ? t.forInStatement(left, right, body)
        : t.forOfStatement(left, right, body, !!r.isAwait);
      return [labelled(ctx, node, r.label, 'loop')];
    }
    case 'unstructured':
      return unstructured(ctx, r);
    default:
      ctx.report.unknownRegionKinds[r.r] = (ctx.report.unknownRegionKinds[r.r] ?? 0) + 1;
      return [holeStmt(ctx, 'unknownRegionKind:' + r.r)];
  }
}

export { noteStmt };
export default { regionStatements };
