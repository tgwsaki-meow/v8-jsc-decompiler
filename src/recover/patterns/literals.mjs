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
// ---------------------------------------------------------------- ORDERING
//
// This file used to say "ordering is preserved exactly ... the same order the
// Define* stores appear in", and that was wrong in a way docs/O1.md 6.9
// measured: 122 corpus functions emitted the keys of an object literal in the
// WRONG ORDER, which `Object.keys` / `for...in` / `JSON.stringify` observe.
// `{fn: g(), await: false}` came back out as `{await: false, fn: g()}`.
//
// The store order is not the property order, because an object literal has
// TWO parts and only the second is ordered by emission.
// `VisitObjectLiteral:4336` says so in V8's own words: the static part on the
// left carries no computed property names, so its map is computed ahead of
// time and "arranges for the map of the result to reflect the static order in
// which the keys appear"; the dynamic part, from the first computed name
// rightwards, is a series of stores and "will preserve insertion order".
//
// So for the static part the boilerplate -- not the bytecode order -- IS the
// authority, and it holds every static key, including the ones whose value is
// computed at run time: `VisitObjectLiteral:4262` fills those in with
// `DefineNamedOwnProperty` and its comment is "the boilerplate already
// contains computed properties with an uninitialized value". The decoder keeps
// those placeholder entries (`src/heap/objects.mjs::decodeObjectBoilerplate`
// returns `entries` in the description's own order, hole value and all), and
// `src/recover/expr.mjs::objectBoilerplateExpr:762` drops them -- counting
// them as `pendingEntries` -- so by the time the stores are folded back the
// POSITION each one belongs at is no longer in the expression. The literal
// fold's props were then appended after the constant ones
// (`src/recover/index.mjs::withLiteralFolds:613`), which is the reorder.
//
// `staticPlan` below recovers those positions and hands them to
// `src/emit/expr.mjs::staticOrder`, which puts the two groups back in
// boilerplate order. The correspondence is total and checked, never guessed:
// the k-th placeholder entry must be filled by the k-th store and their KEYS
// must agree, because `VisitObjectLiteral:4247` walks the properties once, in
// source order, skipping only the compile-time-constant ones. Anything that
// does not line up is refused by name (`ORDER_REFUSALS`), leaving the old
// append order and a counted warning rather than a guess.
//
// The fold stops at the first effect-chain member that is neither one of those
// stores nor part of computing one, so an interleaved unrelated effect leaves
// the stores as statements instead of being silently hoisted.

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
  const plan = staticPlan(pc, ctor, stores);
  // `noStatic` is not a refusal: `CreateEmptyObjectLiteral` and the canonical
  // empty root have no static part at all, so every store belongs to the
  // dynamic one and appending them IS V8's order (VisitObjectLiteral:4336).
  if (plan.reason && !plan.noStatic) {
    pc.warn('objectLiteralStaticOrderUnclaimed', {
      reason: plan.reason, detail: plan.detail ?? null,
      offset: pc.ir.instructions[ctor.instruction]?.offset ?? null,
    });
  }
  const consumed = [];
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    const sv = s.value;
    // The order is the store's own instruction index, which is the source
    // order WITHIN each of the literal's two parts and is what the dynamic
    // part needs. `at` is the static part's answer: the position the
    // boilerplate recorded for this key, which src/emit/expr.mjs puts the
    // property back at. A store with no `at` keeps today's append order --
    // either because it belongs to the dynamic part, where append IS the
    // answer, or because `staticPlan` refused.
    const at = plan.at?.get(i);
    pc.addObjectProperty(ctor.id, sv.instruction, () => {
      const p = {
        key: s.named ? s.name : pc.E(s.keyValue),
        computed: !s.named,
        value: pc.E(pc.accInputOf(sv)),
        kind: 'init',
      };
      if (at !== undefined) { p.bpAt = at; p.bpBase = plan.base; }
      return p;
    });
    consumed.push(sv.instruction);
    pc.consume(sv.instruction);
  }
  const placed = plan.at ? plan.at.size : 0;
  pc.claim({
    kind: 'objectLiteral', blocks: [ctor.block], values: [ctor.id],
    instructions: consumed, confidence: (plan.reason && !plan.noStatic) ? 'shape' : 'exact',
    cites: ['VisitObjectLiteral:4190', 'BuildCreateObjectLiteral:4179',
      'VisitObjectLiteral:4247', 'VisitObjectLiteral:4336'],
    detail: `${consumed.length} propert${consumed.length === 1 ? 'y' : 'ies'} defined at run time`
      + `; ${placed} placed at the position the boilerplate recorded`
      + ((plan.reason && !plan.noStatic) ? `; static order refused: ${plan.reason}` : ''),
  });
}

/**
 * The reasons the static part's order cannot be established from the
 * bytecode. Each one leaves the old append order in place and is warned about
 * by name; none of them is a guess, and none of them is reachable without the
 * boilerplate and the stores actually disagreeing.
 */
export const ORDER_REFUSALS = Object.freeze({
  noBoilerplate: 'the constructor carries no ObjectBoilerplateDescription -- '
    + '`CreateEmptyObjectLiteral` or the canonical empty root, so there is no static part '
    + 'and every store belongs to the dynamic one',
  entriesNotDecoded: 'the boilerplate decoded to no entries, so the static keys are unknown',
  duplicateBoilerplateKey: 'two static entries carry the same key. A later duplicate assigns '
    + 'into the property the earlier one created, so the key keeps its FIRST position and its '
    + 'LAST value, and which placeholder the one store belongs to is not in the bytecode '
    + '(`ObjectLiteral::CalculateEmitStore` drops the store for the shadowed one)',
  staticKeyNotDecoded: 'a placeholder entry\'s key is neither a string nor a number, so it '
    + 'cannot be matched against a store',
  fewerStoresThanPlaceholders: 'the boilerplate has more placeholder entries than there are '
    + 'folded stores to fill them, so `collectStores` stopped before the end of the static '
    + 'part and which placeholder the stores it DID find belong to is no longer forced. Two '
    + 'causes, both measured on the corpus: an accessor, which gets a static entry but is '
    + 'defined by VisitObjectLiteral:4323\'s runtime call rather than a Define* store; and an '
    + 'effect-chain member between two stores that is neither a store nor part of computing '
    + 'one, e.g. the `ThrowReferenceErrorIfHole` of a TDZ read. In the second case the '
    + 'emitted literal is already SHORT a property, which the oracle sees as a length '
    + 'difference, so the order is moot until that is fixed',
  storeKeyMismatch: 'the k-th store\'s key is not the k-th placeholder entry\'s key, which '
    + 'contradicts VisitObjectLiteral:4247 walking the properties once in source order',
  keyedStoreKeyNotALiteral: 'a keyed store in the static part has a non-literal key, which '
    + 'VisitObjectLiteral:4247 cannot emit (a computed name breaks out of that loop)',
});

/** Is this decoded boilerplate value V8's uninitialized placeholder? */
const isPlaceholder = (v) => !!v && (v.t === 'hole' || v.t === 'unresolved');

/**
 * An ObjectBoilerplateDescription key as a comparable signature.
 *
 * Mirrors `src/recover/expr.mjs::boilerplateKey` exactly, because the count of
 * entries it accepts is the length of the props array it produced, and
 * src/emit/expr.mjs cross-checks the two.
 */
function keySig(k) {
  if (!k) return null;
  if (k.t === 'string') return { t: 's', v: k.v };
  if (k.t === 'number') return { t: 'n', v: k.v };
  return null;
}

/** The ObjectBoilerplateDescription `ctor` was given, if it has one. */
function boilerplateOf(pc, ctor) {
  const ins = pc.ir.instructions[ctor.instruction];
  for (const o of ins?.operands ?? []) {
    if (o.constant?.t === 'objectBoilerplate') return o.constant;
  }
  return null;
}

/**
 * Where each static store belongs in the emitted object literal.
 *
 * @returns {{at: Map<number,number>, base: number, reason?: string}}
 *   `at` maps an index into `stores` to the property's position in the static
 *   block; `base` is how many constant properties `objectBoilerplateExpr`
 *   produced, which is where that block's appended part starts.
 */
function staticPlan(pc, ctor, stores) {
  const bp = boilerplateOf(pc, ctor);
  if (!bp) return { at: null, base: 0, reason: 'noBoilerplate', noStatic: true };
  const entries = bp.entries ?? [];
  if (!entries.length) return { at: null, base: 0, reason: 'entriesNotDecoded' };

  // The static block, in the boilerplate's own order. An entry whose value is
  // real is one of `objectBoilerplateExpr`'s props; an entry whose value is
  // the placeholder is a property a store fills. An entry that is NEITHER --
  // a real value under a key that does not decode -- is one that layer
  // already dropped and counted as `pendingEntries`, so it occupies no
  // position here either.
  const slots = [];
  const seen = new Set();
  let base = 0;
  for (const ent of entries) {
    const sig = keySig(ent.key);
    if (isPlaceholder(ent.value)) {
      if (!sig) return { at: null, base: 0, reason: 'staticKeyNotDecoded' };
      slots.push({ hole: true, sig });
    } else if (sig) {
      slots.push({ hole: false, sig });
      base++;
    } else {
      continue;
    }
    const tag = `${sig.t}:${String(sig.v)}`;
    if (seen.has(tag)) return { at: null, base: 0, reason: 'duplicateBoilerplateKey', detail: tag };
    seen.add(tag);
  }

  const holes = [];
  for (let i = 0; i < slots.length; i++) if (slots[i].hole) holes.push(i);
  if (stores.length < holes.length) {
    return {
      at: null, base: 0, reason: 'fewerStoresThanPlaceholders',
      detail: `${holes.length} placeholder(s), ${stores.length} store(s)`,
    };
  }

  // The k-th store fills the k-th placeholder, and its key must say so.
  const at = new Map();
  for (let k = 0; k < holes.length; k++) {
    const want = slots[holes[k]].sig;
    const got = storeKeySig(pc, stores[k]);
    if (got === null) return { at: null, base: 0, reason: 'keyedStoreKeyNotALiteral' };
    if (got.t !== want.t || got.v !== want.v) {
      return {
        at: null, base: 0, reason: 'storeKeyMismatch',
        detail: `store ${k} is ${got.t}:${String(got.v)}, entry is ${want.t}:${String(want.v)}`,
      };
    }
    at.set(k, holes[k]);
  }
  return { at, base };
}

/** A folded store's key as the same signature `keySig` produces. */
function storeKeySig(pc, s) {
  if (s.named) return { t: 's', v: s.name };
  const e = pc.exprOf(pc.canon(s.keyValue));
  if (e?.e !== 'lit') return null;
  if (typeof e.v === 'string') return { t: 's', v: e.v };
  if (typeof e.v === 'number') return { t: 'n', v: e.v };
  return null;
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
  // Where in the block's effect chain does the literal come into existence?
  //
  // `CreateObjectLiteral` / `CreateArrayLiteral` / the empty forms are PURE
  // ALLOCATIONS -- `src/ir/opcode_effects.mjs` gives them `alloc(...)`, which
  // writes no effect kind, throws nothing and enters no user code -- so they
  // are not members of the chain at all and `chain.indexOf(ctor.id)` is -1.
  // This used to fall back to `0`, i.e. to the START of the block, where the
  // first chain member is almost never a store into a literal that does not
  // exist yet; the walk below broke on it and the fold never fired. Measured
  // on `r_19252.jsc` + two others: 713 of 866 `Define*`/`Sta*` stores survived
  // with their `CreateObjectLiteral` sitting in the SAME block.
  //
  // The honest position is the instruction order the generator emitted:
  // `BuildCreateObjectLiteral:4179` emits the constructor and
  // `VisitObjectLiteral:4190`'s "store computed values into the literal" loop
  // emits every runtime store after it, so the stores to fold are the chain
  // members whose instruction follows the constructor's. `CloneObject` (object
  // spread) IS in the chain because it runs getters, and the same test finds
  // it: its own instruction is not strictly after itself.
  let start = 0;
  while (start < chain.length) {
    const m = ir.values[chain[start]];
    if (m && m.instruction > ctor.instruction) break;
    start++;
  }
  const out = [];
  // the set of store instructions we are willing to fold, grown as we go
  const targetIns = new Set();
  const candidates = [];
  for (let j = start; j < chain.length; j++) {
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
