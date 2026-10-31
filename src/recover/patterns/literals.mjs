// src/recover/patterns/literals.mjs
//
// Object literals, array literals, template literals, tagged templates.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   BuildCreateObjectLiteral  :4179   VisitObjectLiteral     :4190
//   BuildCreateArrayLiteral   :4508   VisitArrayLiteral      :4668
//   VisitTemplateLiteral      :8069   VisitGetTemplateObject :8061
//   VisitRegExpLiteral        :4172
//
// VisitObjectLiteral emits the constant part as an
// ObjectBoilerplateDescription (src/heap decodes it, so those properties are
// already in the expression expr.mjs built) and then one
// `DefineNamedOwnProperty` / `DefineKeyedOwnPropertyInLiteral` per property
// the boilerplate cannot hold: a computed key, an accessor, a spread, or a
// value that is not a compile-time constant. The fold below puts them back.
//
// Why `DefineNamedOwnProperty` is safe to fold and `SetNamedProperty` is not:
// the generator emits the Define* forms only while building a literal (or a
// class body); an ordinary `o.x = v` is `SetNamedProperty`. So a Define* store
// into a register holding a freshly created literal is a property of that
// literal and nothing else.
//
// Ordering is preserved exactly: a literal evaluates its property values in
// source order after the (empty) object exists, which is the same order the
// Define* stores appear in. The fold stops at the first effect-chain member
// that is neither one of those stores nor part of computing one, so an
// interleaved unrelated effect leaves the stores as statements instead of
// being silently hoisted.

const DEFINE_NAMED = new Set(['DefineNamedOwnProperty']);
const DEFINE_KEYED = new Set(['DefineKeyedOwnPropertyInLiteral', 'DefineKeyedOwnProperty']);
const ARRAY_STORE = new Set(['StaInArrayLiteral']);
const OBJ_CTORS = new Set(['CreateObjectLiteral', 'CreateEmptyObjectLiteral']);
const ARR_CTORS = new Set(['CreateArrayLiteral', 'CreateEmptyArrayLiteral']);

export function run(pc) {
  const ir = pc.ir;

  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (OBJ_CTORS.has(v.op)) foldObject(pc, v);
    else if (ARR_CTORS.has(v.op)) foldArray(pc, v);
  }

  // templates
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (v.op === 'GetTemplateObject') taggedTemplate(pc, v);
  }
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (v.op === 'Add' || v.op === 'Add_StringConstant_Internalize') template(pc, v);
  }

  // regexps need no pattern -- one opcode, one literal -- but they are counted
  // so docs/RECOVER.md's table has a row with a number.
  for (const v of ir.values) {
    if (v?.kind === 'Op' && v.op === 'CreateRegExpLiteral') {
      pc.claim({
        kind: 'regexp', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['VisitRegExpLiteral:4172'], detail: null,
      });
    }
  }
}

function foldObject(pc, ctor) {
  const stores = collectStores(pc, ctor, (op) => DEFINE_NAMED.has(op) || DEFINE_KEYED.has(op));
  if (!stores.length) return;
  const consumed = [];
  for (const s of stores) {
    const sv = s.value;
    // one entry per store, ordered by the store's own instruction index, so
    // the literal's property order is the emission order and therefore the
    // source order -- and so two runs produce the same list.
    pc.addObjectProperty(ctor.id, sv.instruction, () => ({
      key: s.named ? s.name : pc.E(s.keyValue),
      computed: !s.named,
      value: pc.E(pc.accInputOf(sv)),
      kind: 'init',
    }));
    consumed.push(sv.instruction);
    pc.consume(sv.instruction);
  }
  pc.claim({
    kind: 'objectLiteral', blocks: [ctor.block], values: [ctor.id],
    instructions: consumed, confidence: 'exact',
    cites: ['VisitObjectLiteral:4190', 'BuildCreateObjectLiteral:4179'],
    detail: `${consumed.length} propert${consumed.length === 1 ? 'y' : 'ies'} defined at run time`,
  });
}

function foldArray(pc, ctor) {
  const stores = collectStores(pc, ctor, (op) => ARRAY_STORE.has(op));
  if (!stores.length) return;
  const consumed = [];
  const pending = [];
  for (const s of stores) {
    const idxExpr = s.keyValue === null ? null : pc.exprOf(pc.canon(s.keyValue));
    if (!idxExpr || idxExpr.e !== 'lit' || typeof idxExpr.v !== 'number') break;
    pending.push({ index: idxExpr.v, value: s.value });
    consumed.push(s.value.instruction);
  }
  if (!pending.length) return;
  for (const p of pending) {
    pc.addArrayElement(ctor.id, p.index, () => pc.E(pc.accInputOf(p.value)));
  }
  for (const i of consumed) pc.consume(i);
  pc.claim({
    kind: 'arrayLiteral', blocks: [ctor.block], values: [ctor.id],
    instructions: consumed, confidence: 'exact',
    cites: ['VisitArrayLiteral:4668', 'BuildCreateArrayLiteral:4508'],
    detail: `${pending.length} element(s) stored at run time`,
  });
}

/**
 * The Define / Sta stores into the register that holds `ctor`'s value, in
 * instruction order, stopping at the first effect-chain member that is neither
 * such a store nor part of computing one.
 */
function collectStores(pc, ctor, isStore) {
  const ir = pc.ir;
  const b = ir.blocks[ctor.block];
  if (!b) return [];
  const chain = b.effects ?? [];
  const start = chain.indexOf(ctor.id);
  const out = [];
  // the set of store instructions we are willing to fold, grown as we go
  const targetIns = new Set();
  const candidates = [];
  for (let j = (start >= 0 ? start + 1 : 0); j < chain.length; j++) {
    const m = ir.values[chain[j]];
    if (!m || m.kind !== 'Op') break;
    if (isStore(m.op) && pc.sameValue(pc.firstRegInput(m), ctor.id)) {
      candidates.push(m);
      targetIns.add(m.instruction);
      continue;
    }
    // part of computing one of the following property values?
    if (pc.feedsOnly(m.id, (userV) => isStore(userV.op) && pc.sameValue(pc.firstRegInput(userV), ctor.id))) continue;
    break;
  }
  for (const m of candidates) {
    const ins = ir.instructions[m.instruction];
    const nameConst = ins.operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
    const regs = pc.flatRegInputs(m);
    out.push({
      value: m,
      named: DEFINE_NAMED.has(m.op),
      name: nameConst?.t === 'string' ? nameConst.v : null,
      keyValue: regs[1] ?? null,
    });
  }
  // a named store whose key is not a string cannot be folded honestly
  return out.filter((s) => (s.named ? s.name !== null : s.keyValue !== null));
}

/**
 * VisitTemplateLiteral. The tell is the `ToString` the generator inserts
 * before each non-string substitution:
 *
 *     LdaConstant "a" ; Star r ; <sub> ; ToString ; Add r ; ...
 *
 * so a `+` whose right operand is a ToString and whose left is (transitively)
 * a string literal is a template and not source-level concatenation. When
 * every substitution is already a string V8 emits no ToString, the two are
 * indistinguishable, and nothing is claimed -- the output is a `+` chain,
 * which is the same program.
 */
function template(pc, add) {
  const l = pc.firstRegInput(add);
  const r = pc.accInputOf(add);
  const rv = pc.ir.values[pc.canon(r)];
  if (!rv || rv.kind !== 'Op' || rv.op !== 'ToString') return;
  // only claim the OUTERMOST add of the chain
  const uses = pc.usesOf(add.id).map((u) => pc.ir.values[u]).filter(Boolean);
  if (uses.some((u) => u.kind === 'Op' && (u.op === 'Add' || u.op === 'ToString'))) return;

  const parts = [];
  if (!flattenTemplate(pc, add.id, parts)) return;
  if (!parts.some((p) => p.kind === 'expr')) return;

  const quasis = [];
  const exprs = [];
  let acc = '';
  for (const p of parts) {
    if (p.kind === 'str') { acc += p.v; continue; }
    quasis.push({ raw: acc, cooked: acc });
    acc = '';
    exprs.push(p.value);
  }
  quasis.push({ raw: acc, cooked: acc });

  pc.setExpr(add.id, () => ({
    e: 'template', quasis, exprs: exprs.map((id) => pc.E(id)),
  }));
  pc.claim({
    kind: 'template', blocks: [add.block], values: [add.id], instructions: [],
    confidence: 'exact', cites: ['VisitTemplateLiteral:8069'],
    detail: `${exprs.length} substitutions`,
  });
}

/** Left-leaning `+` chain -> alternating string constants and substitutions. */
function flattenTemplate(pc, id, out, depth = 0) {
  if (depth > 64) return false;
  const v = pc.ir.values[pc.canon(id)];
  if (!v) return false;
  if (v.kind === 'Op' && (v.op === 'Add' || v.op === 'Add_StringConstant_Internalize')) {
    if (!flattenTemplate(pc, pc.firstRegInput(v), out, depth + 1)) return false;
    return flattenTemplate(pc, pc.accInputOf(v), out, depth + 1);
  }
  if (v.kind === 'Op' && v.op === 'ToString') {
    out.push({ kind: 'expr', value: pc.accInputOf(v) });
    pc.consume(v.instruction);
    return true;
  }
  const e = pc.exprOf(v.id);
  if (e?.e === 'lit' && typeof e.v === 'string') { out.push({ kind: 'str', v: e.v }); return true; }
  out.push({ kind: 'expr', value: v.id });
  return true;
}

/** VisitGetTemplateObject + the call that consumes it: a tagged template. */
function taggedTemplate(pc, v) {
  const uses = pc.usesOf(v.id);
  const call = uses.map((u) => pc.ir.values[u]).find((u) => u?.kind === 'Op' && pc.isCall(u));
  const e = pc.exprOf(v.id);
  if (!call || e?.e !== 'templateObject') {
    pc.claim({
      kind: 'taggedTemplate', blocks: [v.block], values: [v.id], instructions: [],
      confidence: 'shape', cites: ['VisitGetTemplateObject:8061'],
      detail: 'template object with no recognised tag call',
    });
    return;
  }
  const args = pc.flatRegInputs(call);
  // CallProperty/CallUndefinedReceiver: args[0] is the receiver, then the
  // template object, then the substitutions.
  const subs = args.slice(args.indexOf(pc.canon(v.id)) + 1);
  const quasis = (e.cooked ?? []).map((c, i) => ({
    raw: (e.raw ?? [])[i] ?? c ?? '', cooked: c ?? null,
  }));
  pc.setExpr(call.id, () => ({
    e: 'tagged',
    tag: pc.E(pc.firstRegInput(call)),
    quasi: { e: 'template', quasis, exprs: subs.map((id) => pc.E(id)) },
  }));
  pc.consume(v.instruction);
  pc.claim({
    kind: 'taggedTemplate', blocks: [v.block], values: [v.id, call.id],
    instructions: [v.instruction], confidence: 'exact',
    cites: ['VisitGetTemplateObject:8061', 'VisitCall:6738'],
    detail: `${subs.length} substitutions`,
  });
}

export default { name: 'literals', run };
