// src/recover/patterns/optional.mjs
//
// `a?.b`, `a?.[k]`, `a?.()` and `delete a?.b`.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   BuildOptionalChain   :6704   VisitOptionalChain :6714
//   VisitPropertyLoad    :6404   (the is_optional_chain_link arm)
//   VisitCall            :6738   (the optional-call arm)
//   VisitDelete          :7301
//
// BuildOptionalChain is four lines and they are the whole recogniser:
//
//     <chain expression, which jumps to the null label on each ?. link>
//     Jump -> done
//   null_label:
//     LdaUndefined
//   done:
//
// and each link inside it emits, from VisitPropertyLoad:
//
//     Ldar <obj> ; JumpIfUndefinedOrNull -> null_label
//
// So the join has a phi one of whose operands comes from a block that loads
// `undefined` and nothing else, and that block's predecessors all branch on
// `JumpIfUndefinedOrNull`. That is unambiguous against `??`
// (VisitNullishSubExpression), where the short-circuit path keeps the tested
// value rather than replacing it with `undefined`, and against a ternary,
// where neither arm is a bare `LdaUndefined` reached from a nil test.
//
// The rewrite marks `optional:true` on the member or call at the end of the
// chain and leaves the chain itself alone, so `a?.b.c` comes back as
// `a?.b.c` rather than `a?.b?.c`.

const NIL_BRANCH = new Set(['JumpIfUndefinedOrNull', 'JumpIfUndefinedOrNullConstant']);

export function run(pc) {
  const ir = pc.ir;
  for (const b of ir.blocks) {
    for (const pid of b.phis ?? []) {
      const phi = ir.values[pid];
      if (!phi || phi.operands.length < 2) continue;
      if (pc.hasExpr(pid)) continue;
      match(pc, b, phi);
    }
  }
}

function match(pc, join, phi) {
  const ir = pc.ir;
  // find the operand that is the short-circuit `undefined`
  let nilIdx = -1;
  for (let j = 0; j < phi.operands.length; j++) {
    const o = phi.operands[j];
    if (o === null) continue;
    const e = pc.exprOf(pc.canon(o));
    if (!(e && e.e === 'lit' && e.v === undefined)) continue;
    const from = ir.blocks[ir.edges[join.inEdges[j]]?.from];
    if (!from) continue;
    if (!reachedByNilTests(pc, from)) continue;
    nilIdx = j;
    break;
  }
  if (nilIdx < 0) return false;

  // every other operand is a value of the chain
  const others = [];
  for (let j = 0; j < phi.operands.length; j++) {
    if (j === nilIdx) continue;
    if (phi.operands[j] !== null) others.push(phi.operands[j]);
  }
  if (others.length !== 1) return false;
  const chainValue = others[0];

  // The canonical description stays the destructed phi (see
  // src/recover/index.mjs's header on why an idiom's rewrite of a phi is an
  // alternative rather than the canonical form). What the claim adds is: this
  // join is an optional chain, the short-circuit value is `undefined`, and the
  // chain's own value is `chainValue` -- which is what lets T9 print
  // `a?.b` instead of the diamond.
  const link = outermostLink(pc, chainValue);
  pc.setAltExpr(phi.id, () => {
    const e = pc.E(chainValue);
    return e && (e.e === 'member' || e.e === 'call') ? { ...e, optional: true } : e;
  });
  pc.consumeBlock(ir.blocks[ir.edges[join.inEdges[nilIdx]].from].id);
  pc.claim({
    kind: 'optionalChain', blocks: [join.id], values: [phi.id, chainValue],
    instructions: [], confidence: link ? 'exact' : 'shape',
    cites: ['BuildOptionalChain:6704', 'VisitPropertyLoad:6404'],
    detail: link ? `?.${link}` : 'optional chain with no member/call at its end',
  });
  return true;
}

/** The member or call at the end of the chain, for the claim's detail. */
function outermostLink(pc, chainValue) {
  const e = pc.exprOf(pc.canon(chainValue));
  if (!e) return null;
  if (e.e === 'member') return typeof e.prop === 'string' ? e.prop : '[]';
  if (e.e === 'call') return '()';
  return null;
}

/* eslint-disable no-unused-vars */
/** Does every normal predecessor of `b` end in a nil test? */
function reachedByNilTests(pc, b) {
  const preds = b.normalPreds ?? [];
  if (!preds.length) return false;
  let nil = 0;
  for (const p of preds) {
    const t = pc.terminatorOf(pc.ir.blocks[p]);
    if (t && NIL_BRANCH.has(t.op)) nil++;
  }
  return nil > 0 && nil === preds.length;
}

export default { name: 'optional', run };
