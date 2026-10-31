// src/recover/patterns/update.mjs
//
// `++x`, `--x`, `x++`, `x--`.
//
// Inverts VisitCountOperation, src/interpreter/bytecode-generator.cc:7390
// @ 14.4.258.16, which says in its own comment what the shape is:
//
//     // Save result for postfix expressions.
//     if (is_postfix) {
//       // Convert old value into a number before saving it.
//       // TODO(ignition): Think about adding proper PostInc/PostDec bytecodes
//       // instead of this ToNumeric + Inc/Dec dance.
//       builder()->ToNumeric(slot).StoreAccumulatorInRegister(old_value);
//     }
//     builder()->UnaryOperation(expr->op(), slot);     // Inc / Dec
//     <store back to the same reference>
//     if (is_postfix) builder()->LoadAccumulatorWithRegister(old_value);
//
// so:
//   prefix   <load ref> ; Inc ; <store ref>                  value = new
//   postfix  <load ref> ; ToNumeric ; Star old ; Inc ;
//            <store ref> ; Ldar old                          value = old
//
// The recogniser is anchored on `Inc`/`Dec` and asks two questions: does its
// input come (through the optional ToNumeric) from a load of some reference R,
// and is its result stored back into that same R? Both have to hold, because
// `x + 1` also compiles to `AddSmi` and a plain `Inc` can appear on its own
// (the for-in index step, which forin.mjs claims first).
//
// Without the pattern the fall-back in expr.mjs is `x + 1` / `x - 1`, which is
// the same program for every operand except a BigInt -- `Inc` is ToNumeric then
// add, so `1n++` is `2n` while `1n + 1` throws. That residue is in
// docs/RECOVER.md's gap list; the pattern removes it wherever it matches.

export function run(pc) {
  const ir = pc.ir;
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (v.op !== 'Inc' && v.op !== 'Dec') continue;
    if (pc.isConsumed(v.instruction)) continue;
    match(pc, v);
  }
}

function match(pc, inc) {
  const ir = pc.ir;
  const op = inc.op === 'Inc' ? '++' : '--';

  // the operand, through an optional ToNumeric
  let srcId = pc.canon(pc.accInputOf(inc));
  let src = ir.values[srcId];
  let postfixConv = null;
  if (src?.kind === 'Op' && src.op === 'ToNumeric') {
    postfixConv = src;
    srcId = pc.canon(pc.accInputOf(src));
    src = ir.values[srcId];
  }
  const ref = referenceOf(pc, src);
  if (!ref) return;

  // the store back: the single use of the Inc's value must write the same ref
  const uses = pc.usesOf(inc.id);
  if (uses.length !== 1) return;
  const store = ir.values[uses[0]];
  if (!store || store.kind !== 'Op') return;
  const written = referenceOf(pc, store, { store: true });
  if (!written || !sameRef(ref, written)) return;

  // postfix: the old value survives in a register and is read after the store
  const isPostfix = postfixConv !== null
    && pc.usesOf(postfixConv.id).some((u) => u !== inc.id);

  const update = { e: 'update', op, prefix: !isPostfix, arg: null };
  pc.setExpr(store.id, () => ({ ...update, arg: ref.target() }));
  pc.setStmt(store.id, () => ({ s: 'expr', expr: { ...update, arg: ref.target() } }));
  pc.setExpr(inc.id, () => ({ ...update, arg: ref.target() }));
  if (postfixConv) {
    pc.setExpr(postfixConv.id, () => ({ e: 'update', op, prefix: false, arg: ref.target() }));
    pc.consume(postfixConv.instruction);
  }
  pc.consume(inc.instruction);

  pc.claim({
    kind: 'update', blocks: [inc.block], values: [inc.id, store.id],
    instructions: [inc.instruction, store.instruction].filter((x) => x !== undefined),
    confidence: 'exact', cites: ['VisitCountOperation:7390'],
    detail: `${isPostfix ? 'postfix' : 'prefix'} ${op}`,
  });
}

/**
 * The reference a load or a store names: a context slot, a global, a named or
 * keyed property, or a register-held local. Returns a descriptor with a thunk
 * that rebuilds the reference expression, so the target appears exactly once in
 * the output.
 */
function referenceOf(pc, v, opts = {}) {
  if (!v || v.kind !== 'Op') return null;
  const store = !!opts.store;
  const cs = v.contextSlot;
  if (cs && (store ? cs.mode === 'store' : cs.mode === 'load')) {
    return { k: 'contextSlot', slot: cs.slotValue, target: () => pc.contextSlotName(v) };
  }
  switch (v.op) {
    case 'LdaGlobal':
    case 'StaGlobal': {
      const n = pc.nameOperandOf(v);
      if (n === null) return null;
      return { k: 'global', name: n, target: () => ({ e: 'name', name: n, ref: { k: 'global' } }) };
    }
    case 'GetNamedProperty':
    case 'SetNamedProperty': {
      const n = pc.nameOperandOf(v);
      const objId = pc.firstRegInput(v);
      if (n === null || objId === null) return null;
      return {
        k: 'named', name: n, obj: pc.canon(objId),
        target: () => ({ e: 'member', obj: pc.E(objId), prop: n, computed: false, optional: false }),
      };
    }
    case 'GetKeyedProperty':
    case 'SetKeyedProperty': {
      const objId = pc.firstRegInput(v);
      const keyId = store ? pc.flatRegInputs(v)[1] : pc.accInputOf(v);
      if (objId === null || keyId === null || keyId === undefined) return null;
      return {
        k: 'keyed', obj: pc.canon(objId), key: pc.canon(keyId),
        target: () => ({ e: 'member', obj: pc.E(objId), prop: pc.E(keyId), computed: true, optional: false }),
      };
    }
    default:
      return null;
  }
}

function sameRef(a, b) {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'contextSlot': return a.slot === b.slot;
    case 'global': return a.name === b.name;
    case 'named': return a.name === b.name && a.obj === b.obj;
    case 'keyed': return a.obj === b.obj && a.key === b.key;
    default: return false;
  }
}

export default { name: 'update', run };
