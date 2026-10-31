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
// live. The member list is deliberately NOT reconstructed from the dynamic
// arguments: the boilerplate holds the static half and src/heap does not decode
// `ClassBoilerplate`, so claiming a full member list would be an invention.
// `members` is left empty, the claim is `confidence:'shape'`, and the gap is in
// docs/RECOVER.md.
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
      // its outputs are (found_non_default, implicit_this_or_constructor)
      pc.setExpr(v.id, () => ({ e: 'lit', v: true, superDispatch: true }));
      for (const p of v.projections ?? []) {
        pc.setExpr(p, () => ({ e: 'name', name: 'this', ref: { k: 'local', superResult: true } }));
      }
      pc.claim({
        kind: 'class', blocks: [v.block], values: [v.id, ...(v.projections ?? [])],
        instructions: [], confidence: 'exact',
        cites: ['BuildGetAndCheckSuperConstructor:7105', 'VisitCallSuper:6961'],
        detail: 'super() dispatch',
      });
    } else if (v.op === 'GetSuperConstructor') {
      pc.claim({
        kind: 'class', blocks: [v.block], values: [v.id], instructions: [],
        confidence: 'exact', cites: ['BuildGetAndCheckSuperConstructor:7105'],
        detail: 'GetSuperConstructor',
      });
    }
  }
}

function defineClass(pc, v) {
  const args = pc.flatRegInputs(v);
  const ctorId = args[1] ?? null;
  const superId = args[2] ?? null;
  const ctorExpr = ctorId === null ? null : pc.exprOf(pc.canon(ctorId));
  const superExpr = superId === null ? null : pc.exprOf(pc.canon(superId));
  const noExtends = !superExpr || superExpr.e === 'hole' && superExpr.why === 'theHole';

  pc.setExpr(v.id, () => ({
    e: 'class',
    sfiId: ctorExpr?.e === 'fn' ? ctorExpr.sfiId : null,
    name: ctorExpr?.e === 'fn' ? ctorExpr.name : null,
    superClass: noExtends ? null : pc.E(superId),
    members: [],
    dynamicArguments: Math.max(0, args.length - 3),
  }));
  // the class is a value, not a statement: its %DefineClass returns a pair
  // (the class and its prototype) and the prototype projection is plumbing.
  for (const p of v.projections ?? []) {
    pc.setExpr(p, () => ({ e: 'member', obj: pc.E(v.id), prop: 'prototype', computed: false, optional: false }));
  }
  pc.consumeMovesFeeding(v);
  pc.claim({
    kind: 'class', blocks: [v.block], values: [v.id, ...(v.projections ?? [])],
    instructions: [v.instruction], confidence: 'shape',
    cites: ['BuildClassLiteral:3534', 'VisitClassLiteral:3832'],
    detail: `${Math.max(0, args.length - 3)} dynamic argument(s); the member list comes from the `
      + 'ClassBoilerplate constant, which src/heap does not decode',
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
