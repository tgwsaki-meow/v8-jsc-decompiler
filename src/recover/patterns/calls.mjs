// src/recover/patterns/calls.mjs
//
// Property calls: `o.m(x)`, `o[k](x)`, `super.m(x)` and their spread forms.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitCall                      :6738
//   VisitPropertyLoadForRegister   :6638
//   VisitNamedSuperPropertyLoad    :6646
//   VisitKeyedSuperPropertyLoad    :6683
//
// `VisitCall`'s property-call cases are
//
//     case Call::NAMED_PROPERTY_CALL:
//     case Call::KEYED_PROPERTY_CALL:
//     case Call::PRIVATE_CALL: {
//       Property* property = callee_expr->AsProperty();
//       VisitAndPushIntoRegisterList(property->obj(), &args);          // :6782
//       VisitPropertyLoadForRegister(args.last_register(), property, callee);
//     }
//
// so the receiver register and the register the callee was loaded out of are
// THE SAME REGISTER, by construction, for every `CallProperty*` the generator
// can emit from a property call (the two optional-chain cases at :6854 do the
// same thing, and the two super cases at :6837/:6844 copy the receiver that
// `VisitNamedSuperPropertyLoad:6646` already loaded `this` into). That is the
// whole recogniser.
//
// Why this is a pattern and not just a branch in the transcription:
//
//   * The transcription can only look at the callee's resolved EXPRESSION, and
//     when the load has been materialised under a name -- which happens
//     whenever the call is in a different basic block from the load, because
//     `inline.mjs`'s adjacency test is per block (docs/RECOVER.md 8.1) -- that
//     expression is `{e:'name'}` and the member form is unavailable. Measured
//     on `r_19252.jsc` + `r_89889.jsc`: 373 of 374 property calls have the
//     callee structurally loaded out of the receiver, but 56 of them had a
//     materialised callee.
//   * Consuming the load is what removes the materialisation: the load emits
//     no statement, so the receiver drops from two occurrences to one and
//     inlines into the call as well.
//
// Moving the load into the callee position of its own call cannot change
// evaluation order: the generator emits the load immediately before
// `VisitArguments` and the call, so re-emitting `o.m(args)` puts it back
// exactly where it was. The load is only claimed when the call is its ONLY
// use, so nothing is evaluated twice.

const PROPERTY_CALLS = new Set([
  'CallProperty0', 'CallProperty1', 'CallProperty2', 'CallProperty', 'CallWithSpread',
]);
const NAMED_LOADS = new Set(['GetNamedProperty']);
const SUPER_LOADS = new Set(['GetNamedPropertyFromSuper']);
const KEYED_LOADS = new Set(['GetKeyedProperty', 'GetEnumeratedKeyedProperty']);

export function run(pc) {
  const ir = pc.ir;
  for (const v of ir.values) {
    if (v?.kind !== 'Op' || !PROPERTY_CALLS.has(v.op)) continue;
    if (pc.isConsumed(v.instruction) || pc.hasExpr(v.id)) continue;

    const all = pc.flatRegInputs(v);
    if (all.length < 2) continue;
    const calleeId = pc.canon(all[0]);
    const receiverId = pc.canon(all[1]);
    const load = ir.values[calleeId];
    if (!load || load.kind !== 'Op') continue;

    const named = NAMED_LOADS.has(load.op);
    const sup = SUPER_LOADS.has(load.op);
    const keyed = KEYED_LOADS.has(load.op);
    if (!named && !sup && !keyed) continue;
    if (pc.isConsumed(load.instruction) || pc.hasExpr(load.id)) continue;

    // VisitPropertyLoadForRegister:6638 read the object out of the receiver
    // register. For the super form the register IS the receiver
    // (VisitNamedSuperPropertyLoad:6646 stores `this` there).
    if (!pc.sameValue(pc.firstRegInput(load), receiverId)) continue;

    // the call must be the load's only use, or inlining it would evaluate the
    // property access twice (11.3 invariant 4)
    const uses = pc.usesOf(calleeId);
    if (uses.length !== 1 || pc.canon(uses[0]) !== pc.canon(v.id)) continue;

    const name = named || sup ? pc.nameOperandOf(load) : null;
    if ((named || sup) && name === null) continue;
    const keyId = keyed ? pc.accInputOf(load) : null;
    if (keyed && (keyId === null || keyId === undefined)) continue;

    const argIds = all.slice(2);
    const spread = v.op === 'CallWithSpread';
    pc.setExpr(v.id, () => ({
      e: 'call', optional: false,
      callee: sup
        ? { e: 'member', obj: { e: 'super' }, prop: name, computed: false, optional: false }
        : {
          e: 'member', obj: pc.E(receiverId), objValue: receiverId,
          prop: named ? name : pc.E(keyId), computed: !named, optional: false,
        },
      args: argIds.map((x, i) => (spread && i === argIds.length - 1 ? { spread: pc.E(x) } : pc.E(x))),
    }));
    pc.consume(load.instruction);
    pc.claim({
      kind: 'propertyCall', blocks: [v.block], values: [v.id, load.id],
      instructions: [load.instruction], confidence: 'exact',
      cites: sup
        ? ['VisitCall:6738', 'VisitNamedSuperPropertyLoad:6646']
        : ['VisitCall:6738', 'VisitPropertyLoadForRegister:6638'],
      detail: `${v.op} on ${sup ? 'super.' : ''}${named || sup ? name : '[computed]'}`,
    });
  }
}

export default { name: 'calls', run };
