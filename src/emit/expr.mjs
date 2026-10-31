// src/emit/expr.mjs
//
// T7's `Expr` -> `@babel/types`. One branch per tag of 11.1's closed set plus
// the three docs/RECOVER.md 5 adds (`super`, `importCall`, `templateObject`),
// and `{e:'hole'}` for the only "I don't know" T7 is allowed.
//
// A real AST, never string concatenation (11.4): the only thing that turns the
// tree into text is @babel/generator, so the output cannot be unparseable by
// construction. ARCHITECTURE.md 5 retired output parseability as a PROGRESS
// metric; it is a precondition here, not an achievement.
//
// Three things in this file are not transcription and are worth stating.
//
// `duplicable` is the only licence to emit a value twice (11.3 invariant 4),
// and the check runs on what is EMITTED, not on T7's promise: `ctx.visit(e)`
// counts every T7 Expr OBJECT this file reaches. T7 memoises one object per
// SSA value (docs/RECOVER.md 2.2), so "the same object reached twice" is
// exactly "that value was emitted twice" -- and because several values can
// share one object when a pattern aliases them deliberately, a second visit is
// a violation only when NONE of the values mapping to that object may be
// duplicated. verify.mjs reads the counts.
//
// An optional chain cannot be built one node at a time. Babel needs
// `OptionalMemberExpression` / `OptionalCallExpression` for every link of a
// chain that contains one short-circuiting link, not only for the link that
// short-circuits: `a?.b.c` is Optional(Optional(a, b), c) with
// `optional:false` on the outer node. So the converter tracks whether the
// subtree it just produced is part of a chain, which is what `chained` is.
//
// `toBoolean` (T8's addition to 11.2's Test) matters only in a value
// position. In a condition JavaScript applies ToBoolean itself, so
// `JumpIfToBooleanFalse` with `negate` is `!x` and without it is plain `x`;
// nothing is needed. Where a Test's value is used AS a value, `!!` is.

import * as t from '@babel/types';
import { holeExpr, mark } from './holes.mjs';
import { sanitise } from './names.mjs';

/**
 * The conversion depth guard. T7 already guards its own resolution at 64
 * (docs/RECOVER.md 6 `exprTooDeep`); this is the backstop for a cyclic Expr
 * graph reaching this layer, so it is deliberately far above T7's limit.
 */
const MAX_EXPR_DEPTH = 400;

/** Is this string usable as a non-computed member / property key? */
function isIdent(s) { return typeof s === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s); }

function keyOf(ctx, key, computed) {
  if (computed || (key && typeof key === 'object')) {
    return { node: key && typeof key === 'object' ? expr(ctx, key) : t.stringLiteral(String(key)), computed: true };
  }
  if (isIdent(key)) return { node: t.identifier(key), computed: false };
  if (typeof key === 'number') return { node: t.numericLiteral(key), computed: false };
  return { node: t.stringLiteral(String(key)), computed: false };
}

/** A literal value of the kinds 11.1 allows for `{e:'lit'}`. */
function literal(ctx, v) {
  if (v === null) return t.nullLiteral();
  switch (typeof v) {
    case 'undefined': return t.identifier('undefined');
    case 'boolean': return t.booleanLiteral(v);
    case 'string': return t.stringLiteral(v);
    case 'bigint': return t.bigIntLiteral(String(v));
    case 'number': {
      if (Number.isNaN(v)) return t.identifier('NaN');
      if (v === Infinity) return t.identifier('Infinity');
      if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
      if (v < 0 || Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(Math.abs(v)));
      return t.numericLiteral(v);
    }
    default:
      return holeExpr(ctx, 'litKind:' + typeof v, String(v).slice(0, 60));
  }
}

/** The name a `{e:'name'}` is emitted under, after names.mjs's rename map. */
export function nameOf(ctx, e) {
  const raw = sanitise(e.name);
  if (e.ref?.k === 'global' || e.ref?.k === 'param') return raw;
  return ctx.plan.rename.get(raw) ?? raw;
}

function nameExpr(ctx, e) {
  const id = t.identifier(nameOf(ctx, e));
  // docs/RECOVER.md 4.2: an unresolvable slot arrives as the `__ctx_d<d>_i<i>`
  // placeholder carrying `ctx[d][i]`. The comment is the whole point of the
  // placeholder, so it travels to the use site as well as to the declaration.
  const c = e.ref?.comment ?? (e.ref?.k === 'contextSlot' && e.ref.resolved === false
    ? `ctx[${e.ref.depth ?? 0}][${e.ref.index ?? 0}]` : null);
  if (c) { mark(id, String(c)); ctx.report.unresolvedNames++; }
  if (e.ref?.k === 'global') ctx.report.globalReads++;
  return id;
}

/** Does this converted node sit inside an optional chain? */
function isChained(node) {
  return node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression';
}

function memberExpr(ctx, e) {
  const obj = expr(ctx, e.obj);
  const { node: prop, computed } = keyOf(ctx, e.prop, e.computed);
  if (e.optional || isChained(obj)) {
    return t.optionalMemberExpression(obj, prop, computed, !!e.optional);
  }
  return t.memberExpression(obj, prop, computed);
}

function argList(ctx, args) {
  const out = [];
  for (const a of args ?? []) {
    if (a === null || a === undefined) { out.push(t.identifier('undefined')); continue; }
    if (a.spread) { out.push(t.spreadElement(expr(ctx, a.spread))); continue; }
    out.push(expr(ctx, a));
  }
  return out;
}

function callExpr(ctx, e) {
  const args = argList(ctx, e.args);
  if (e.callee?.e === 'importCall') return t.callExpression(t.import(), args);
  const callee = expr(ctx, e.callee);
  if (e.optional || isChained(callee)) return t.optionalCallExpression(callee, args, !!e.optional);
  return t.callExpression(callee, args);
}

function templateLiteral(ctx, quasis, exprs) {
  const qs = (quasis ?? []).map((q, i) => t.templateElement(
    { raw: String(q?.raw ?? ''), cooked: q?.cooked === undefined ? String(q?.raw ?? '') : String(q.cooked) },
    i === (quasis.length - 1),
  ));
  if (!qs.length) qs.push(t.templateElement({ raw: '', cooked: '' }, true));
  const es = (exprs ?? []).map((x) => expr(ctx, x));
  // A template literal needs exactly one more quasi than it has expressions.
  while (qs.length <= es.length) qs.push(t.templateElement({ raw: '', cooked: '' }, false));
  qs[qs.length - 1].tail = true;
  return t.templateLiteral(qs, es);
}

/** An object literal property, including the accessor and method forms. */
function objectProp(ctx, p) {
  if (p.kind === 'spread') return t.spreadElement(expr(ctx, p.value));
  const { node: key, computed } = keyOf(ctx, p.key, p.computed);
  if ((p.kind === 'get' || p.kind === 'set' || p.kind === 'method') && p.value?.e === 'fn') {
    const fn = ctx.functionLike(p.value, p.kind === 'method' ? 'method' : p.kind);
    if (fn && fn.type === 'FunctionExpression') {
      return t.objectMethod(p.kind === 'method' ? 'method' : p.kind, key, fn.params, fn.body, computed);
    }
    return t.objectProperty(key, fn ?? holeExpr(ctx, 'accessorWithoutABody', p.kind), computed);
  }
  return t.objectProperty(key, expr(ctx, p.value), computed);
}

/**
 * An Expr -> a Babel expression node.
 * @param {object} ctx per-function context (index.mjs)
 */
export function expr(ctx, e) {
  if (e === null || e === undefined) return holeExpr(ctx, 'noValue');
  if (typeof e !== 'object' || typeof e.e !== 'string') {
    return holeExpr(ctx, 'unknownExprTag', typeof e);
  }
  ctx.visit(e);
  if (ctx.depth++ > MAX_EXPR_DEPTH) { ctx.depth--; return holeExpr(ctx, 'exprTooDeepForTheEmitter'); }
  try {
    switch (e.e) {
      case 'lit': return literal(ctx, e.v);
      case 'regexp': return t.regExpLiteral(String(e.source ?? ''), String(e.flags ?? ''));
      case 'name': return nameExpr(ctx, e);
      case 'this': return t.thisExpression();
      case 'newTarget': return t.metaProperty(t.identifier('new'), t.identifier('target'));
      case 'importMeta': return t.metaProperty(t.identifier('import'), t.identifier('meta'));
      case 'array': return t.arrayExpression((e.elements ?? []).map((x) => (
        x === null || x === undefined ? null : (x.spread ? t.spreadElement(expr(ctx, x.spread)) : expr(ctx, x))
      )));
      case 'object': return t.objectExpression((e.props ?? []).map((p) => objectProp(ctx, p)));
      case 'fn': return ctx.functionLike(e, 'expression') ?? holeExpr(ctx, 'closureWithoutAUnit', `sfi ${e.sfiId}`);
      case 'class': return ctx.classLike(e) ?? holeExpr(ctx, 'classWithoutAUnit', `sfi ${e.sfiId}`);
      case 'unary': return t.unaryExpression(e.op === 'void' ? 'void' : e.op, expr(ctx, e.arg));
      case 'update': {
        const arg = expr(ctx, e.arg);
        if (!t.isIdentifier(arg) && !t.isMemberExpression(arg)) {
          ctx.countHole('updateTargetNotAnLVal', 'expr');
          return mark(t.binaryExpression(e.op === '++' ? '+' : '-', arg, t.numericLiteral(1)), 'HOLE updateTargetNotAnLVal');
        }
        return t.updateExpression(e.op, arg, !!e.prefix);
      }
      case 'bin': return t.binaryExpression(e.op, expr(ctx, e.l), expr(ctx, e.r));
      case 'logical': return t.logicalExpression(e.op, expr(ctx, e.l), expr(ctx, e.r));
      case 'assign': {
        const value = expr(ctx, e.value);
        const target = toPattern(ctx, e.target);
        return t.assignmentExpression(e.op ?? '=', target, value);
      }
      case 'cond': return t.conditionalExpression(expr(ctx, e.test), expr(ctx, e.then), expr(ctx, e.alt));
      case 'member': return memberExpr(ctx, e);
      case 'call': return callExpr(ctx, e);
      case 'new': return t.newExpression(expr(ctx, e.callee), argList(ctx, e.args));
      case 'template': return templateLiteral(ctx, e.quasis, e.exprs);
      case 'tagged': {
        const tag = expr(ctx, e.tag);
        const q = e.quasi?.e === 'templateObject' || e.quasi?.raw
          ? templateLiteral(ctx, quasisOfTemplateObject(e.quasi), e.quasi?.exprs ?? [])
          : (e.quasi?.e === 'template' ? templateLiteral(ctx, e.quasi.quasis, e.quasi.exprs) : templateLiteral(ctx, [], []));
        return t.taggedTemplateExpression(tag, q);
      }
      case 'seq': return t.sequenceExpression((e.exprs ?? []).map((x) => expr(ctx, x)));
      case 'await': {
        if (!ctx.isAsync) { ctx.countHole('awaitOutsideAnAsyncFunction', 'expr'); ctx.forceAsync(); }
        return t.awaitExpression(expr(ctx, e.arg));
      }
      case 'yield': {
        if (!ctx.isGenerator) { ctx.countHole('yieldOutsideAGenerator', 'expr'); ctx.forceGenerator(); }
        return t.yieldExpression(e.arg === null || e.arg === undefined ? null : expr(ctx, e.arg), !!e.delegate);
      }
      case 'super': {
        // `super` is only legal inside a method. A unit emitted as a plain
        // function declaration cannot carry it, so the reference becomes a
        // declared placeholder and is counted (holes.mjs superOutsideAMethod).
        if (ctx.allowSuper) return t.super();
        ctx.countHole('superOutsideAMethod', 'expr');
        ctx.needSuperPlaceholder();
        return mark(t.identifier('__super'), 'HOLE superOutsideAMethod');
      }
      case 'importCall': return t.import();
      case 'templateObject': {
        ctx.countHole('templateObjectAsValue', 'expr');
        const arr = t.arrayExpression((e.cooked ?? e.raw ?? []).map((s) => (
          s === undefined || s === null ? t.identifier('undefined') : t.stringLiteral(String(s))
        )));
        return mark(arr, `HOLE templateObjectAsValue raw=${JSON.stringify((e.raw ?? []).slice(0, 4))}`);
      }
      case 'hole': return holeExpr(ctx, e.why, e.detail, e.dump);
      default: return holeExpr(ctx, 'unknownExprTag:' + e.e);
    }
  } finally {
    ctx.depth--;
  }
}

function quasisOfTemplateObject(q) {
  const raw = q?.raw ?? [];
  const cooked = q?.cooked ?? raw;
  return raw.map((r, i) => ({ raw: r, cooked: cooked[i] }));
}

/** An Expr used as an assignment target / binding pattern. */
export function toPattern(ctx, e) {
  if (!e || typeof e !== 'object') return holeExpr(ctx, 'assignTargetNotAnLVal', 'missing');
  switch (e.e) {
    // A WRITE to a name is not an evaluation of a value, so it is not counted
    // for 11.3 invariant 4. Measured on `r_25918.jsc` #54
    // `setMainShortcutsReminder`: T7 shares one `{e:'name', ref:{phi:N}}`
    // object across all of a phi's predecessor copies, which is correct SSA
    // destruction -- one target, one assignment per incoming edge -- and
    // counting the target as an occurrence reported 6 "values emitted twice"
    // for code that re-evaluates nothing. The object expression of a member
    // target IS evaluated, so that one still counts.
    case 'name': return t.identifier(nameOf(ctx, e));
    case 'member': { ctx.visit(e); return memberExpr(ctx, e); }
    case 'array': {
      ctx.visit(e);
      return t.arrayPattern((e.elements ?? []).map((x) => {
        if (x === null || x === undefined) return null;
        if (x.spread) return t.restElement(toPattern(ctx, x.spread));
        if (x.e === 'assign' && (x.op ?? '=') === '=') {
          return t.assignmentPattern(toPattern(ctx, x.target), expr(ctx, x.value));
        }
        return toPattern(ctx, x);
      }));
    }
    case 'object': {
      ctx.visit(e);
      const props = [];
      for (const p of e.props ?? []) {
        if (p.kind === 'spread') { props.push(t.restElement(toPattern(ctx, p.value))); continue; }
        const { node: key, computed } = keyOf(ctx, p.key, p.computed);
        props.push(t.objectProperty(key, toPattern(ctx, p.value), computed, false));
      }
      return t.objectPattern(props);
    }
    case 'hole': return holeExpr(ctx, e.why, e.detail, e.dump);
    default: {
      const v = expr(ctx, e);
      if (t.isIdentifier(v) || t.isMemberExpression(v) || t.isPattern(v)) return v;
      ctx.countHole('assignTargetNotAnLVal', 'expr');
      ctx.needHoleIdentifier();
      return mark(t.identifier('__hole'), `HOLE assignTargetNotAnLVal ${e.e}`);
    }
  }
}

/**
 * A `Test` (11.2, extended by T8 with `predicate` and `toBoolean`) -> a
 * condition expression.
 *
 * `predicate` is NOT decoration. `JumpIfUndefinedOrNull` branches on
 * `value == null`; rendering `if (value)` for it inverts the condition on
 * every nullish value. T8's table (src/structure/facts.mjs PREDICATES) is
 * asserted total over every conditional jump of the profile, so every kind
 * below is reachable and none is a guess.
 */
export function testExpr(ctx, test, { negateExtra = false } = {}) {
  if (!test) return t.booleanLiteral(true);
  const negate = !!test.negate !== !!negateExtra;
  const kind = test.predicate ?? 'truthy';
  const valueExpr = () => {
    if (test.value === null || test.value === undefined) {
      return holeExpr(ctx, 'joinUnresolved', `test on block ${test.block} has no value`);
    }
    return ctx.exprOfValue(test.value, `test:${kind}`);
  };
  const eq = (op, right) => t.binaryExpression(op, valueExpr(), right);
  switch (kind) {
    case 'value':
    case 'truthy':
      return negate ? t.unaryExpression('!', valueExpr()) : valueExpr();
    case 'null':
      return eq(negate ? '!==' : '===', t.nullLiteral());
    case 'undefined':
      return eq(negate ? '!==' : '===', t.identifier('undefined'));
    case 'undefinedOrNull':
      return eq(negate ? '!=' : '==', t.nullLiteral());
    case 'jsReceiver': {
      // JSReceiver = an object (not null) or a function. Written out rather
      // than hidden behind an invented helper, and marked so it reads as a
      // reconstruction of `JumpIfJSReceiver` rather than as source.
      //
      // The test needs its operand three times and 11.3 invariant 4 allows a
      // value to be emitted once, so the operand goes into a declared scratch
      // variable first. That keeps "evaluated once" true of the value and
      // moves the repetition onto a name, which re-evaluates nothing.
      const scratch = ctx.scratchName();
      const bind = t.assignmentExpression('=', t.identifier(scratch), valueExpr());
      const s = () => t.identifier(scratch);
      const isObj = t.logicalExpression('&&',
        t.binaryExpression('===', t.unaryExpression('typeof', s()), t.stringLiteral('object')),
        t.binaryExpression('!==', s(), t.nullLiteral()));
      const isFn = t.binaryExpression('===', t.unaryExpression('typeof', s()), t.stringLiteral('function'));
      let both = t.logicalExpression('||', isObj, isFn);
      if (negate) both = t.unaryExpression('!', both);
      const seq = t.sequenceExpression([bind, both]);
      mark(seq, 'JSReceiver');
      return seq;
    }
    case 'forInDone': {
      // `ForInContinue index, cacheLength` reads no accumulator, so the Test
      // carries `values` instead of `value` (src/structure/conditions.mjs).
      const vals = test.values ?? [];
      if (vals.length >= 2) {
        const a = ctx.exprOfValue(vals[0], 'forInIndex');
        const b = ctx.exprOfValue(vals[1], 'forInCacheLength');
        const done = t.binaryExpression(negate ? '!==' : '===', a, b);
        mark(done, 'for-in done');
        return done;
      }
      return holeExpr(ctx, 'joinUnresolved', 'forInDone without two operands');
    }
    default:
      return holeExpr(ctx, 'unknownPredicate:' + kind, `block ${test.block}`);
  }
}

/** The same Test used as a VALUE: this is where `toBoolean` matters. */
export function testValueExpr(ctx, test) {
  const e = testExpr(ctx, test);
  if (test?.toBoolean && !test.negate) return t.unaryExpression('!', t.unaryExpression('!', e));
  return e;
}

export default { expr, toPattern, testExpr, testValueExpr, nameOf };
