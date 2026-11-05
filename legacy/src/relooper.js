import * as t from '@babel/types';

/**
 * Pure JavaScript implementation of Relooper Algorithm with linear complexity
 * and exact merge point (immediate post-dominator) isolation.
 * Prevents branch blocks from prematurely consuming join points.
 */

export class RelooperBlock {
  constructor(id, statements = []) {
    this.id = id;
    this.statements = statements;
    this.branches = []; // { target: RelooperBlock, condition: ASTNode | null }
  }

  addBranch(target, condition = null) {
    this.branches.push({ target, condition });
  }
}

export class Relooper {
  constructor() {
    this.blocks = [];
  }

  addBlock(id, statements = []) {
    const block = new RelooperBlock(id, statements);
    this.blocks.push(block);
    return block;
  }

  _findMergeBlock(targetA, targetB) {
    if (!targetA || !targetB) return null;
    const getReachable = (start) => {
      const reachable = new Set();
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || reachable.has(cur.id)) continue;
        reachable.add(cur.id);
        for (const b of cur.branches) {
          if (b.target && !reachable.has(b.target.id)) {
            queue.push(b.target);
          }
        }
      }
      return reachable;
    };

    const reachA = getReachable(targetA);
    const reachB = getReachable(targetB);
    const common = [];
    for (const id of reachA) {
      if (reachB.has(id)) common.push(id);
    }
    if (common.length === 0) return null;
    common.sort((a, b) => a - b);
    return this.blocks.find(b => b.id === common[0]);
  }

  /**
   * Structures the CFG starting from entryBlock into an array of AST statements.
   */
  structure(entryBlock) {
    const visited = new Set();
    return this._processBlock(entryBlock, visited, null, null, 0);
  }

  _processBlock(block, visited, loopHeader, stopBlock = null, depth = 0) {
    if (!block || depth > 1000) return [];
    if (stopBlock && block.id === stopBlock.id) return [];

    if (visited.has(block.id)) {
      if (loopHeader && block.id === loopHeader.id) {
        return [t.continueStatement()];
      }
      return [];
    }

    visited.add(block.id);
    const result = [...block.statements];

    if (block.branches.length === 0) {
      return result;
    }

    if (block.branches.length === 1) {
      const target = block.branches[0].target;
      if (stopBlock && target.id === stopBlock.id) {
        return result;
      }
      const nextStmts = this._processBlock(target, visited, loopHeader, stopBlock, depth + 1);
      result.push(...nextStmts);
      return result;
    }

    if (block.branches.length === 2) {
      const condBranch = block.branches.find(b => b.condition !== null);
      if (!condBranch || !condBranch.condition) {
        throw new Error(`[Relooper] MissingBranchConditionError: Block ${block.id} has 2 branches but no condition was specified`);
      }
      const fallthroughBranch = block.branches.find(b => b !== condBranch);

      const trueTarget = condBranch.target;
      const falseTarget = fallthroughBranch ? fallthroughBranch.target : null;

      // While loop detection (self back-edge)
      if (trueTarget && trueTarget.id === block.id) {
        const loopStmts = this._processBlock(trueTarget, visited, block, stopBlock, depth + 1);
        const whileLoop = t.whileStatement(
          condBranch.condition,
          t.blockStatement(loopStmts)
        );
        result.push(whileLoop);

        if (falseTarget) {
          result.push(...this._processBlock(falseTarget, visited, loopHeader, stopBlock, depth + 1));
        }
        return result;
      }

      // Find merge block between trueTarget and falseTarget
      const merge = this._findMergeBlock(trueTarget, falseTarget);
      const branchStop = merge || stopBlock;

      let cond = condBranch.condition;
      let trueStmts = this._processBlock(trueTarget, visited, loopHeader, branchStop, depth + 1);
      let falseStmts = [];
      if (falseTarget) {
        falseStmts = this._processBlock(falseTarget, visited, loopHeader, branchStop, depth + 1);
      }


      // Normalize if (!cond) { A } else { B } to if (cond) { B } else { A }
      if (t.isUnaryExpression(cond, { operator: '!' }) && falseStmts.length > 0) {
        cond = cond.argument;
        const temp = trueStmts;
        trueStmts = falseStmts;
        falseStmts = temp;
      }

      let ifStmt;
      if (falseStmts.length > 0) {
        ifStmt = t.ifStatement(cond, t.blockStatement(trueStmts), t.blockStatement(falseStmts));
      } else if (trueStmts.length > 0) {
        ifStmt = t.ifStatement(cond, t.blockStatement(trueStmts));
      }

      if (ifStmt) {
        result.push(ifStmt);
      }

      // Continue from merge block if present
      if (merge && (!stopBlock || merge.id !== stopBlock.id)) {
        result.push(...this._processBlock(merge, visited, loopHeader, stopBlock, depth + 1));
      }

      return result;
    }

    // Multiple branches (e.g. Switch)
    const switchCases = [];
    for (const br of block.branches) {
      const caseStmts = this._processBlock(br.target, visited, loopHeader, stopBlock, depth + 1);
      caseStmts.push(t.breakStatement());
      switchCases.push(
        t.switchCase(br.condition, caseStmts)
      );
    }
    result.push(t.switchStatement(t.identifier('__state'), switchCases));
    return result;
  }
}
