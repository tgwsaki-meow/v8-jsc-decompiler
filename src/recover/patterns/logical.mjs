// src/recover/patterns/logical.mjs
//
// `&&`, `||`, `??` and the ternary.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitLogicalOrExpression   :8282   VisitLogicalOrSubExpression  :8225
//   VisitLogicalAndExpression  :8345   VisitLogicalAndSubExpression :8243
//   VisitNullishExpression     :8407   VisitNullishSubExpression    :8261
//   VisitConditional           :4103
//   VisitNaryLogical{Or,And,Nullish}Expression :8309 / :8372 / :8435
//
// Each sub-expression helper emits exactly one shape, and the recogniser is a
// phi at the join whose operands say which one:
//
//   a || b    <a> ; JumpIfTrue/JumpIfToBooleanTrue -> END ; <b> ; END:
//             so the phi operand on the edge FROM the branch block IS the
//             value the branch tested.
//   a && b    the same with JumpIfFalse / JumpIfToBooleanFalse.
//   a ?? b    <a> ; JumpIfUndefinedOrNull -> NIL ; Jump -> END ; NIL: <b> ; END:
//             note the double jump: the "keep a" path goes through a block
//             whose only instruction is an unconditional Jump, and the branch's
//             TRUE edge is the one that evaluates b.
//   c ? t : e  VisitForTest(c) ; THEN: <t> ; Jump END ; ELSE: <e> ; END:
//             a phi whose two operands are produced in two different blocks,
//             NEITHER of which is the tested value.
//
// So `||`/`&&` are told from the ternary by one question -- is one phi operand
// the branch predicate itself? -- and `??` by the extra Jump block. That is a
// property of the emitted shape, not of the opcode name, which is why the same
// code recognises the `ToBoolean` and already-boolean variants together.
//
// The branch instruction is NOT consumed: the edge belongs to T8. What is
// claimed is the phi's expression. T8 will see a diamond it can structure as
// an `if`, and T9 prefers the expression because `recovered.exprs` has an
// entry for the phi (11.3 invariant 2). Both are consistent descriptions of
// the same bytecode; the join invariant is what keeps them aligned.

const TRUE_BRANCH = new Set(['JumpIfTrue', 'JumpIfTrueConstant', 'JumpIfToBooleanTrue', 'JumpIfToBooleanTrueConstant']);
const FALSE_BRANCH = new Set(['JumpIfFalse', 'JumpIfFalseConstant', 'JumpIfToBooleanFalse', 'JumpIfToBooleanFalseConstant']);
const NIL_BRANCH = new Set(['JumpIfUndefinedOrNull', 'JumpIfUndefinedOrNullConstant']);

export function run(pc) {
  const ir = pc.ir;
  for (const b of ir.blocks) {
    for (const pid of b.phis ?? []) {
      const phi = ir.values[pid];
      if (!phi || phi.operands.length !== 2) continue;
      if (pc.hasExpr(pid)) continue;
      if (shortCircuit(pc, b, phi)) continue;
      ternary(pc, b, phi);
    }
  }
}

/** `a || b`, `a && b`, `a ?? b`. */
function shortCircuit(pc, join, phi) {
  const ir = pc.ir;
  for (let j = 0; j < 2; j++) {
    const keepEdge = ir.edges[join.inEdges[j]];
    const otherEdge = ir.edges[join.inEdges[1 - j]];
    if (!keepEdge || !otherEdge) continue;
    const keepFrom = ir.blocks[keepEdge.from];
    const kept = phi.operands[j];
    const rest = phi.operands[1 - j];
    if (kept === null || rest === null) continue;

    // --- the direct form: the kept operand comes straight off a conditional
    //     branch on itself.
    const term = pc.terminatorOf(keepFrom);
    if (term && pc.sameValue(pc.accInputOf(term), kept)) {
      const op = term.op;
      if (TRUE_BRANCH.has(op) && keepEdge.kind === 'true') {
        return claim(pc, '||', join, phi, kept, rest, term, 'VisitLogicalOrSubExpression:8225');
      }
      if (FALSE_BRANCH.has(op) && keepEdge.kind === 'true') {
        return claim(pc, '&&', join, phi, kept, rest, term, 'VisitLogicalAndSubExpression:8243');
      }
    }

    // --- the nullish form: one predecessor is a block whose only instruction
    //     is the unconditional Jump that VisitNullishSubExpression emits, and
    //     whose own predecessor branched on JumpIfUndefinedOrNull.
    if (keepFrom && isBareJump(pc, keepFrom) && keepFrom.normalPreds?.length === 1) {
      const branchBlock = ir.blocks[keepFrom.normalPreds[0]];
      const bt = pc.terminatorOf(branchBlock);
      if (bt && NIL_BRANCH.has(bt.op) && pc.sameValue(pc.accInputOf(bt), kept)) {
        pc.consumeBlock(keepFrom.id);
        return claim(pc, '??', join, phi, kept, rest, bt, 'VisitNullishSubExpression:8261');
      }
    }
  }
  return false;
}

function claim(pc, op, join, phi, kept, rest, term, cite) {
  pc.setExpr(phi.id, () => ({ e: 'logical', op, l: pc.E(kept), r: pc.E(rest) }));
  pc.claim({
    kind: op === '&&' ? 'logicalAnd' : (op === '||' ? 'logicalOr' : 'nullish'),
    blocks: [join.id, term.block], values: [phi.id, kept, rest],
    instructions: [], confidence: 'exact', cites: [cite], detail: op,
  });
  return true;
}

/** `c ? t : e` -- VisitConditional. */
function ternary(pc, join, phi) {
  const ir = pc.ir;
  if (join.inEdges.length !== 2) return false;
  const e0 = ir.edges[join.inEdges[0]];
  const e1 = ir.edges[join.inEdges[1]];
  if (!e0 || !e1) return false;
  if (e0.kind === 'exception' || e1.kind === 'exception') return false;

  // both arms must be single-entry blocks dominated by one branch block
  const a = ir.blocks[e0.from];
  const b = ir.blocks[e1.from];
  if (!a || !b) return false;
  const branch = commonBranch(pc, a, b);
  if (!branch) return false;
  const term = pc.terminatorOf(branch);
  if (!term) return false;
  const test = pc.accInputOf(term);
  if (test === null || test === undefined) return false;
  if (pc.sameValue(test, phi.operands[0]) || pc.sameValue(test, phi.operands[1])) return false;

  // which arm is the `then`: the one reached by the edge the branch's own
  // predicate selects. edge.kind 'true' is the jump target (docs/IR.md 3).
  const negate = FALSE_BRANCH.has(term.op) || NIL_BRANCH.has(term.op);
  const trueSideIsFirst = reachesFrom(pc, branch, 'true', a.id);
  const thenOperand = trueSideIsFirst ? phi.operands[0] : phi.operands[1];
  const elseOperand = trueSideIsFirst ? phi.operands[1] : phi.operands[0];
  if (thenOperand === null || elseOperand === null) return false;

  pc.setExpr(phi.id, () => {
    const t = pc.E(test);
    return negate
      ? { e: 'cond', test: { e: 'unary', op: '!', arg: t }, then: pc.E(thenOperand), alt: pc.E(elseOperand) }
      : { e: 'cond', test: t, then: pc.E(thenOperand), alt: pc.E(elseOperand) };
  });
  pc.claim({
    kind: 'ternary', blocks: [join.id, branch.id, a.id, b.id],
    values: [phi.id, test, thenOperand, elseOperand], instructions: [],
    confidence: 'exact', cites: ['VisitConditional:4103'], detail: null,
  });
  return true;
}

/** The nearest block that branches to both arms. */
function commonBranch(pc, a, b) {
  const ir = pc.ir;
  const up = (x) => {
    // the arm block itself, when it is a single-predecessor block
    if (x.normalPreds?.length === 1) return ir.blocks[x.normalPreds[0]];
    return null;
  };
  const ca = up(a), cb = up(b);
  if (ca && ca.id === b.id) return ca;        // then-arm falls into the join
  if (cb && cb.id === a.id) return cb;
  if (ca && cb && ca.id === cb.id) return ca;
  if (ca && ca.id === (cb?.id ?? -1)) return ca;
  // one arm may be the branch block itself (the fall-through side)
  if (ca && ca.id === a.id) return null;
  if ((a.normalSuccs ?? []).length === 2 && (a.normalSuccs ?? []).includes(b.id)) return a;
  if ((b.normalSuccs ?? []).length === 2 && (b.normalSuccs ?? []).includes(a.id)) return b;
  return ca && cb ? null : (ca ?? cb ?? null);
}

function reachesFrom(pc, branch, edgeKind, blockId) {
  const ir = pc.ir;
  for (const eid of branch.outEdges ?? []) {
    const e = ir.edges[eid];
    if (!e || e.kind !== edgeKind) continue;
    if (e.to === blockId) return true;
    const t = ir.blocks[e.to];
    if (t && (t.normalSuccs ?? []).includes(blockId) && (t.normalPreds ?? []).length === 1) return true;
  }
  return false;
}

function isBareJump(pc, b) {
  if (b.first !== b.last) return false;
  const ins = pc.ir.instructions[b.last];
  return ins && ins.jumpTarget !== null && ins.jumpTarget !== undefined
    && !pc.ir.values[pc.ir.instructionValue[b.last]]?.sem?.accumulator?.read;
}

export default { name: 'logical', run };
