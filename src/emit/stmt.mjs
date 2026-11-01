// src/emit/stmt.mjs
//
// T7's `Stmt` -> `@babel/types` statements, and the source position that
// travels with each one.
//
// 11.1's `Stmt` set is five tags plus `hole`. The only one that is not a
// transcription is `{s:'decl'}`, and the reason is names.mjs rule 1: T7's
// declarations are hoisted to one `let` list at the top of the function body,
// so a `{s:'decl'}` here emits the INITIALISER as an assignment and not a
// second declaration. Emitting `let` twice for one name is a SyntaxError, and
// emitting it in the block T7 names as the scope puts a phi's declaration
// after its first write (measured: `loop-while.jsc` #15, phi 8 scope 1,
// copies in blocks 0 and 2).
//
// A declaration whose `id` is a destructuring pattern keeps its pattern: the
// assignment form `({a} = x)` needs parentheses, which @babel/generator adds
// for an ObjectPattern in an expression position.
//
// The one statement that moves the OTHER way is a context binding's store:
// when declsite.mjs has proved that the binding is stored exactly once, in
// the function that owns it, at a position that encloses every read, the
// `{s:'expr'}` holding `<slot> = <value>` is emitted as
// `const <slot> = <value>` and the prologue row disappears. That is the only
// text shape V8's parser reads back as `maybe_assigned == kNotAssigned`, and
// so the only one that gets `LdaImmutableContextSlot` at the reads
// (docs/EMIT.md 9.11, docs/O1.md 6.8's top shape).
//
// `pos.sourcePosition` is attached to every statement node as `node.loc` in
// the ORIGINAL coordinate space (sourcemap.mjs turns it into a real map).
// ARCHITECTURE.md 3.5's monotonicity check is run over the sequence this file
// produces, which is why the position is recorded even when it is null.

import * as t from '@babel/types';
import { expr, toPattern } from './expr.mjs';
import { holeStmt } from './holes.mjs';

/** Record T7's source position on a node, for sourcemap.mjs. */
export function position(ctx, node, pos) {
  const sp = pos?.sourcePosition;
  if (sp === null || sp === undefined || sp < 0) {
    ctx.positions.push({ node, sourcePosition: null, isStatement: !!pos?.isStatement });
    return node;
  }
  node.__v8dPos = sp;
  ctx.positions.push({ node, sourcePosition: sp, isStatement: !!pos?.isStatement });
  return node;
}

/**
 * A context binding's store, emitted AS its declaration.
 *
 * `declsite.mjs` proved, over the IR, that this statement is the binding's
 * only program store, that it dominates every read in the owning function,
 * and that it sits in the body's outermost statement list. So the declaration
 * moves here from the prologue and the text becomes `const x = <value>` --
 * which is the only shape that makes V8's parser leave `maybe_assigned` at
 * `kNotAssigned` and emit `LdaImmutableContextSlot` at the reads
 * (src/interpreter/bytecode-generator.cc:4756 @ 14.4.258.16). Returns null
 * when there is no site for this statement, which is every other statement.
 *
 * The VALUE is emitted before the TARGET, in that order, because
 * `expr.mjs::expr`'s `assign` arm does: the order decides which of two shared
 * Exprs is visited first and so which one 11.3 invariant 4 reports.
 * index.mjs::verifyDeclarationSites checks afterwards that the node really
 * landed in the body's own statement list and reverts it to an assignment if
 * it did not, so this function never has to be trusted about placement.
 */
function declarationAtStore(ctx, s) {
  const site = ctx.declarationSites?.byStmt?.get(s);
  if (!site) return null;
  const value = expr(ctx, s.expr.value);
  const target = toPattern(ctx, s.expr.target);
  if (site.emitted) {
    // 11.3 invariant 1 says a placed block is emitted once, and verify.mjs
    // reports it per function when it is not. Two assignments are legal text
    // and two `const` declarations of one name are a SyntaxError, so the
    // second one degrades to the assignment rather than inheriting another
    // layer's violation. Counted, and expected to stay zero.
    ctx.report.declarationSitesEmittedTwice++;
    return t.expressionStatement(t.assignmentExpression('=', target, value));
  }
  if (!t.isIdentifier(target) || target.name !== site.name) {
    // The spelling this layer declares and the spelling the store writes have
    // to be the same identifier or the declaration would not be the store.
    // `nameOf` reads both off the same table, so this is unreachable -- and it
    // is checked rather than asserted because being wrong here would emit a
    // declaration of one name and lose the write to another.
    ctx.report.declarationSitesWithADifferentSpelling++;
    return t.expressionStatement(t.assignmentExpression('=', target, value));
  }
  const d = t.variableDeclarator(target, value);
  if (site.comment) {
    t.addComment(d, 'leading', ` ${String(site.comment).replace(/\*\//g, '* /')} `, false);
  }
  site.emitted = true;
  const node = t.variableDeclaration(site.keyword, [d]);
  ctx.noteDeclarationAtStore(site, node, target, value);
  return node;
}

/**
 * One `Stmt` -> zero or more Babel statements.
 * @returns {import('@babel/types').Statement[]}
 */
export function stmt(ctx, s) {
  if (!s || typeof s.s !== 'string') return [holeStmt(ctx, 'unknownStmtTag', typeof s)];
  let out;
  switch (s.s) {
    case 'expr': {
      const atStore = declarationAtStore(ctx, s);
      if (atStore) { out = [atStore]; break; }
      const e = expr(ctx, s.expr);
      out = [t.expressionStatement(e)];
      break;
    }
    case 'decl': {
      const list = [];
      for (const d of s.decls ?? []) {
        const target = toPattern(ctx, d.id);
        if (d.init === null || d.init === undefined) {
          // The declaration itself is in the prologue, so a declarator with no
          // initialiser has nothing left to emit. Recorded, not dropped: the
          // name is in `plan.declared`.
          ctx.report.declarationsWithoutAnInitialiser++;
          continue;
        }
        list.push(t.expressionStatement(t.assignmentExpression('=', target, expr(ctx, d.init))));
      }
      out = list;
      break;
    }
    case 'return':
      out = [t.returnStatement(s.arg === null || s.arg === undefined ? null : expr(ctx, s.arg))];
      break;
    case 'throw':
      out = [t.throwStatement(expr(ctx, s.arg))];
      break;
    case 'debugger':
      out = [t.debuggerStatement()];
      break;
    case 'hole':
      out = [holeStmt(ctx, s.why, s.detail)];
      break;
    default:
      out = [holeStmt(ctx, 'unknownStmtTag:' + s.s)];
      break;
  }
  for (const node of out) position(ctx, node, s.pos);
  return out;
}

/**
 * Every statement of one block, exactly once (11.3 invariant 3). The count is
 * recorded per block so verify.mjs can compare it against
 * `recovered.stmts.get(block).length` instead of trusting this function.
 */
export function blockStatements(ctx, blockId) {
  const list = ctx.rec.stmts.get(blockId);
  ctx.noteBlockEmitted(blockId);
  if (!list || !list.length) {
    ctx.report.blocksWithoutStatements++;
    return [];
  }
  const out = [];
  for (const s of list) {
    for (const node of stmt(ctx, s)) out.push(node);
  }
  ctx.noteStatementsEmitted(blockId, list.length);
  return out;
}

export default { stmt, blockStatements, position };
