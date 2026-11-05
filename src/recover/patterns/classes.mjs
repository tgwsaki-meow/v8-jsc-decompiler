// src/recover/patterns/classes.mjs
//
// `class` declarations and expressions, `super`, the home object, private
// names and brands, and static blocks.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   BuildClassLiteral                       :3534
//   VisitClassLiteral                       :3832
//   BuildClassProperty                      :3862
//   VisitInitializeClassMembersStatement    :3935
//   VisitInitializeClassStaticElementsStatement :3942
//   BuildPrivateBrandInitialization         :3994
//   BuildInstanceMemberInitialization       :4025
//   VisitCallSuper                          :6961
//   BuildGetAndCheckSuperConstructor        :7105
//   BuildPrivateBrandCheck                  :6582
//
// The anchor is `%DefineClass`, whose argument list BuildClassLiteral:3645-3664
// fixes exactly:
//
//     args[0] = the ClassBoilerplate constant   (LoadConstantPoolEntry)
//     args[1] = the constructor closure         (VisitFunctionLiteral)
//     args[2] = the super class, or the hole     (VisitForAccumulatorValueOrTheHole)
//     args[3..] = computed keys and method values, in declaration order
//               (ClassBoilerplate::kFirstDynamicArgumentIndex == 3, asserted
//                by the DCHECK_EQ on line 3653)
//
// so `superClass` is args[2] unless it is the hole, and the class's identity is
// the constructor's SharedFunctionInfo, which is where its name and its body
// live.
//
// The member list is `args[0]`, the `ClassBoilerplate`, which `src/heap` now
// decodes (docs/FRONTEND.md). It does not name the members' VALUES -- it names
// the argument INDEX of each one, because `ClassBoilerplate::New` stores
// `Smi(value_index)` and the argument list is the caller's, not the constant's.
// This layer is where the two meet: index `i` is `args[i]`, which is the
// `CreateClosure` of that method, so `members[]` is the boilerplate's entries
// with `pc.E(args[valueIndex])` substituted for the index. A member the
// boilerplate describes but this layer cannot turn into a `{kind, key, value}`
// triple goes into `membersNotPlaced` with a named reason and is counted by
// `src/emit`; it is never downgraded into a plain method.
//
// `super()` is `FindNonDefaultConstructorOrConstruct` (or
// `GetSuperConstructor` + `Construct`) and the three `Throw*Super*` guards; the
// guards are consumed because they are the desugaring of "a derived
// constructor must call super exactly once before `this`", not source syntax.

export function run(pc) {
  const ir = pc.ir;

  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    const rt = pc.runtimeNameOf(v);
    if (rt === 'DefineClass') defineClass(pc, v);
    else if (rt === 'CreatePrivateNameSymbol' || rt === 'CreatePrivateBrandSymbol') privateName(pc, v, rt);
    else if (rt === 'CreatePrivateAccessors') privateAccessors(pc, v);
    else if (rt === 'AddPrivateBrand') {
      pc.consume(v.instruction);
      pc.claim({
        kind: 'privateField', blocks: [v.block], values: [v.id],
        instructions: [v.instruction], confidence: 'exact',
        cites: ['BuildPrivateBrandInitialization:3994'], detail: 'brand initialisation',
      });
    }
  }

  // super()
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    if (v.op === 'FindNonDefaultConstructorOrConstruct') {
      // BuildSuperCallOptimization:7123, the shape BuildGetAndCheckSuperConstructor
      // :7105 takes when `omit_default_ctors` is on (it is, for every derived
      // constructor in the corpus):
      //
      //   FindNonDefaultConstructorOrConstruct this_function, new_target, out(2)
      //   Mov out[1] -> constructor_then_instance
      //   Ldar out[0] ; JumpIfTrue -> super_ctor_call_done
      //
      // out[0] is a RUNTIME boolean: true when V8 walked past a chain of
      // default constructors and already built the instance, false when this
      // frame still has to call the super constructor. It was transcribed here
      // as `{e:'lit', v:true}`, and that is a fabrication with teeth -- the
      // emitted text became `if (!true) { ... }`, which makes the super call
      // DEAD CODE and silently deletes the whole derived-constructor protocol.
      // A runtime value we cannot name is a hole (docs/RECOVER.md 6).
      pc.setExpr(v.id, () => ({
        e: 'hole',
        why: 'superConstructorDispatchFlagIsARuntimeValue',
        detail: 'FindNonDefaultConstructorOrConstruct out[0] (BuildSuperCallOptimization:7123) '
          + 'is true iff V8 already constructed the instance by walking past default '
          + 'constructors; it has no source form, and the branch on it is part of the '
          + '`super()` desugaring, not of the program',
        dump: null,
      }));
      // out[1] is the super constructor on the false path and the finished
      // instance on the true path -- the two lifetimes deliberately share one
      // register ("the lifetimes of the two don't need to overlap",
      // VisitCallSuper:6961). After the join it is `this`.
      for (const p of v.projections ?? []) {
        pc.setExpr(p, () => ({ e: 'name', name: 'this', ref: { k: 'local', superResult: true } }));
      }
      superConstructCall(pc, v, [v.id, ...(v.projections ?? [])]);
      pc.claim({
        kind: 'class', blocks: [v.block], values: [v.id, ...(v.projections ?? [])],
        instructions: [], confidence: 'exact',
        cites: ['BuildGetAndCheckSuperConstructor:7105', 'BuildSuperCallOptimization:7123', 'VisitCallSuper:6961'],
        detail: 'super() dispatch',
      });
    } else if (v.op === 'GetSuperConstructor') {
      // the other half of BuildGetAndCheckSuperConstructor:7105 -- no dispatch
      // flag, the accumulator is `this_function` and the destination register
      // receives the super constructor.
      superConstructCall(pc, v, [v.id]);
      pc.claim({
        kind: 'class', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['BuildGetAndCheckSuperConstructor:7105'],
        detail: 'GetSuperConstructor',
      });
    }
  }
}

/**
 * The `Construct` that VisitCallSuper:6961 emits on the register
 * BuildGetAndCheckSuperConstructor just filled IS `super(args)` -- the
 * constructor is not an expression the source wrote, it is `this_function`'s
 * prototype, so `new <that>(args)` is a different program: it allocates a
 * second object, binds no `this`, and passes the wrong `new.target`
 * (VisitCallSuper loads `new_target` into the accumulator immediately before
 * the Construct, which is what makes it a super call rather than a `new`).
 *
 * So the construct is rewritten to `{e:'call', callee:{e:'super'}}`. When the
 * unit is not emitted as a derived class constructor the emitter turns the
 * `{e:'super'}` into a counted `superOutsideAMethod` hole, which is the honest
 * outcome: a visible refusal rather than a `new` that looks like source.
 */
function superConstructCall(pc, dispatch, candidateValues) {
  const ir = pc.ir;
  // `super(...)` is legal only in a DERIVED class constructor, and V8's own
  // FunctionKind bit says whether this unit is one (kDerivedConstructor /
  // kDefaultDerivedConstructor). VisitCallSuper:6961 is only reachable from a
  // Call::SUPER_CALL, so the kind and the shape always agree -- the guard is
  // here so that a shape which somehow appears elsewhere produces no illegal
  // text.
  if (!/Derived/.test(ir.unit?.functionKindName ?? '')) return;
  const targets = new Set(candidateValues.map((x) => pc.canon(x)));
  for (const id of candidateValues) {
    for (const useId of pc.usesOf(id)) {
      const use = ir.values[useId];
      if (!use || use.kind !== 'Op') continue;
      if (use.op !== 'Construct' && use.op !== 'ConstructWithSpread') continue;
      const all = pc.flatRegInputs(use);
      if (!all.length || !targets.has(pc.canon(all[0]))) continue;
      const rest = all.slice(1);
      pc.setExpr(use.id, () => ({
        e: 'call', optional: false,
        callee: { e: 'super' },
        args: use.op === 'ConstructWithSpread'
          ? rest.map((x, i) => (i === rest.length - 1 ? { spread: pc.E(x) } : pc.E(x)))
          : rest.map((x) => pc.E(x)),
      }));
      pc.claim({
        kind: 'class', blocks: [use.block], values: [use.id], instructions: [],
        confidence: 'exact',
        cites: ['VisitCallSuper:6961', 'BuildGetAndCheckSuperConstructor:7105'],
        detail: `super(${rest.length} argument(s))`,
      });
    }
  }
}

/** The constant an SSA value was loaded from, when it is a ClassBoilerplate. */
function boilerplateOf(pc, id) {
  if (id === null || id === undefined) return null;
  const v = pc.values[pc.canon(id)];
  if (!v || v.kind !== 'Op') return null;
  const ins = pc.ir.instructions[v.instruction];
  const c = ins?.operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
  return c?.t === 'classBoilerplate' ? c : null;
}

/** `ClassBoilerplate` kind -> the `kind` field `src/emit`'s classMember reads. */
const MEMBER_KIND = { data: 'method', getter: 'get', setter: 'set' };

/**
 * The boilerplate's entries with the argument list substituted in.
 *
 * Called from inside the `{e:'class'}` thunk, so `pc.E` resolves a member's
 * closure at the same time as the rest of the class rather than during the
 * pattern pass.
 */
function membersOf(pc, cb, args) {
  const members = [];
  const notPlaced = [];
  for (const ent of cb.entries) {
    const kind = MEMBER_KIND[ent.kind];
    if (kind === undefined) {
      // `accessor x` (ClassLiteral::Property::AUTO_ACCESSOR). It has no
      // `{kind}` src/emit can spell, and guessing `get`/`set` would emit a
      // different program, so it is refused by name.
      notPlaced.push({ why: 'classMemberKindNotSpellable', detail: ent.kind, key: ent.key ?? null });
      continue;
    }
    const argId = args[ent.valueIndex];
    if (argId === undefined || argId === null) {
      notPlaced.push({
        why: 'classMemberValueArgumentMissing', key: ent.key ?? null,
        detail: `the boilerplate names args[${ent.valueIndex}] and the call has ${args.length} argument(s)`,
      });
      continue;
    }
    // The member's VALUE is read as the raw transcription of its register's
    // defining instruction, not through `pc.E`.
    //
    // `pc.E` routes through the inlining plan, and the plan materialises this
    // value: the absorb pass works backwards from a use instruction, and the
    // only instruction that reads the member closures is the `%DefineClass`
    // this pattern consumed. The remaining candidate user is the value the
    // `{e:'class'}` sits on -- the CONSTRUCTOR's `CreateClosure` -- and
    // `BuildClassLiteral:3659-3662` emits that one BEFORE the members, so the
    // member's definition does not dominate it and `inline.mjs` marks it
    // `defDoesNotDominateUse`. Asking for the materialised form then yields
    // `{e:'name'}` for a name whose `let` this pattern consumed: measured on
    // `r_15524.jsc`, 12 of 14 members came out as
    // `HOLE classMemberValueIsNotAClosure (name)`.
    //
    // A `CreateClosure` is all a member value can be: `BuildClassLiteral:3731`
    // is `VisitForRegisterValue(property->value(), value)` and a METHOD /
    // GETTER / SETTER property's value is a FunctionLiteral. So the
    // transcription is the closure, and anything else is refused.
    const fn = pc.exprOf(pc.canon(argId));
    if (fn?.e !== 'fn') {
      notPlaced.push({
        why: 'classMemberValueIsNotAClosure', key: ent.key ?? null,
        detail: `args[${ent.valueIndex}] transcribes to ${fn?.e ?? 'nothing'}`,
      });
      continue;
    }
    let key = null;
    let computed = false;
    if (ent.keyKind === 'name') { key = ent.key; }
    else if (ent.keyKind === 'index') { key = { e: 'lit', v: ent.key }; computed = true; }
    else if (ent.keyKind === 'computed') {
      const keyId = ent.keyIndex === null ? undefined : args[ent.keyIndex];
      if (keyId === undefined || keyId === null) {
        notPlaced.push({
          why: 'classMemberKeyArgumentMissing', key: null,
          detail: `the boilerplate names args[${ent.keyIndex}] as the computed key`,
        });
        continue;
      }
      key = pc.E(keyId); computed = true;
    } else {
      // A symbol-keyed descriptor with a dynamic-argument value. A Symbol has
      // no source spelling, so there is nothing to write.
      notPlaced.push({ why: 'classMemberKeyKindNotSpellable', detail: ent.keyKind, key: ent.key ?? null });
      continue;
    }
    members.push({ kind, key, computed, static: ent.side === 'static', value: fn });
  }
  // Each refusal the decode itself made, carried through rather than summarised
  // away: the emitted class is incomplete and the reason is src/heap's.
  for (const r of cb.refusals) {
    notPlaced.push({ why: `classBoilerplate:${r.why}`, detail: r.detail ?? r.side ?? null, key: r.key ?? null });
  }
  return { members, notPlaced };
}

function defineClass(pc, v) {
  const args = pc.flatRegInputs(v);
  const ctorId = args[1] ?? null;
  const superId = args[2] ?? null;
  const ctorExpr = ctorId === null ? null : pc.exprOf(pc.canon(ctorId));
  const superExpr = superId === null ? null : pc.exprOf(pc.canon(superId));
  // `class X {}` and `class X extends E {}` differ by ONE value:
  // BuildClassLiteral:3657 is `VisitForAccumulatorValueOrTheHole(expr->extends())`,
  // so args[2] is the hole oddball exactly when there is no `extends` clause.
  // Anything else is an extends clause, INCLUDING a value this shallow
  // transcription cannot describe -- a phi, for instance, which
  // `pc.exprOf` has no answer for. Treating "no answer" as "no extends" (the
  // old `!superExpr`) emitted `class { constructor() { super() } }` for a
  // derived class whose super class was computed by a conditional, and that is
  // a SyntaxError, not a decompilation: measured on `r_vendorsXvue.jsc`, whose
  // whole output stopped compiling (`'super' keyword unexpected here`).
  // `pc.E(superId)` resolves the phi properly.
  const noExtends = superId === null || superId === undefined
    || (superExpr?.e === 'hole' && (superExpr.why === 'theHole' || superExpr.why === 'theHoleConstant'));

  // WHICH VALUE IS THE CLASS?  Not the runtime call's result.
  //
  // BuildClassLiteral:3645-3662 allocates `args[1]`
  // (`class_constructor_in_args`) and then does
  //
  //     VisitFunctionLiteral(expr->constructor());                  // CreateClosure
  //     StoreAccumulatorInRegister(class_constructor)               // a temp
  //     MoveRegister(class_constructor, class_constructor_in_args)  // -> args[1]
  //
  // `Runtime::kDefineClass` installs the prototype, the home object and the
  // members ONTO THAT JSFunction -- the class IS the constructor object -- and
  // returns the PROTOTYPE in the accumulator, which is why the generator
  // continues with "Accumulator already contains the prototype" (:3738) and
  // finishes with `LoadAccumulatorWithRegister(class_constructor)` (:3829),
  // reading the class back out of the register it moved the closure into. The
  // move makes the two one SSA value.
  //
  // So `{e:'class'}` belongs on the CreateClosure's value and the call's own
  // value is `<that class>.prototype`. With it the other way round, the class
  // expression sat on a value the generator never reads: measured on
  // `r_55201.jsc`, 8 of 8 %DefineClass sites produced an `{e:'class'}` that
  // reached no statement, the emitted text contained no `class` at all, and
  // every use of the class resolved to `{e:'fn', sfiId}` -- so the constructor
  // was emitted as a sibling function declaration, which is also why a derived
  // constructor's `super()` could not be written (`super` is only legal inside
  // a class method).
  const classValue = ctorId !== null && ctorExpr?.e === 'fn' ? pc.canon(ctorId) : v.id;
  const cb = boilerplateOf(pc, args[0] ?? null);
  pc.setExpr(classValue, () => {
    const m = cb === null ? null : membersOf(pc, cb, args);
    return {
      e: 'class',
      sfiId: ctorExpr?.e === 'fn' ? ctorExpr.sfiId : null,
      name: ctorExpr?.e === 'fn' ? ctorExpr.name : null,
      superClass: noExtends ? null : pc.E(superId),
      // `membersDecoded` is what tells "this class has no members" from "the
      // member list was not readable": `class C { constructor(){} }` is the
      // first, and src/emit must not mark a hole for it.
      membersDecoded: m !== null,
      members: m ? m.members : [],
      membersNotPlaced: m ? m.notPlaced : [],
      boilerplateArgumentsUnclaimed: cb?.argumentsUnclaimed ?? null,
      dynamicArguments: Math.max(0, args.length - 3),
    };
  });
  if (classValue !== v.id) {
    pc.setExpr(v.id, () => ({
      e: 'member', obj: pc.E(classValue), prop: 'prototype', computed: false, optional: false,
    }));
  }
  // A pair-returning form puts the prototype in a projection instead.
  for (const p of v.projections ?? []) {
    pc.setExpr(p, () => ({ e: 'member', obj: pc.E(classValue), prop: 'prototype', computed: false, optional: false }));
  }
  pc.consumeMovesFeeding(v);
  // The method closures are `args[3..]`; their `CreateClosure` instructions
  // exist only to fill that argument list, exactly like an object literal's
  // property values, so they are consumed here and the member carries the
  // `{e:'fn'}`. Without this each one is still a live pure value and the
  // statement loop emits it a second time, next to the class.
  for (const id of args.slice(3)) {
    const src = pc.values[pc.canon(id)];
    if (src && src.kind === 'Op' && src.op === 'CreateClosure') pc.consume(src.instruction);
  }
  pc.claim({
    kind: 'class', blocks: [v.block], values: [v.id, ...(v.projections ?? [])],
    instructions: [v.instruction], confidence: cb === null ? 'shape' : 'exact',
    cites: ['BuildClassLiteral:3534', 'VisitClassLiteral:3832', 'ClassBoilerplate::New:680'],
    detail: cb === null
      ? `${Math.max(0, args.length - 3)} dynamic argument(s); args[0] is not a decoded ClassBoilerplate`
      : `${cb.entries.length} member(s) from the ClassBoilerplate, `
        + `${cb.refusals.length} refusal(s), ${cb.argumentsUnclaimed ?? '?'} dynamic argument(s) it does not describe`,
  });
  pc.consume(v.instruction);
}

function privateName(pc, v, rt) {
  const args = pc.flatRegInputs(v);
  const n = args.length ? pc.stringOf(args[0]) : null;
  pc.setExpr(v.id, () => ({ e: 'lit', v: n === null ? '#private' : '#' + n, privateName: true }));
  pc.claim({
    kind: 'privateField', blocks: [v.block], values: [v.id],
    instructions: [v.instruction], confidence: 'exact',
    cites: ['BuildClassLiteral:3534'], detail: rt,
  });
  pc.consume(v.instruction);
}

function privateAccessors(pc, v) {
  pc.claim({
    kind: 'privateField', blocks: [v.block], values: [v.id], instructions: [],
    confidence: 'exact', cites: ['BuildClassLiteral:3534'], detail: 'CreatePrivateAccessors',
  });
}

export default { name: 'classes', run };
