// src/emit/fallback.mjs
//
// `{r:'unstructured'}` -> ARCHITECTURE.md 4.4.7's honest fall-back:
//
//     /* UNSTRUCTURED why */
//     __pc0 = <entry>;
//     __region0: while (true) switch (__pc0) {
//       case 0: ...statements of block 0...; __pc0 = 3; break;
//       case 3: ...; __pc0 = cond ? 5 : 7; break;
//       ...
//       default: break __region0;
//     }
//
// Why a `switch` inside a `while` and not a chain of `if`s: the region's
// blocks form an arbitrary graph, so the only correct thing to say is "jump to
// the block whose id is in `__pc`". `break` leaves the switch and the `while`
// re-dispatches, which is a direct, correct interpretation of the CFG. The
// `/* UNSTRUCTURED */` marker is required by 7 and the region is counted in
// the report either way.
//
// The dispatch value per block comes from the CFG, not from guessing:
//
//   one normal successor            `__pc = s`
//   a two-way terminator            `__pc = <test> ? taken : notTaken`, with
//                                   the test built by T8's own predicate
//                                   table (src/structure/facts.mjs), so a
//                                   `JumpIfUndefinedOrNull` is not read as
//                                   `if (value)`
//   a jump table                    a nested `switch` on the discriminant
//   a terminator that returns or
//   throws                          nothing: the block's own statements end it
//
// T8's fall-back is whole-function (docs/STRUCTURE.md 9.4), so an edge leaving
// the region should not exist. If one does it becomes `break <region label>`
// and is counted as `unstructuredExitEdge` rather than dropped.

import * as t from '@babel/types';
import { conditionalTest } from '../structure/conditions.mjs';
import { blockStatements } from './stmt.mjs';
import { testExpr } from './expr.mjs';
import { mark, noteStmt } from './holes.mjs';
import { sanitise } from './names.mjs';

/** The jump-table cases of a switch terminator, from the IR's own edges. */
function tableDispatch(ctx, blockId, pcName, inside) {
  const b = ctx.ir.blocks[blockId];
  const cases = [];
  let fallThrough = null;
  const seen = new Set();
  for (const eid of b.outEdges) {
    const e = ctx.ir.edges[eid];
    if (e.kind === 'exception') continue;
    if (e.kind === 'switch') {
      const key = `${e.caseValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({ value: e.caseValue, target: e.to });
    } else if (fallThrough === null) fallThrough = e.to;
  }
  if (!cases.length) return null;
  const disc = ctx.terminatorValueExpr(blockId, 'unstructuredSwitch');
  const body = cases.map((c) => t.switchCase(t.numericLiteral(Number(c.value)), [
    t.expressionStatement(t.assignmentExpression('=', t.identifier(pcName), t.numericLiteral(c.target))),
    t.breakStatement(null),
  ]));
  if (fallThrough !== null) {
    body.push(t.switchCase(null, [
      t.expressionStatement(t.assignmentExpression('=', t.identifier(pcName), t.numericLiteral(fallThrough))),
      t.breakStatement(null),
    ]));
  }
  void inside;
  return t.switchStatement(disc, body);
}

/**
 * @param {object} ctx  the per-function emit context
 * @param {object} region  `{r:'unstructured', blocks, dispatchVar, why, edges, entry}`
 */
export function unstructured(ctx, region) {
  const pcName = sanitise(region.dispatchVar ?? '__pc');
  const label = sanitise(`__region${region.entry ?? 0}`);
  ctx.needDispatchVar(pcName);
  ctx.report.unstructuredRegions++;
  ctx.report.unstructuredBlocks += (region.blocks ?? []).length;
  ctx.countHole(`unstructured:${region.why ?? 'unknown'}`, 'region');

  const inside = new Set(region.blocks ?? []);
  const edgesOf = new Map((region.edges ?? []).map((x) => [x.block, x]));
  const cases = [];

  for (const b of region.blocks ?? []) {
    const body = blockStatements(ctx, b);
    const info = edgesOf.get(b) ?? { succs: [], exits: [] };
    const succs = info.succs ?? [];
    const exits = info.exits ?? [];
    const setPc = (target) => t.expressionStatement(
      t.assignmentExpression('=', t.identifier(pcName), t.numericLiteral(target)));

    if (exits.length) {
      ctx.countHole('unstructuredExitEdge', 'region');
      body.push(mark(t.breakStatement(t.identifier(label)), `HOLE unstructuredExitEdge to block ${exits.join(',')}`));
    } else if (succs.length === 1) {
      body.push(setPc(succs[0]));
    } else if (succs.length >= 2) {
      const table = tableDispatch(ctx, b, pcName, inside);
      if (table) body.push(table);
      else {
        const test = conditionalTest(ctx.ir, ctx.facts, b, true);
        const taken = ctx.takenSuccessor(b);
        const other = succs.find((s) => s !== taken) ?? succs[0];
        if (test && taken !== null) {
          body.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(pcName),
            t.conditionalExpression(testExpr(ctx, test), t.numericLiteral(taken), t.numericLiteral(other)))));
        } else {
          body.push(mark(setPc(succs[0]), `HOLE unstructuredDispatchNotRecovered, successors ${succs.join(',')}`));
          ctx.countHole('unstructuredDispatchNotRecovered', 'region');
        }
      }
    }
    if (body.length === 0 || !endsControl(body[body.length - 1])) body.push(t.breakStatement(null));
    cases.push(t.switchCase(t.numericLiteral(b), body));
  }

  cases.push(t.switchCase(null, [t.breakStatement(t.identifier(label))]));

  const head = t.expressionStatement(t.assignmentExpression('=',
    t.identifier(pcName), t.numericLiteral(region.entry ?? (region.blocks ?? [0])[0] ?? 0)));
  mark(head, `UNSTRUCTURED ${region.why ?? 'unknown'} (${(region.blocks ?? []).length} blocks)`);
  const loop = t.labeledStatement(t.identifier(label),
    t.whileStatement(t.booleanLiteral(true), t.switchStatement(t.identifier(pcName), cases)));
  return [head, loop, noteStmt(`END UNSTRUCTURED ${region.why ?? 'unknown'}`)];
}

function endsControl(node) {
  return t.isReturnStatement(node) || t.isThrowStatement(node)
    || t.isBreakStatement(node) || t.isContinueStatement(node);
}

export default { unstructured };
