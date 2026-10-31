// src/recover/patterns/accessor.mjs
//
// Getters, setters and computed keys.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitObjectLiteral  :4190  (the GETTER / SETTER / COMPUTED arms)
//   VisitLiteralAccessor:8551
//   BuildLoadPropertyKey:8647
//   BuildClassProperty  :3862
//   VisitAutoAccessorGetterBody :3957   VisitAutoAccessorSetterBody :3966
//
// Two shapes:
//
//   an accessor in an object literal ->
//       %DefineGetterPropertyUnchecked(obj, key, fn)
//       %DefineSetterPropertyUnchecked(obj, key, fn)
//       %DefineAccessorPropertyUnchecked(obj, key, get, set)   (both halves)
//     which is a value-less runtime call, so it folds into the literal the
//     same way a Define*OwnProperty does.
//
//   a computed key ->
//       BuildLoadPropertyKey emits `ToName` on the key expression (or nothing
//       when the key is already a string literal) and then
//       `DefineKeyedOwnPropertyInLiteral obj, key`.
//     The `ToName` is the tell that the key was computed rather than written as
//     an identifier; expr.mjs already treats a bare `ToName` as transparent,
//     and the claim here records that the key is `[expr]` and not `expr`.

const DEFINERS = new Map([
  ['DefineGetterPropertyUnchecked', 'get'],
  ['DefineSetterPropertyUnchecked', 'set'],
  ['DefineAccessorPropertyUnchecked', 'both'],
]);

export function run(pc) {
  const ir = pc.ir;

  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    const rt = pc.runtimeNameOf(v);
    const which = rt ? DEFINERS.get(rt) : undefined;
    if (which !== undefined) { accessor(pc, v, which, rt); continue; }

    if (v.op === 'DefineKeyedOwnPropertyInLiteral') computedKey(pc, v);
  }
}

function accessor(pc, v, which, rt) {
  const args = pc.flatRegInputs(v);
  const objId = args[0] ?? null;
  const obj = objId === null ? null : pc.ir.values[pc.canon(objId)];
  const objExpr = obj ? pc.exprOf(obj.id) : null;
  const foldable = objExpr?.e === 'object' && obj.allocationKind === 'definite';

  if (foldable) {
    if (which === 'both') {
      pc.addObjectProperty(obj.id, () => ({ kind: 'get', key: pc.E(args[1]), computed: true, value: pc.E(args[2]) }));
      pc.addObjectProperty(obj.id, () => ({ kind: 'set', key: pc.E(args[1]), computed: true, value: pc.E(args[3]) }));
    } else {
      pc.addObjectProperty(obj.id, () => ({ kind: which, key: pc.E(args[1]), computed: true, value: pc.E(args[2]) }));
    }
    pc.consume(v.instruction);
    pc.consumeMovesFeeding(v);
  } else {
    // not a literal we can see: `Object.defineProperty` is what the runtime
    // function does, and saying so is honest.
    pc.setStmt(v.id, () => ({
      s: 'expr',
      expr: {
        e: 'call', optional: false,
        callee: { e: 'member', obj: { e: 'name', name: 'Object', ref: { k: 'global' } }, prop: 'defineProperty', computed: false, optional: false },
        args: [
          pc.E(args[0]), pc.E(args[1]),
          {
            e: 'object',
            props: which === 'both'
              ? [{ key: 'get', computed: false, value: pc.E(args[2]), kind: 'init' },
                { key: 'set', computed: false, value: pc.E(args[3]), kind: 'init' }]
              : [{ key: which, computed: false, value: pc.E(args[2]), kind: 'init' }],
          },
        ],
      },
    }));
  }
  pc.claim({
    kind: 'accessor', blocks: [v.block], values: [v.id],
    instructions: foldable ? [v.instruction] : [], confidence: 'exact',
    cites: ['VisitObjectLiteral:4190', 'VisitLiteralAccessor:8551'],
    detail: `${rt}${foldable ? ' folded into its literal' : ' on a target this pass cannot see'}`,
  });
}

function computedKey(pc, v) {
  const regs = pc.flatRegInputs(v);
  const keyId = regs[1] ?? null;
  if (keyId === null) return;
  const key = pc.ir.values[pc.canon(keyId)];
  const viaToName = key?.kind === 'Op' && key.op === 'ToName';
  pc.claim({
    kind: 'accessor', blocks: [v.block], values: [v.id, keyId], instructions: [],
    confidence: viaToName ? 'exact' : 'shape',
    cites: ['BuildLoadPropertyKey:8647', 'VisitObjectLiteral:4190'],
    detail: viaToName ? 'computed key (ToName)' : 'keyed own property in a literal',
  });
}

export default { name: 'accessor', run };
