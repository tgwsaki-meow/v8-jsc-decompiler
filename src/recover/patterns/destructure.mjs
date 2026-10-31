// src/recover/patterns/destructure.mjs
//
// Destructuring, default values and rest.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   BuildDestructuringArrayAssignment  :5464
//   BuildDestructuringObjectAssignment :5638
//   BuildAssignment                    :5773
//   VisitAssignment                    :5868
//
// The piece T7 can recover on its own is the DEFAULT VALUE, which both
// builders emit as the same three lines (BuildDestructuringObjectAssignment's
// "if (pattern->value()->IsOptionalChain() ... default_value" arm and its array
// twin):
//
//     <the extracted value>
//     JumpIfNotUndefined -> done        (or JumpIfUndefined to the default)
//     <the default expression>
//   done:
//
// which is a two-operand phi whose non-default operand is exactly the value the
// branch tested, with `undefined` as the predicate. That is NOT `??`
// (VisitNullishSubExpression branches on JumpIfUndefinedOrNull, i.e. null too)
// and not `||` (JumpIfToBooleanFalse), so the three are told apart by which
// test the branch uses -- a property of the emitted shape.
//
// The result is `v === undefined ? dflt : v`, which needs `v` twice, so the
// extracted value is forced to materialise into a named temp first; a name is
// a leaf expression and therefore in `duplicable`, which is how invariant
// 11.3.4 stays true (the alternative -- copying the extraction -- is exactly
// the 12.93% re-evaluation the baseline had).
//
// The PATTERN itself (which binding each extracted value belongs to) is not
// recovered here: `[a, b] = x` and `a = x[0], b = x[1]` emit the same
// instructions apart from the iterator protocol, so claiming a pattern from
// the bytecode alone would be an invention. The array form goes through
// forof.mjs's iterator recogniser and the object form through plain property
// loads; what is claimed here is the default, with its own `kind`.

const NOT_UNDEF = new Set(['JumpIfNotUndefined', 'JumpIfNotUndefinedConstant']);
const IS_UNDEF = new Set(['JumpIfUndefined', 'JumpIfUndefinedConstant']);

export function run(pc) {
  const ir = pc.ir;
  for (const b of ir.blocks) {
    for (const pid of b.phis ?? []) {
      const phi = ir.values[pid];
      if (!phi || phi.operands.length !== 2) continue;
      if (pc.hasExpr(pid)) continue;
      match(pc, b, phi);
    }
  }

  // %ThrowPatternAssignmentNonCoercible: the null check at the head of an
  // object pattern. Consumed by runtime.mjs; claimed here so the count shows.
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (pc.runtimeNameOf(v) !== 'ThrowPatternAssignmentNonCoercible') continue;
    pc.claim({
      kind: 'destructure', blocks: [v.block], values: [v.id],
      instructions: [v.instruction], confidence: 'exact',
      cites: ['BuildDestructuringObjectAssignment:5638'],
      detail: 'non-coercible guard: the head of an object pattern',
    });
  }
}

function match(pc, join, phi) {
  const ir = pc.ir;
  for (let j = 0; j < 2; j++) {
    const keepEdge = ir.edges[join.inEdges[j]];
    if (!keepEdge) continue;
    const from = ir.blocks[keepEdge.from];
    const term = pc.terminatorOf(from);
    if (!term) continue;
    const tested = pc.accInputOf(term);
    const kept = phi.operands[j];
    const dflt = phi.operands[1 - j];
    if (kept === null || dflt === null) continue;
    if (!pc.sameValue(tested, kept)) continue;

    let isDefault = false;
    if (NOT_UNDEF.has(term.op) && keepEdge.kind === 'true') isDefault = true;
    // the inverted spelling: JumpIfUndefined jumps to the default, so the
    // kept value arrives on the FALSE edge
    else if (IS_UNDEF.has(term.op) && keepEdge.kind === 'false') isDefault = true;
    if (!isDefault) continue;

    pc.forceMaterialise(pc.canon(kept));
    pc.setExpr(phi.id, () => {
      const v = pc.E(kept);
      return {
        e: 'cond',
        test: { e: 'bin', op: '===', l: v, r: { e: 'lit', v: undefined } },
        then: pc.E(dflt),
        alt: pc.E(kept),
      };
    });
    pc.claim({
      kind: 'destructureDefault', blocks: [join.id, from.id],
      values: [phi.id, kept, dflt], instructions: [], confidence: 'exact',
      cites: ['BuildDestructuringArrayAssignment:5464', 'BuildDestructuringObjectAssignment:5638'],
      detail: null,
    });
    return true;
  }
  return false;
}

export default { name: 'destructure', run };
