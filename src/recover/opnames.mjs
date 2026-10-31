// src/recover/opnames.mjs
//
// The one place in src/recover/ that writes down an opcode NAME.
//
// ARCHITECTURE.md's hard constraint for this layer: no decision about
// *semantics* may be keyed on an opcode name -- those come from `ir.sem`
// (`effect.{reads,writes,throws,callsUserCode,diverges}` and
// `allocationKind`, src/ir/opcode_effects.mjs). A name is acceptable only for
// *syntactic* idiom matching, because that is what an idiom is: a
// `BytecodeGenerator::Visit<Node>` method read backwards, and that method
// names bytecodes.
//
// Two rules keep that honest:
//
//   1. every name used anywhere in src/recover/ is declared here, grouped by
//      the generator method it comes from;
//   2. `registry(profile)` checks every declared name against the loaded
//      profile and THROWS, naming the missing opcodes. A V8 version that
//      renames or drops one fails loudly on the first function instead of
//      silently never matching its idiom.
//
// There is also no version literal here: the numbers that matter (opcode
// values, operand widths, the Smi in a jump table) all come from the profile
// via src/disasm. Only spelling lives in this file.

/**
 * Every opcode name src/recover/ mentions, by purpose.
 *
 * `OPTIONAL` names are the ones a profile may legitimately not have (a
 * bytecode added or removed between versions). They are reported, not fatal.
 */
export const GROUPS = Object.freeze({
  // ---- the transparent register moves (not an idiom: a copy)
  // BytecodeArrayBuilder::LoadAccumulatorWithRegister /
  // StoreAccumulatorInRegister / MoveRegister
  moves: ['Ldar', 'Star', 'Mov'],

  // ---- constants: VisitLiteral
  literals: ['LdaZero', 'LdaSmi', 'LdaConstant', 'LdaUndefined', 'LdaNull',
    'LdaTrue', 'LdaFalse', 'LdaTheHole'],

  // ---- globals: BuildVariableLoad / BuildStoreGlobal / VisitForTypeOfValue
  globals: ['LdaGlobal', 'LdaGlobalInsideTypeof', 'StaGlobal',
    'LdaLookupGlobalSlot', 'LdaLookupGlobalSlotInsideTypeof',
    'LdaLookupSlot', 'LdaLookupSlotInsideTypeof', 'StaLookupSlot',
    'LdaLookupContextSlot', 'LdaLookupContextSlotInsideTypeof',
    'LdaLookupContextSlotNoCell', 'LdaLookupContextSlotNoCellInsideTypeof'],

  // ---- properties: VisitPropertyLoad / BuildSetNamedProperty
  property: ['GetNamedProperty', 'GetNamedPropertyFromSuper', 'GetKeyedProperty',
    'GetEnumeratedKeyedProperty', 'SetNamedProperty', 'SetKeyedProperty',
    'DefineNamedOwnProperty', 'DefineKeyedOwnProperty',
    'DefineKeyedOwnPropertyInLiteral', 'StaInArrayLiteral'],

  // ---- VisitBinaryOperation / VisitArithmeticExpression / VisitCompareOperation
  binary: ['Add', 'Sub', 'Mul', 'Div', 'Mod', 'Exp',
    'BitwiseOr', 'BitwiseXor', 'BitwiseAnd',
    'ShiftLeft', 'ShiftRight', 'ShiftRightLogical',
    'AddSmi', 'SubSmi', 'MulSmi', 'DivSmi', 'ModSmi', 'ExpSmi',
    'BitwiseOrSmi', 'BitwiseXorSmi', 'BitwiseAndSmi',
    'ShiftLeftSmi', 'ShiftRightSmi', 'ShiftRightLogicalSmi',
    'Add_StringConstant_Internalize',
    'TestEqual', 'TestEqualStrict', 'TestLessThan', 'TestGreaterThan',
    'TestLessThanOrEqual', 'TestGreaterThanOrEqual', 'TestReferenceEqual',
    'TestInstanceOf', 'TestIn', 'TestUndetectable', 'TestNull', 'TestUndefined',
    'TestTypeOf'],

  // ---- VisitUnaryOperation / VisitNot / VisitCountOperation / VisitTypeOf
  unary: ['Inc', 'Dec', 'Negate', 'BitwiseNot', 'LogicalNot',
    'ToBooleanLogicalNot', 'TypeOf', 'ToBoolean', 'ToName', 'ToNumber',
    'ToNumeric', 'ToString', 'ToObject'],

  // ---- VisitDelete
  del: ['DeletePropertyStrict', 'DeletePropertySloppy'],

  // ---- VisitCall / VisitCallNew / VisitCallRuntime
  calls: ['CallAnyReceiver', 'CallProperty', 'CallProperty0', 'CallProperty1',
    'CallProperty2', 'CallUndefinedReceiver', 'CallUndefinedReceiver0',
    'CallUndefinedReceiver1', 'CallUndefinedReceiver2', 'CallWithSpread',
    'CallRuntime', 'CallRuntimeForPair', 'CallJSRuntime', 'InvokeIntrinsic',
    'Construct', 'ConstructWithSpread', 'ConstructForwardAllArgs'],

  // ---- the literal constructors: BuildCreateObjectLiteral /
  //      BuildCreateArrayLiteral / VisitRegExpLiteral / VisitFunctionLiteral
  literalCtors: ['CreateObjectLiteral', 'CreateEmptyObjectLiteral',
    'CreateArrayLiteral', 'CreateEmptyArrayLiteral', 'CreateArrayFromIterable',
    'CreateRegExpLiteral', 'CreateClosure', 'CloneObject', 'GetTemplateObject'],

  // ---- VisitArgumentsObject / VisitRestArgumentsArray
  argsObjects: ['CreateMappedArguments', 'CreateUnmappedArguments',
    'CreateRestParameter'],

  // ---- the contexts: BuildNewLocalActivationContext and friends
  contexts: ['CreateFunctionContext', 'CreateFunctionContextWithCells',
    'CreateBlockContext', 'CreateCatchContext', 'CreateWithContext',
    'CreateEvalContext', 'PushContext', 'PopContext'],

  // ---- BuildVariableLoad / BuildVariableAssignment, context-allocated
  contextSlots: ['LdaContextSlot', 'LdaContextSlotNoCell',
    'LdaImmutableContextSlot', 'LdaCurrentContextSlot',
    'LdaCurrentContextSlotNoCell', 'LdaImmutableCurrentContextSlot',
    'StaContextSlot', 'StaContextSlotNoCell', 'StaCurrentContextSlot',
    'StaCurrentContextSlotNoCell'],

  // ---- modules: VisitModuleDeclarations / BuildVariableLoad
  modules: ['LdaModuleVariable', 'StaModuleVariable'],

  // ---- the throw helpers the desugarings emit (BuildThrowIfHole,
  //      BuildHoleCheckForVariableAssignment, VisitCallSuper)
  throwHelpers: ['ThrowReferenceErrorIfHole', 'ThrowSuperNotCalledIfHole',
    'ThrowSuperAlreadyCalledIfNotHole', 'ThrowIfNotSuperConstructor',
    'Throw', 'ReThrow', 'Abort'],

  // ---- BuildTryFinally's pending-message dance
  finallyMessage: ['SetPendingMessage'],

  // ---- VisitForInStatement
  forIn: ['ForInEnumerate', 'ForInPrepare', 'ForInNext', 'ForInStep',
    'JumpIfForInDone', 'JumpIfForInDoneConstant'],

  // ---- VisitForOfStatement / BuildGetIterator / BuildIteratorNext
  forOf: ['GetIterator', 'ForOfNext'],

  // ---- BuildSuspendPoint / BuildAwait / VisitYield / BuildGeneratorPrologue
  generators: ['SuspendGenerator', 'ResumeGenerator', 'SwitchOnGeneratorState',
    'SwitchOnSmiNoFeedback'],

  // ---- VisitCallSuper / BuildClassLiteral
  classes: ['GetSuperConstructor', 'FindNonDefaultConstructorOrConstruct'],

  // ---- terminators and the jumps the idioms read. Their *targets* come from
  //      src/disasm (ins.jumpTarget), never from the name.
  jumps: ['Jump', 'JumpConstant', 'JumpLoop',
    'JumpIfTrue', 'JumpIfTrueConstant', 'JumpIfFalse', 'JumpIfFalseConstant',
    'JumpIfToBooleanTrue', 'JumpIfToBooleanTrueConstant',
    'JumpIfToBooleanFalse', 'JumpIfToBooleanFalseConstant',
    'JumpIfUndefined', 'JumpIfUndefinedConstant',
    'JumpIfNotUndefined', 'JumpIfNotUndefinedConstant',
    'JumpIfNull', 'JumpIfNullConstant', 'JumpIfNotNull', 'JumpIfNotNullConstant',
    'JumpIfUndefinedOrNull', 'JumpIfUndefinedOrNullConstant',
    'JumpIfJSReceiver', 'JumpIfJSReceiverConstant'],

  terminators: ['Return', 'Debugger', 'IncBlockCounter'],
});

/** Names a profile is allowed not to have. */
export const OPTIONAL = new Set([
  'Add_StringConstant_Internalize',      // added for template concatenation
  'LdaContextSlotNoCell', 'LdaCurrentContextSlotNoCell',
  'LdaLookupContextSlotNoCell', 'LdaLookupContextSlotNoCellInsideTypeof',
  'StaContextSlotNoCell', 'StaCurrentContextSlotNoCell',
  'CreateFunctionContextWithCells',
  'ConstructForwardAllArgs',
  'GetEnumeratedKeyedProperty',
  'JumpIfForInDone', 'JumpIfForInDoneConstant',
  'ForOfNext',
  'CallJSRuntime',
  'LdaLookupGlobalSlotInsideTypeof', 'LdaLookupContextSlotInsideTypeof',
  'JumpIfJSReceiverConstant',
]);

/** The groups whose members are matched as sets rather than individually. */
const SETS = Object.freeze({
  MOVE: 'moves',
  SMI_BINOP_SUFFIX: null,
});

export class OpcodeNameError extends Error {}

const cache = new WeakMap();

/**
 * Validate every declared name against one profile and return fast set
 * membership helpers.
 *
 * @param {object} profile a src/profile Profile
 */
export function registry(profile) {
  let r = cache.get(profile);
  if (r) return r;

  const present = new Set();
  const missing = [];
  const optionalMissing = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const n of names) {
      if (profile.getOpcode(n)) present.add(n);
      else if (OPTIONAL.has(n)) optionalMissing.push(`${group}.${n}`);
      else missing.push(`${group}.${n}`);
    }
  }
  if (missing.length) {
    throw new OpcodeNameError(
      `profile ${profile.version} does not have ${missing.length} opcode(s) the idiom `
      + `table of src/recover/ matches on:\n  ${missing.join('\n  ')}\n`
      + 'These names come from src/interpreter/bytecode-generator.cc at the pinned tag. '
      + 'A rename means docs/RECOVER.md\'s pattern table must be re-derived for this version.');
  }

  const has = (n) => present.has(n);
  const setOf = (group) => new Set(GROUPS[group].filter(has));

  r = Object.freeze({
    profile,
    present,
    optionalMissing,
    has,
    /** Throw unless the profile has this name (use at an idiom's entry point). */
    need(n) {
      if (!present.has(n)) {
        throw new OpcodeNameError(`profile ${profile.version} has no opcode ${n}`);
      }
      return n;
    },
    MOVES: setOf('moves'),
    LITERALS: setOf('literals'),
    JUMPS: setOf('jumps'),
    THROW_HELPERS: setOf('throwHelpers'),
    FOR_IN: setOf('forIn'),
    FOR_OF: setOf('forOf'),
    GENERATORS: setOf('generators'),
    CALLS: setOf('calls'),
    LITERAL_CTORS: setOf('literalCtors'),
    CONTEXTS: setOf('contexts'),
    CONTEXT_SLOTS: setOf('contextSlots'),
    SETS,
  });
  cache.set(profile, r);
  return r;
}

export default { registry, GROUPS, OPTIONAL, OpcodeNameError };
