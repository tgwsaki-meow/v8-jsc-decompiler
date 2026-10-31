// src/recover/expr.mjs
//
// One Ignition instruction -> one 11.1 `Expr` (or `Stmt`, or nothing).
//
// This is the per-opcode transcription, and it is the inverse of the
// BytecodeArrayBuilder calls that `BytecodeGenerator` makes. The operand
// conventions that matter, read off the generator rather than guessed:
//
//   BinaryOperation(op, reg, slot)        -> reg <op> accumulator
//        VisitArithmeticExpression: the LEFT operand is visited into a
//        register, the RIGHT is left in the accumulator. Confirmed against
//        VisitTemplateLiteral, where `last_part` (the prefix built so far) is
//        the register and the new piece is in the accumulator -- so the
//        register has to be the left operand or template concatenation would
//        come out backwards.
//   BinaryOperationSmiLiteral(op, smi, slot) -> accumulator <op> smi
//        the same method's fast path for a Smi right-hand side.
//   CompareOperation(op, reg, slot)       -> reg <op> accumulator
//        VisitCompareOperation, same shape.
//   LoadNamedProperty(obj_reg, name, slot)   -> obj.name    (acc <- result)
//   SetNamedProperty(obj_reg, name, slot)    -> obj.name = acc  (acc kept)
//   LoadKeyedProperty(obj_reg, slot)         -> obj[acc]
//   SetKeyedProperty(obj_reg, key_reg, slot) -> obj[key] = acc
//
// Nothing here decides *semantics* from an opcode name: whether a value may be
// duplicated, whether it may be inlined, and whether it must be ordered all
// come from `ir.sem` (`effect.*`, `allocationKind`) in inline.mjs. The switch
// below is a transcription table -- syntax -- and every name in it is declared
// in opnames.mjs and checked against the loaded profile.

import { typeOfLiteral } from './flags.mjs';

export const BIN_OPS = Object.freeze({
  Add: '+', Sub: '-', Mul: '*', Div: '/', Mod: '%', Exp: '**',
  BitwiseOr: '|', BitwiseXor: '^', BitwiseAnd: '&',
  ShiftLeft: '<<', ShiftRight: '>>', ShiftRightLogical: '>>>',
  Add_StringConstant_Internalize: '+',
});
export const BIN_SMI_OPS = Object.freeze({
  AddSmi: '+', SubSmi: '-', MulSmi: '*', DivSmi: '/', ModSmi: '%', ExpSmi: '**',
  BitwiseOrSmi: '|', BitwiseXorSmi: '^', BitwiseAndSmi: '&',
  ShiftLeftSmi: '<<', ShiftRightSmi: '>>', ShiftRightLogicalSmi: '>>>',
});
export const CMP_OPS = Object.freeze({
  TestEqual: '==', TestEqualStrict: '===',
  TestLessThan: '<', TestGreaterThan: '>',
  TestLessThanOrEqual: '<=', TestGreaterThanOrEqual: '>=',
  TestInstanceOf: 'instanceof', TestIn: 'in',
  // CompareReference: a strict identity test the desugarings use. `===` is
  // exactly right for it on the values it is ever applied to (Smis, oddballs
  // and JSReceivers), and src/ir models it as pure.
  TestReferenceEqual: '===',
});

/** A literal from an 8.1 constant-pool entry, or a hole saying why not. */
export function constantExpr(c, where) {
  if (c === undefined || c === null) {
    return hole('constantMissing', `no constant pool entry`, where);
  }
  switch (c.t) {
    // A nested literal inside a boilerplate. ObjectLiteral::
    // BuildBoilerplateDescription recurses into a nested literal and stores its
    // own boilerplate as the property value, so the constant pool really does
    // contain literals inside literals. Emitting them as nested literals is
    // also right for identity: evaluating the outer literal creates a fresh
    // copy of each nested one, which is what `{a:{b:1}}` does.
    case 'objectBoilerplate': return objectBoilerplateExpr(c, where);
    case 'arrayBoilerplate': return arrayBoilerplateExpr(c, where);
    case 'regexpBoilerplate':
      return c.source === null
        ? hole('regexpBoilerplateSourceMissing', c.sourceWhy ?? null, where)
        : { e: 'regexp', source: c.source, flags: c.flagString ?? '' };
    case 'rootObject':
      // the canonical empty boilerplate / empty fixed array root
      if (c.isEmpty) return { e: 'object', props: [] };
      return hole('rootObjectConstant', c.rootName ?? c.name ?? null, where);
    default: break;
  }
  switch (c.t) {
    case 'string': return { e: 'lit', v: c.v };
    case 'number': return { e: 'lit', v: c.v };
    case 'bigint': return { e: 'lit', v: c.v, bigint: true };
    case 'boolean': return { e: 'lit', v: c.v };
    case 'null': return { e: 'lit', v: null };
    case 'undefined': return { e: 'lit', v: undefined };
    case 'hole': return { e: 'hole', why: 'theHoleConstant', detail: 'the constant is the hole oddball; only a TDZ desugaring should read it', dump: where ?? null };
    case 'symbol': return { e: 'hole', why: 'symbolConstant', detail: c.desc ?? null, dump: where ?? null };
    case 'sfi': return { e: 'hole', why: 'sfiConstantNotAClosure', detail: `sfi ${c.sfiId}`, dump: where ?? null };
    case 'scopeInfo': return { e: 'hole', why: 'scopeInfoConstant', detail: `scopeInfo ${c.scopeInfoId}`, dump: where ?? null };
    case 'roRef': return { e: 'hole', why: 'unresolvedReadOnlyRef', detail: `chunk ${c.chunk} offset ${c.offset}`, dump: where ?? null };
    case 'unresolved': return { e: 'hole', why: 'unresolvedConstant:' + c.why, detail: c.detail ?? null, dump: where ?? null };
    default:
      return { e: 'hole', why: 'constantKind:' + String(c.t), detail: null, dump: where ?? null };
  }
}

export function hole(why, detail, dump) {
  return { e: 'hole', why, detail: detail ?? null, dump: dump ?? null };
}

/**
 * The input map of an Op: which SSA value each read register operand carries.
 * `v.inputs` is in read order -- the accumulator first when the opcode reads
 * it, then each reading register operand in operand order, with a register
 * list expanded -- which is exactly how src/ir/vars.mjs builds it.
 */
// One input map per value, not per call. `accInputOf` / `flatRegInputs` /
// `transcribe` / the canonical-input pass all ask for the same map, and on a
// 1337-instruction single-block function the repeated `v.inputs.slice()` was
// the single largest source of garbage: a CPU profile of that function spent
// 41.5% of its samples in the collector. A WeakMap keyed on the IR keeps it
// per function, so it is freed with the function. The result is shared and
// must not be mutated.
const INPUT_MAPS = new WeakMap();

export function inputMap(ir, v) {
  let cache = INPUT_MAPS.get(ir);
  if (cache === undefined) { cache = []; INPUT_MAPS.set(ir, cache); }
  const got = cache[v.id];
  if (got !== undefined) return got;
  const m = computeInputMap(ir, v);
  cache[v.id] = m;
  return m;
}

function computeInputMap(ir, v) {
  const ins = ir.instructions[v.instruction];
  const sem = v.sem;
  const readTypes = ir.sem.registerReadTypes;
  const acc = sem.accumulator.read ? v.inputs[0] : null;
  let k = sem.accumulator.read ? 1 : 0;
  const per = [];
  for (let i = 0; i < ins.operands.length; i++) {
    const o = ins.operands[i];
    const role = sem.operands[i];
    const reads = role ? (role.isRegister && role.reads) : readTypes.has(o.type);
    if (!reads) { per.push(null); continue; }
    const n = o.reg ? 1 : (o.regs ? o.regs.length : 0);
    per.push(v.inputs.slice(k, k + n));
    k += n;
  }
  return { acc, per };
}

const RESULT_SKIP = Object.freeze({ kind: 'skip' });

/**
 * Transcribe one `Op` value.
 *
 * @param {object} cx {ir, E, S, names, reg, patterns}
 *   E(ssaId) -> Expr for an input value
 *   name(ssaId) -> {name, origin} for a materialised value
 * @param {object} v an `Op` SSA value
 * @returns {{kind:'expr'|'stmt'|'skip'|'both', expr?, stmt?, note?}}
 */
export function transcribe(cx, v) {
  const ir = cx.ir;
  const ins = ir.instructions[v.instruction];
  const op = v.op;
  const { acc, per } = inputMap(ir, v);
  const E = cx.E;
  const pos = { sourcePosition: ins.sourcePosition ?? null, isStatement: !!ins.isStatement };
  const at = () => `@${ins.offset} ${op}`;

  // operand accessors
  const operands = ins.operands;
  const constAt = (i) => operands[i]?.constant;
  const firstConst = () => operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
  const firstImm = () => operands.find((o) => o.type === 'kImm' || o.type === 'kUImm');
  const firstFlag = () => operands.find((o) => o.type === 'kFlag8' || o.type === 'kFlag16');
  const regVals = (i) => per[i] ?? [];
  const reg1 = (i) => (per[i] && per[i].length ? per[i][0] : null);
  const expr = (x) => ({ kind: 'expr', expr: x });
  const stmt = (s) => ({ kind: 'stmt', stmt: s });
  const both = (s, x) => ({ kind: 'both', stmt: s, expr: x });
  const nameOfSlot = (val) => cx.contextSlotName(val);

  switch (op) {
    // ------------------------------------------------------------- moves
    // These are copies, handled by canonicalisation in index.mjs; they never
    // reach here. Kept for completeness so an unexpected call is visible.
    case 'Ldar': case 'Star': case 'Mov':
      return acc !== null ? expr(E(acc)) : expr(E(reg1(0)));

    // --------------------------------------------------------- literals
    // VisitLiteral
    case 'LdaZero': return expr({ e: 'lit', v: 0 });
    case 'LdaSmi': return expr({ e: 'lit', v: firstImm()?.value ?? 0 });
    case 'LdaConstant': return expr(constantExpr(firstConst(), at()));
    case 'LdaUndefined': return expr({ e: 'lit', v: undefined });
    case 'LdaNull': return expr({ e: 'lit', v: null });
    case 'LdaTrue': return expr({ e: 'lit', v: true });
    case 'LdaFalse': return expr({ e: 'lit', v: false });
    case 'LdaTheHole':
      // Only a TDZ / super desugaring should ever read this. If one does, the
      // pattern consumes the instruction and this never runs.
      return expr(hole('theHole', 'LdaTheHole outside a recognised TDZ or super desugaring', at()));

    // ------------------------------------------- globals: BuildVariableLoad
    case 'LdaGlobal':
    case 'LdaGlobalInsideTypeof':
    case 'LdaLookupGlobalSlot':
    case 'LdaLookupGlobalSlotInsideTypeof':
    case 'LdaLookupSlot':
    case 'LdaLookupSlotInsideTypeof': {
      const c = firstConst();
      if (c?.t !== 'string') return expr(constantExpr(c, at()));
      return expr({ e: 'name', name: c.v, ref: { k: 'global', insideTypeof: /InsideTypeof$/.test(op) } });
    }
    case 'StaGlobal':
    case 'StaLookupSlot': {
      const c = firstConst();
      if (c?.t !== 'string') return stmt({ s: 'hole', why: 'globalStoreNameNotAString', detail: at(), pos });
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: { e: 'assign', op: '=', target: { e: 'name', name: c.v, ref: { k: 'global' } }, value: E(acc) },
      });
    }

    // ------------------------------- context slots: BuildVariableLoad/Assign
    case 'LdaContextSlot': case 'LdaContextSlotNoCell':
    case 'LdaImmutableContextSlot':
    case 'LdaCurrentContextSlot': case 'LdaCurrentContextSlotNoCell':
    case 'LdaImmutableCurrentContextSlot':
    case 'LdaLookupContextSlot': case 'LdaLookupContextSlotNoCell':
    case 'LdaLookupContextSlotInsideTypeof':
    case 'LdaLookupContextSlotNoCellInsideTypeof':
      return expr(nameOfSlot(v));
    case 'StaContextSlot': case 'StaContextSlotNoCell':
    case 'StaCurrentContextSlot': case 'StaCurrentContextSlotNoCell':
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: { e: 'assign', op: '=', target: nameOfSlot(v), value: E(acc) },
      });

    // ------------------------------------------------------------ modules
    case 'LdaModuleVariable': {
      const idx = firstImm()?.value ?? null;
      return expr({ e: 'name', name: `__module_${idx}`, ref: { k: 'module', index: idx, depth: operands[1]?.value ?? null } });
    }
    case 'StaModuleVariable': {
      const idx = firstImm()?.value ?? null;
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: {
          e: 'assign', op: '=',
          target: { e: 'name', name: `__module_${idx}`, ref: { k: 'module', index: idx } },
          value: E(acc),
        },
      });
    }

    // ----------------------------------------- properties: VisitPropertyLoad
    case 'GetNamedProperty': {
      const c = firstConst();
      if (c?.t !== 'string') return expr(hole('namedPropertyKeyNotAString', at(), at()));
      return expr({ e: 'member', obj: E(reg1(0)), prop: c.v, computed: false, optional: false });
    }
    case 'GetNamedPropertyFromSuper': {
      const c = operands.find((o, i) => o.type === 'kConstantPoolIndex')?.constant;
      if (c?.t !== 'string') return expr(hole('superPropertyKeyNotAString', at(), at()));
      return expr({ e: 'member', obj: { e: 'super' }, prop: c.v, computed: false, optional: false, homeObject: E(reg1(0)) });
    }
    case 'GetKeyedProperty':
      return expr({ e: 'member', obj: E(reg1(0)), prop: E(acc), computed: true, optional: false });
    case 'GetEnumeratedKeyedProperty':
      // VisitForInStatement's body load: obj[key] with the enum cache attached.
      return expr({ e: 'member', obj: E(reg1(0)), prop: E(acc), computed: true, optional: false });

    case 'SetNamedProperty':
    case 'DefineNamedOwnProperty': {
      const c = firstConst();
      const target = c?.t === 'string'
        ? { e: 'member', obj: E(reg1(0)), prop: c.v, computed: false, optional: false }
        : hole('namedStoreKeyNotAString', at(), at());
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: { e: 'assign', op: '=', target, value: E(acc), define: op !== 'SetNamedProperty' },
      });
    }
    case 'SetKeyedProperty':
    case 'DefineKeyedOwnProperty':
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: {
          e: 'assign', op: '=',
          target: { e: 'member', obj: E(reg1(0)), prop: E(reg1(1)), computed: true, optional: false },
          value: E(acc), define: op !== 'SetKeyedProperty',
        },
      });
    case 'StaInArrayLiteral':
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: {
          e: 'assign', op: '=',
          target: { e: 'member', obj: E(reg1(0)), prop: E(reg1(1)), computed: true, optional: false },
          value: E(acc), define: true, inArrayLiteral: true,
        },
      });
    case 'DefineKeyedOwnPropertyInLiteral':
      // BuildLoadPropertyKey + the object-literal computed-key path.
      return stmt({
        s: 'expr', pos, values: [v.id],
        expr: {
          e: 'assign', op: '=',
          target: { e: 'member', obj: E(reg1(0)), prop: E(reg1(1)), computed: true, optional: false },
          value: E(acc), define: true, inLiteral: true,
        },
      });

    // ---------------------------------------------------- VisitDelete
    case 'DeletePropertyStrict':
    case 'DeletePropertySloppy':
      return expr({
        e: 'unary', op: 'delete',
        arg: { e: 'member', obj: E(reg1(0)), prop: E(acc), computed: true, optional: false },
      });

    // ------------------------------ binary / compare / unary operators
    default: break;
  }

  if (BIN_OPS[op] !== undefined) {
    // BinaryOperation(op, reg, slot): reg <op> accumulator
    return { kind: 'expr', expr: { e: 'bin', op: BIN_OPS[op], l: E(reg1(0)), r: E(acc) } };
  }
  if (BIN_SMI_OPS[op] !== undefined) {
    const imm = firstImm();
    return { kind: 'expr', expr: { e: 'bin', op: BIN_SMI_OPS[op], l: E(acc), r: { e: 'lit', v: imm?.value ?? 0 } } };
  }
  if (CMP_OPS[op] !== undefined) {
    return { kind: 'expr', expr: { e: 'bin', op: CMP_OPS[op], l: E(reg1(0)), r: E(acc) } };
  }

  switch (op) {
    // BuildLiteralCompareNil / BuildLiteralStrictCompareBoolean
    case 'TestNull': return { kind: 'expr', expr: { e: 'bin', op: '===', l: E(acc), r: { e: 'lit', v: null } } };
    case 'TestUndefined': return { kind: 'expr', expr: { e: 'bin', op: '===', l: E(acc), r: { e: 'lit', v: undefined } } };
    case 'TestUndetectable':
      // the loose nil compare: `x == null` is true exactly for undetectable x
      return { kind: 'expr', expr: { e: 'bin', op: '==', l: E(acc), r: { e: 'lit', v: null } } };
    case 'TestTypeOf': {
      const lit = typeOfLiteral(firstFlag()?.value);
      if (lit === null) {
        return { kind: 'expr', expr: hole('testTypeOfFlagOutOfRange', `flag ${firstFlag()?.value}`, at()) };
      }
      return {
        kind: 'expr',
        expr: {
          e: 'bin', op: '===',
          l: { e: 'unary', op: 'typeof', arg: E(acc) },
          r: { e: 'lit', v: lit },
        },
      };
    }

    // VisitUnaryOperation / VisitNot / VisitTypeOf
    case 'TypeOf': return { kind: 'expr', expr: { e: 'unary', op: 'typeof', arg: E(acc) } };
    case 'Negate': return { kind: 'expr', expr: { e: 'unary', op: '-', arg: E(acc) } };
    case 'BitwiseNot': return { kind: 'expr', expr: { e: 'unary', op: '~', arg: E(acc) } };
    case 'LogicalNot':
    case 'ToBooleanLogicalNot':
      return { kind: 'expr', expr: { e: 'unary', op: '!', arg: E(acc) } };
    // VisitCountOperation's ToNumeric + Inc/Dec dance. The update pattern
    // rewrites these; the bare form is `+1`/`-1`, which is exact for every
    // non-BigInt operand (see docs/RECOVER.md "Known gaps").
    case 'Inc': return { kind: 'expr', expr: { e: 'bin', op: '+', l: E(acc), r: { e: 'lit', v: 1 }, fromInc: true } };
    case 'Dec': return { kind: 'expr', expr: { e: 'bin', op: '-', l: E(acc), r: { e: 'lit', v: 1 }, fromInc: true } };

    // the conversions. A bare one is a coercion the source did not write, so
    // it is transparent: the value is its input. Where the conversion IS the
    // syntax (a template literal's ToString, a computed key's ToName) the
    // pattern consumes it.
    case 'ToBoolean': return { kind: 'expr', expr: E(acc), note: 'coercion' };
    case 'ToString': return { kind: 'expr', expr: E(acc), note: 'coercion' };
    case 'ToName': return { kind: 'expr', expr: E(acc), note: 'coercion' };
    case 'ToNumber': return { kind: 'expr', expr: { e: 'unary', op: '+', arg: E(acc) } };
    case 'ToNumeric': return { kind: 'expr', expr: E(acc), note: 'coercion' };
    case 'ToObject': return { kind: 'expr', expr: E(acc), note: 'coercion' };

    // ------------------------------------------------- VisitCall / CallNew
    case 'CallUndefinedReceiver0':
    case 'CallUndefinedReceiver1':
    case 'CallUndefinedReceiver2':
    case 'CallUndefinedReceiver': {
      const callee = reg1(0);
      const args = argList(per, 1, E);
      return { kind: 'expr', expr: { e: 'call', callee: E(callee), args, optional: false } };
    }
    case 'CallProperty0':
    case 'CallProperty1':
    case 'CallProperty2':
    case 'CallProperty':
    case 'CallAnyReceiver': {
      const callee = reg1(0);
      const all = flatten(per, 1);
      const receiver = all.length ? all[0] : null;
      const args = all.slice(1).map((id) => E(id));
      const calleeExpr = E(callee);
      // VisitCall for a property call loads the callee out of the receiver
      // register, so `o.m()` has callee = member(obj=<the receiver's value>).
      // Check that rather than assume it: if the receiver is a different SSA
      // value, the shape is `f.call(recv, ...)`-like and is reported.
      if (calleeExpr?.e === 'member' && cx.sameValue(calleeExpr.objValue, receiver)) {
        return { kind: 'expr', expr: { e: 'call', callee: calleeExpr, args, optional: false } };
      }
      return {
        kind: 'expr',
        expr: {
          e: 'call', optional: false,
          callee: { e: 'member', obj: calleeExpr, prop: 'call', computed: false, optional: false, synthesised: 'receiverMismatch' },
          args: [E(receiver), ...args],
        },
        note: 'propertyCallReceiverMismatch',
      };
    }
    case 'CallWithSpread': {
      const callee = reg1(0);
      const all = flatten(per, 1);
      const receiver = all.length ? all[0] : null;
      const rest = all.slice(1);
      const args = rest.map((id, i) => (i === rest.length - 1 ? { spread: E(id) } : E(id)));
      const calleeExpr = E(callee);
      const useMember = calleeExpr?.e === 'member' && cx.sameValue(calleeExpr.objValue, receiver);
      return {
        kind: 'expr',
        expr: useMember
          ? { e: 'call', callee: calleeExpr, args, optional: false }
          : { e: 'call', callee: calleeExpr, args, optional: false, receiver: E(receiver) },
      };
    }
    case 'Construct': {
      const callee = reg1(0);
      return { kind: 'expr', expr: { e: 'new', callee: E(callee), args: argList(per, 1, E) } };
    }
    case 'ConstructWithSpread': {
      const callee = reg1(0);
      const all = flatten(per, 1);
      const args = all.map((id, i) => (i === all.length - 1 ? { spread: E(id) } : E(id)));
      return { kind: 'expr', expr: { e: 'new', callee: E(callee), args } };
    }
    case 'ConstructForwardAllArgs':
      return {
        kind: 'expr',
        expr: { e: 'new', callee: E(reg1(0)), args: [{ spread: { e: 'name', name: 'arguments', ref: { k: 'local', forwardAllArgs: true } } }] },
      };

    case 'CallRuntime':
    case 'CallRuntimeForPair':
    case 'InvokeIntrinsic':
    case 'CallJSRuntime':
      return cx.runtimeCall(v, { per, acc, E, pos, ins });

    // -------------------------------------- literal and closure constructors
    case 'CreateEmptyObjectLiteral':
      return { kind: 'expr', expr: { e: 'object', props: [] } };
    case 'CreateObjectLiteral': {
      const c = firstConst();
      if (c?.t === 'objectBoilerplate') {
        const e = objectBoilerplateExpr(c, at());
        return { kind: 'expr', expr: e, note: e.pendingEntries ? 'objectBoilerplateHasRuntimeEntries' : null };
      }
      // the canonical empty boilerplate root: `{}` with only computed or
      // spread properties, which literals.mjs folds back in
      if (c?.t === 'rootObject') return { kind: 'expr', expr: { e: 'object', props: [], boilerplate: true } };
      return { kind: 'expr', expr: hole('objectLiteralBoilerplateMissing', c?.t ?? 'absent', at()) };
    }
    case 'CreateEmptyArrayLiteral':
      return { kind: 'expr', expr: { e: 'array', elements: [] } };
    case 'CreateArrayLiteral': {
      const c = firstConst();
      if (c?.t === 'arrayBoilerplate') return { kind: 'expr', expr: arrayBoilerplateExpr(c, at()) };
      if (c?.t === 'rootObject') return { kind: 'expr', expr: { e: 'array', elements: [], boilerplate: true } };
      return { kind: 'expr', expr: hole('arrayLiteralBoilerplateMissing', c?.t ?? 'absent', at()) };
    }
    case 'CreateArrayFromIterable':
      return { kind: 'expr', expr: { e: 'array', elements: [{ spread: E(acc) }] } };
    case 'CloneObject':
      // VisitObjectLiteral's spread: `{...src}` clones into a fresh object.
      return { kind: 'expr', expr: { e: 'object', props: [{ kind: 'spread', value: E(reg1(0)), key: null, computed: false }] } };
    case 'CreateRegExpLiteral': {
      // VisitRegExpLiteral:4172 ->
      //   CreateRegExpLiteral(pattern_entry, feedback, flags)
      // The pattern is a plain string in the constant pool and the flags are
      // the kFlag16 operand, a JSRegExpFlags bitfield. A freshly minted cache
      // instead carries a RegExpBoilerplateDescription, which src/heap decodes
      // with its flag string already built -- both forms appear, so both are
      // handled and neither is guessed.
      const c = firstConst();
      if (c?.t === 'regexpBoilerplate' && c.source !== null) {
        return { kind: 'expr', expr: { e: 'regexp', source: c.source, flags: c.flagString ?? '' } };
      }
      if (c?.t === 'string') {
        const raw = firstFlag()?.value ?? 0;
        const f = regexpFlagString(ir.profile, raw);
        if (f === null) {
          return { kind: 'expr', expr: hole('regexpFlagsNotInProfile', `flags ${raw}`, at()) };
        }
        return { kind: 'expr', expr: { e: 'regexp', source: c.v, flags: f } };
      }
      return { kind: 'expr', expr: hole('regexpBoilerplateMissing', c?.sourceWhy ?? c?.t ?? 'absent', at()) };
    }
    case 'CreateClosure': {
      const c = firstConst();
      if (c?.t !== 'sfi') return { kind: 'expr', expr: hole('closureConstantNotAnSfi', c?.t ?? 'absent', at()) };
      const meta = cx.closureMeta(c.sfiId);
      return {
        kind: 'expr',
        expr: {
          e: 'fn', sfiId: c.sfiId, name: meta?.name ?? null, params: meta?.parameterCount ?? null,
          isAsync: !!meta?.isAsync, isGenerator: !!meta?.isGenerator, isArrow: meta?.kind === 'arrow',
          kind: meta?.kind ?? null,
        },
      };
    }
    case 'GetTemplateObject': {
      const c = firstConst();
      if (c?.t !== 'templateObject') {
        return { kind: 'expr', expr: hole('templateObjectMissing', c?.t ?? 'absent', at()) };
      }
      return { kind: 'expr', expr: { e: 'templateObject', raw: c.raw, cooked: c.cooked } };
    }

    // --------------------------------------------- arguments / rest / this
    case 'CreateMappedArguments':
    case 'CreateUnmappedArguments':
      return { kind: 'expr', expr: { e: 'name', name: 'arguments', ref: { k: 'local', argumentsObject: true } } };
    case 'CreateRestParameter':
      return {
        kind: 'expr',
        expr: { e: 'restParameter', from: ir.unit.parameterCount ? ir.unit.parameterCount - 1 : 0 },
      };

    // ------------------------------------------------------------- contexts
    // Contexts are the storage of context-allocated variables. They are not
    // source syntax: `names.mjs` already resolved the slot names, so a context
    // constructor and the Push/Pop around it carry no statement.
    case 'CreateFunctionContext': case 'CreateFunctionContextWithCells':
    case 'CreateBlockContext': case 'CreateEvalContext':
    case 'CreateCatchContext': case 'CreateWithContext':
    case 'PushContext': case 'PopContext':
      return { kind: 'skip', note: 'contextPlumbing' };

    // ------------------------------------------------- terminators / throws
    case 'Return':
      return { kind: 'stmt', stmt: { s: 'return', arg: E(acc), pos, values: [v.id] } };
    case 'Throw':
      return { kind: 'stmt', stmt: { s: 'throw', arg: E(acc), pos, values: [v.id] } };
    case 'ReThrow':
      return { kind: 'stmt', stmt: { s: 'throw', arg: E(acc), pos, values: [v.id], rethrow: true } };
    case 'Debugger':
      return { kind: 'stmt', stmt: { s: 'debugger', pos, values: [v.id] } };
    case 'Abort':
      return { kind: 'stmt', stmt: { s: 'hole', why: 'abort', detail: `Abort #${operands[0]?.reason}`, pos } };
    case 'IncBlockCounter':
      return { kind: 'skip', note: 'blockCoverage' };
    case 'SetPendingMessage':
      // BuildTryFinally saves and restores the isolate's pending message
      // around the cleanup block. Not source syntax.
      return { kind: 'skip', note: 'finallyPendingMessage' };

    // the TDZ and super desugaring guards: BuildThrowIfHole,
    // BuildHoleCheckForVariableAssignment, VisitCallSuper
    case 'ThrowReferenceErrorIfHole':
    case 'ThrowSuperNotCalledIfHole':
    case 'ThrowSuperAlreadyCalledIfNotHole':
    case 'ThrowIfNotSuperConstructor':
      return { kind: 'skip', note: 'desugaringGuard' };

    // ------------------------------------------------------- for-in / for-of
    // The loop itself is T8's. T7 supplies the exprs these produce and the
    // forin/forof patterns mark the plumbing consumed.
    case 'ForInEnumerate':
      return { kind: 'expr', expr: { e: 'forInEnumerate', obj: E(acc) } };
    case 'ForInPrepare':
      return { kind: 'expr', expr: { e: 'forInCache', enumerable: E(acc), slot: 'cacheType' } };
    case 'ForInNext':
      return { kind: 'expr', expr: { e: 'forInNext', obj: E(reg1(0)), index: E(reg1(1)), cache: regVals(2).map(E) } };
    case 'ForInStep':
      return { kind: 'expr', expr: { e: 'bin', op: '+', l: E(acc), r: { e: 'lit', v: 1 }, forInStep: true } };
    case 'GetIterator':
      // BuildGetIterator:7911 -- `GetIterator <obj>` loads obj[@@iterator] and
      // calls it, which is exactly what `obj[Symbol.iterator]()` spells. So the
      // plain transcription is faithful and needs no idiom; forof.mjs claims
      // the surrounding loop without consuming this, so a function whose loop
      // T8 does not recognise still comes out correct (just verbose).
      return {
        kind: 'expr',
        expr: {
          e: 'call', optional: false, args: [],
          callee: {
            e: 'member', obj: E(reg1(0)), computed: true, optional: false,
            prop: { e: 'member', obj: { e: 'name', name: 'Symbol', ref: { k: 'global' } }, prop: 'iterator', computed: false, optional: false },
          },
        },
      };
    case 'ForOfNext':
      return { kind: 'expr', expr: { e: 'forOfNext', iterator: E(reg1(0)) } };

    // ------------------------------------------------- generators / classes
    case 'SuspendGenerator':
      return { kind: 'skip', note: 'suspendPoint' };
    case 'ResumeGenerator':
      return { kind: 'expr', expr: { e: 'resumeValue' }, note: 'resumePoint' };
    case 'SwitchOnGeneratorState':
      return { kind: 'skip', note: 'generatorDispatcher' };
    case 'SwitchOnSmiNoFeedback':
      return { kind: 'skip', note: 'switchDispatch' };
    case 'GetSuperConstructor':
      return { kind: 'expr', expr: { e: 'superConstructor', of: E(acc) } };
    case 'FindNonDefaultConstructorOrConstruct':
      return { kind: 'expr', expr: { e: 'superConstructor', of: E(reg1(0)), newTarget: E(reg1(1)), findNonDefault: true } };

    default:
      break;
  }

  // Jumps carry no value and no statement: the edge is T8's.
  if (ins.jumpTarget !== null && ins.jumpTarget !== undefined) {
    return { kind: 'skip', note: 'jump' };
  }

  return {
    kind: 'expr',
    expr: hole('opcodeNotTranscribed', op, `${at()} ${ins.operands.map((o) => o.type).join(',')}`),
    note: 'opcodeNotTranscribed',
  };
}

/**
 * A raw JSRegExpFlags value -> the source-visible flag letters.
 *
 * The BIT POSITIONS come from the profile (`layouts.bitfields.JSRegExpFlags`,
 * derived from src/objects/js-regexp.tq), so nothing version-specific is
 * written down here. The letter for each bit is spec vocabulary and the ORDER
 * is the order the spec lists them, which is the order V8's own
 * `JSRegExp::FlagsToString` prints -- the same table src/heap/objects.mjs uses
 * for the boilerplate form, so the two paths agree by construction.
 */
const FLAG_LETTERS = [
  ['has_indices', 'd'], ['global', 'g'], ['ignore_case', 'i'], ['multiline', 'm'],
  ['dot_all', 's'], ['unicode', 'u'], ['unicode_sets', 'v'], ['sticky', 'y'],
];
export function regexpFlagString(profile, raw) {
  let b;
  try { b = profile.bitfieldOf('JSRegExpFlags'); } catch { return null; }
  const have = new Set(b.fields.map((f) => f.name));
  let out = '';
  for (const [field, letter] of FLAG_LETTERS) {
    if (!have.has(field)) continue;                     // a flag this V8 lacks
    if (profile.readBitfield('JSRegExpFlags', field, raw)) out += letter;
  }
  return out;
}

function flatten(per, from) {
  const out = [];
  for (let i = from; i < per.length; i++) if (per[i]) out.push(...per[i]);
  return out;
}
function argList(per, from, E) {
  return flatten(per, from).map((id) => E(id));
}

/** A constant ObjectBoilerplateDescription -> an object literal. */
export function objectBoilerplateExpr(c, where) {
  const props = [];
  let pending = 0;
  for (const ent of c.entries ?? []) {
    const val = ent.value;
    // VisitObjectLiteral parks `uninitialized` in the slot of a property whose
    // value is computed at run time and emits a Define*OwnProperty for it, so
    // such an entry is not missing -- literals.mjs puts it back.
    if (val && (val.t === 'hole' || val.t === 'unresolved')) { pending++; continue; }
    const k = boilerplateKey(ent.key);
    if (k === null) { pending++; continue; }
    props.push({ key: k.key, computed: k.computed, value: constantExpr(val, where), kind: 'init' });
  }
  return { e: 'object', props, boilerplate: true, pendingEntries: pending };
}

/** A constant ArrayBoilerplateDescription -> an array literal. */
export function arrayBoilerplateExpr(c, where) {
  if (c.elements === null || c.elements === undefined) {
    return hole('arrayBoilerplateElementsNotDecoded', c.why ?? null, where);
  }
  return {
    e: 'array', boilerplate: true,
    elements: c.elements.map((el) => (el && el.t === 'hole' ? null : constantExpr(el, where))),
  };
}

/** An ObjectBoilerplateDescription key: a string name or a numeric index. */
function boilerplateKey(k) {
  if (!k) return null;
  if (k.t === 'string') return { key: k.v, computed: false };
  if (k.t === 'number') return { key: { e: 'lit', v: k.v }, computed: true };
  return null;
}

export default { transcribe, constantExpr, inputMap, hole, BIN_OPS, BIN_SMI_OPS, CMP_OPS };
