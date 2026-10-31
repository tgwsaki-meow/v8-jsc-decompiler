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
 * One `Stmt` -> zero or more Babel statements.
 * @returns {import('@babel/types').Statement[]}
 */
export function stmt(ctx, s) {
  if (!s || typeof s.s !== 'string') return [holeStmt(ctx, 'unknownStmtTag', typeof s)];
  let out;
  switch (s.s) {
    case 'expr': {
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
