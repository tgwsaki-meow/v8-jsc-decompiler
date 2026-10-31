// src/structure/facts.mjs
//
// Every opcode name and every branch predicate name this layer matches on, in
// one table, checked against the loaded profile once.
//
// ARCHITECTURE.md 11.0 and docs/IR.md's hygiene rule: no version literal may
// appear in src/, and an opcode name may appear only for *syntactic shape
// matching* -- and then it must be checked against the profile so a version
// change fails loudly instead of silently never matching. That is what this
// file is for. Membership of the jump family, the switch family, the
// terminators, the unconditional jumps and the generator dispatcher is NOT
// re-derived here: src/disasm/opcode_facts.mjs and src/ir/cfg.mjs already
// derive all of it from operand types (ARCHITECTURE.md 11.6), and `cfgFacts` is
// re-exported through this module so there is one source for it.
//
// The shapes that need a name, and why a name is unavoidable for each:
//
//   TestEqualStrict      the compare-chain `switch`. V8 emits a chain of
//                        strict-equality tests for a `switch` that does not
//                        qualify for a jump table, and ARCHITECTURE.md 9.3
//                        measures that this is 99.65% of all switches. No
//                        operand type distinguishes `===` from `==`.
//   TestReferenceEqual   the one-command `finally` token test. V8's
//                        DeferredCommands::ApplyDeferredCommands uses
//                        CompareReference (-> TestReferenceEqual) when a
//                        `finally` has exactly ONE deferred command and a
//                        SwitchOnSmiNoFeedback jump table when it has two or
//                        more. ARCHITECTURE.md 4.4.5 only describes the second.
//   ForInEnumerate/Prepare/Next/Step    the `for-in` idiom.
//   GetIterator, IteratorClose-ish      the `for-of` idiom (annotation only).
//   SuspendGenerator, ResumeGenerator   checked for existence only; the actual
//                        suspend/resume pairing comes from T6's
//                        ir.contextChain.suspendByIdIns / suspendOfResume, as
//                        ARCHITECTURE.md 11.2 constraint 1 requires.
//
// The branch predicates are the other half. ARCHITECTURE.md 11.2 types a
// condition as `Test = {block, value, negate}`, i.e. "that SSA value, possibly
// negated". That is not enough: `JumpIfUndefinedOrNull` branches on
// `value == null`, not on `value`. Emitting `if (value)` for it is silently
// wrong, so the normalised predicate travels with the Test and the table below
// is asserted total over the profile's conditional jumps.

import { cfgFacts } from '../ir/cfg.mjs';

/**
 * predicate name (src/ir/cfg.mjs's `predicateOf`, parsed out of the
 * `JumpIf<Predicate>[Constant]` grammar) -> how to read it.
 *
 *   kind     the normalised test, a closed set T9 maps to an expression
 *   negate   true when the opcode jumps on the predicate being FALSE
 *   toBoolean  the value needs ToBoolean (`JumpIfToBoolean*`), i.e. the
 *              operand is not already a boolean
 *   onValue  false when the predicate does not read the accumulator at all
 */
const PREDICATES = Object.freeze({
  True: { kind: 'truthy', negate: false, toBoolean: false },
  False: { kind: 'truthy', negate: true, toBoolean: false },
  ToBooleanTrue: { kind: 'truthy', negate: false, toBoolean: true },
  ToBooleanFalse: { kind: 'truthy', negate: true, toBoolean: true },
  Null: { kind: 'null', negate: false, toBoolean: false },
  NotNull: { kind: 'null', negate: true, toBoolean: false },
  Undefined: { kind: 'undefined', negate: false, toBoolean: false },
  NotUndefined: { kind: 'undefined', negate: true, toBoolean: false },
  UndefinedOrNull: { kind: 'undefinedOrNull', negate: false, toBoolean: false },
  JSReceiver: { kind: 'jsReceiver', negate: false, toBoolean: false },
  ForInDone: { kind: 'forInDone', negate: false, toBoolean: false, onValue: false },
});

export const PREDICATE_KINDS = Object.freeze([...new Set(Object.values(PREDICATES).map((p) => p.kind))]);

/**
 * The register-move family. A compare-chain `switch` tests `Mov`-copies of its
 * discriminant in links 2..n (see switches.mjs), so the links can only be
 * matched if a copy can be followed to the value it stands for -- and there is
 * no operand type or effect flag that separates a copy from a one-input pure
 * computation (`LogicalNot` and `TypeOf` have the same signature). So these
 * three are named, and the short-star block is taken from the profile's own
 * `shortStarRange` rather than from a name pattern.
 */
const COPY_NAMES = Object.freeze(['Mov', 'Ldar', 'Star']);

/** Opcode names matched for syntactic shape, each with the reason it is named. */
const SHAPES = Object.freeze({
  strictEqual: 'TestEqualStrict',
  referenceEqual: 'TestReferenceEqual',
  forInEnumerate: 'ForInEnumerate',
  forInPrepare: 'ForInPrepare',
  forInNext: 'ForInNext',
  forInStep: 'ForInStep',
  getIterator: 'GetIterator',
  suspendGenerator: 'SuspendGenerator',
  resumeGenerator: 'ResumeGenerator',
  setPendingMessage: 'SetPendingMessage',
});

const cache = new WeakMap();

export function structureFacts(profile) {
  let f = cache.get(profile);
  if (f) return f;

  const F = cfgFacts(profile);
  const problems = [];

  // Every conditional jump the profile has must have a predicate in the table,
  // in both directions. A renamed or added predicate fails here rather than
  // quietly never matching.
  const seen = new Set();
  for (const v of F.conditionalJumps) {
    const name = profile.getOpcode(v).name;
    const p = F.predicateOf.get(v);
    seen.add(p);
    const row = PREDICATES[p];
    if (!row) {
      problems.push(`conditional jump ${name} has predicate '${p}', which src/structure/facts.mjs does not know; `
        + 'a Test built from it would carry the wrong meaning');
      continue;
    }
    const readsAcc = F.sem.of(name).accumulator.read;
    const wantsValue = row.onValue !== false;
    if (readsAcc !== wantsValue) {
      problems.push(`${name}: the table says onValue=${wantsValue} but the profile says `
        + `accumulator.read=${readsAcc}`);
    }
  }
  for (const p of Object.keys(PREDICATES)) {
    if (!seen.has(p)) problems.push(`src/structure/facts.mjs names predicate '${p}' which no conditional jump of this profile uses`);
  }

  const op = {};
  for (const [key, name] of Object.entries(SHAPES)) {
    const o = profile.getOpcode(name);
    if (!o) { problems.push(`profile has no opcode ${name}, which src/structure matches by name`); continue; }
    op[key] = name;
  }

  // The generator dispatcher and the Smi switch, told apart the way
  // src/ir/cfg.mjs does it (by whether the switch handler installs a context),
  // not by name. Exactly one of each is asserted there; assert the other half
  // here so `isSmiSwitch` is meaningful.
  const smiSwitch = [...F.facts.switchRoles.keys()].filter((v) => !F.isGeneratorDispatch(v));
  if (smiSwitch.length !== 1) {
    problems.push(`expected exactly one non-generator switch opcode (the Smi jump table); found ${smiSwitch.length}`);
  }

  const copyValues = new Set();
  for (const name of COPY_NAMES) {
    const o = profile.getOpcode(name);
    if (!o) { problems.push(`profile has no opcode ${name}, which src/structure needs to follow a register copy`); continue; }
    copyValues.add(o.value);
  }
  for (const v of F.facts.shortStarIndex.keys()) copyValues.add(v);
  if (!F.facts.shortStarIndex.size) {
    problems.push('the profile declares no short-star range, so a normalised StarN cannot be recognised as a copy');
  }

  if (problems.length) {
    throw new Error(`profile ${profile.version}: src/structure cannot match on this profile:\n  ${problems.join('\n  ')}`);
  }

  const copyNameSet = new Set(COPY_NAMES);
  for (const v of F.facts.shortStarIndex.keys()) copyNameSet.add(profile.getOpcode(v).name);

  f = Object.freeze({
    profile, cfg: F, sem: F.sem, op,
    copyOpcodeValues: copyValues,
    /** Is this SSA value a pure one-input register copy? */
    isCopy: (value) => !!value && value.kind === 'Op' && copyNameSet.has(value.op)
      && (value.inputs ?? []).length === 1,
    predicateOf: (opcodeValue) => PREDICATES[F.predicateOf.get(opcodeValue)] ?? null,
    predicateNameOf: (opcodeValue) => F.predicateOf.get(opcodeValue) ?? null,
    isSmiSwitch: (opcodeValue) => F.isSwitch(opcodeValue) && !F.isGeneratorDispatch(opcodeValue),
    isGeneratorDispatch: (opcodeValue) => F.isGeneratorDispatch(opcodeValue),
    isConditionalJump: (opcodeValue) => F.conditionalJumps.has(opcodeValue),
    /**
     * Can this instruction raise? Exactly src/ir/cfg.mjs's own test for where
     * an exception edge leaves from (`effect.throws || effect.callsUserCode`),
     * so "no exception edge and cannot throw" is a sound statement about a
     * block rather than two half-statements. An opcode the table does not
     * name is treated as able to throw.
     */
    canThrow: (opcode) => {
      const s = F.sem.of(opcode);
      return !s || !s.effect || s.effect.throws || s.effect.callsUserCode;
    },
    isUnconditionalJump: (opcodeValue) => F.unconditionalJumps.has(opcodeValue),
    isSwitch: (opcodeValue) => F.isSwitch(opcodeValue),
    /** Is this instruction free of observable effect? Uses T6's table, never a name. */
    isPure: (opcode) => {
      const s = F.sem.of(opcode);
      return !!s && !s.hasEffect;
    },
  });
  cache.set(profile, f);
  return f;
}

export { cfgFacts };
export default { structureFacts, PREDICATE_KINDS };
