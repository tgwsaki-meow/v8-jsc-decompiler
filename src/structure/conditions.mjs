// src/structure/conditions.mjs
//
// `Test` and `Target` (ARCHITECTURE.md 11.2), and nothing else.
//
// This is the whole of the T7/T8 split. T8 never says "the condition is
// `a > b`"; it says "the condition is the SSA value the terminator of block 7
// reads, and the then-branch runs when that value is falsy". T7 independently
// maps SSA values to expressions and T9 joins them, so neither task has to
// talk to the other.
//
//     Test = { block, value: ssaId, negate }                  -- 11.2
//
// Two additions, both because 11.2's three fields cannot express what the
// bytecode means. They are additive, in the style docs/IR.md section 10 used
// for 8.4:
//
//   `predicate`   `JumpIfUndefinedOrNull` branches on `value == null`, not on
//                 `value`. There are seven such predicates (null, notNull,
//                 undefined, notUndefined, undefinedOrNull, jsReceiver,
//                 forInDone) and emitting `if (value)` for any of them is
//                 silently wrong -- the exact failure mode ARCHITECTURE.md
//                 section 7 forbids. `predicate` is a closed set
//                 (facts.mjs PREDICATE_KINDS), asserted total over every
//                 conditional jump of every profile.
//   `toBoolean`   true for the `JumpIfToBoolean*` forms, where the value is
//                 not already a boolean. T9 needs it to decide whether a `!`
//                 is enough or a `!!` is required in a value position.
//
// `negate === false` always means: the `then` region runs when
// predicate(value) holds. Swapping the branches flips it.

import { VAR_ACCUMULATOR } from '../ir/vars.mjs';

/**
 * The SSA values a block's terminator reads.
 * @returns {{value: number|null, values: number[], op: object|null}}
 */
export function terminatorInputs(ir, blockId) {
  const b = ir.blocks[blockId];
  const vid = ir.instructionValue[b.last];
  if (vid === undefined || vid < 0) return { value: null, values: [], op: null };
  const op = ir.values[vid];
  if (!op || op.kind !== 'Op') return { value: null, values: [], op: null };
  const readsAcc = !!op.sem?.accumulator?.read;
  return {
    value: readsAcc ? (op.inputs[0] ?? null) : null,
    values: op.inputs.slice(),
    op,
  };
}

/**
 * Build the `Test` of a two-way terminator.
 *
 * @param {object} ir
 * @param {object} facts   structureFacts(profile)
 * @param {number} blockId
 * @param {boolean} thenIsJumpTarget  true when the region passed as `then`
 *        is the jump target, false when it is the fall-through
 */
export function conditionalTest(ir, facts, blockId, thenIsJumpTarget) {
  const b = ir.blocks[blockId];
  const ins = b.instructions[b.instructions.length - 1];
  const row = facts.predicateOf(ins.opcodeValue);
  if (!row) return null;
  const { value, values, op } = terminatorInputs(ir, blockId);
  // The jump is taken when the named predicate holds, so `row.negate` already
  // says whether the jump target is the "predicate false" side.
  const negate = thenIsJumpTarget ? row.negate : !row.negate;
  return {
    block: blockId,
    value: row.onValue === false ? null : value,
    negate,
    predicate: row.kind,
    toBoolean: row.toBoolean,
    opcode: ins.opcode,
    values: row.onValue === false ? values : undefined,
    valueless: row.onValue === false || value === null || value === undefined,
  };
}

/** Flip a Test in place-free fashion. */
export function negated(test) {
  return test === null ? null : { ...test, negate: !test.negate };
}

/**
 * A `Test` standing for "the value in the accumulator at the end of this
 * block", with no predicate -- used for a `switch` discriminant and for the
 * right-hand side of a `for-in` / `for-of` head.
 */
export function valueTest(ir, blockId, ssaId, why) {
  return { block: blockId, value: ssaId ?? null, negate: false, predicate: 'value', toBoolean: false, opcode: null, why };
}

/** `Target = { value: ssaId } | { slotValue: ssaId }` (11.2). */
export function targetOf(ir, ssaId) {
  if (ssaId === null || ssaId === undefined) return null;
  const v = ir.values[ssaId];
  if (v && v.kind === 'Op' && v.contextSlot && v.contextSlot.slotValue !== null
    && v.contextSlot.slotValue !== undefined) {
    return { slotValue: v.contextSlot.slotValue, value: ssaId };
  }
  return { value: ssaId };
}

/**
 * The value a handler entry binds: the caught exception. T6 models it as its
 * own `CaughtException` definition rather than a phi (docs/IR.md section 5),
 * and that definition is what `catch (e)` binds.
 */
export function caughtTarget(ir, handlerBlockId) {
  const ce = ir.caughtException?.get?.(handlerBlockId);
  if (ce === undefined || ce === null) return null;
  return { value: ce, caught: true };
}

export { VAR_ACCUMULATOR };
export default { conditionalTest, negated, valueTest, targetOf, caughtTarget, terminatorInputs };
