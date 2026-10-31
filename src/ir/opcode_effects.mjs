// src/ir/opcode_effects.mjs
//
// What one bytecode does to the interpreter frame and to observable state.
//
// Two halves, kept apart on purpose:
//
//   1. MECHANICAL, derived from the profile. Which registers an instruction
//      reads and writes comes from the operand *types*
//      (operands.json: registerInputOperandTypes / registerOutputOperandTypes)
//      and what it does to the accumulator comes from `implicitRegisterUse`
//      (bytecodes.json). Nothing is named here, so a profile for another V8
//      version works unchanged.
//
//   2. DECLARED, in the tables below. Whether an op has an observable effect
//      and whether it allocates a fresh identity cannot be derived from any
//      generated table -- it is a statement about what the interpreter handler
//      in src/interpreter/interpreter-generator.cc does. ARCHITECTURE.md 8.4
//      requires both flags on every Op because 4.3's constrained inlining is
//      built on them, and the task spec says: do not guess, list them.
//
//      So they are listed, by opcode NAME, one line of reasoning each, in
//      EFFECTS below. Any opcode a profile carries that the table does not
//      name is reported as `unclassified` and conservatively treated as fully
//      effectful; `classifyProfile()` returns that list and
//      tools/ir/selftest.mjs fails if it is non-empty for either profile.
//      A new V8 version therefore shows up as a named gap, never as an opcode
//      silently assumed pure.
//
// Three implicit-register tables also live here, because they are the same
// kind of statement -- a handler touching a frame register that no operand
// names:
//
//   IMPLICIT_CONTEXT_WRITE   the handler calls SetContext()
//   IMPLICIT_CONTEXT_READ    the handler consumes the current context as a
//                            *value* (captures it, or addresses slots in it)
//   SHORT_STAR               handled upstream: src/disasm normalises StarN to
//                            Star and appends the synthetic kRegOut operand,
//                            so nothing is needed here.
//
// Every bytecode technically reads the frame's context (that is how the
// interpreter reaches the native context for an IC). Recording that everywhere
// would make the context register an input of 10.9M instructions and say
// nothing. It is recorded only where the context value is semantically
// consumed, which is what the IR's context-chain tracking needs (see
// src/ir/context.mjs).

// ---------------------------------------------------------------------------
// effect kinds
// ---------------------------------------------------------------------------
//
// A location class. Two ops interfere if one writes a kind the other reads or
// writes. 'heap' is a single undifferentiated class: we do no alias analysis.

export const EFFECT_KINDS = Object.freeze([
  'heap',       // any JS object property, element or prototype
  'global',     // the global object / script context via Lda*Global
  'context',    // a Context slot (Sta*ContextSlot writes, Lda*ContextSlot reads)
  'module',     // a module variable cell
  'message',    // the isolate's pending message (SetPendingMessage)
  'generator',  // a JSGeneratorObject's state / continuation / spilled frame
  'coverage',   // block coverage counters (IncBlockCounter)
  'debugger',   // anything the debugger can observe or change
]);

/** `allocationKind`: how sure we are that the result is a fresh object. */
export const ALLOCATION_KINDS = Object.freeze(['none', 'definite', 'maybe', 'cached']);

const NONE = Object.freeze({ reads: [], writes: [], throws: false, callsUserCode: false, diverges: false });

/** One EFFECTS row. */
function E(spec) {
  return Object.freeze({
    reads: Object.freeze(spec.reads ?? []),
    writes: Object.freeze(spec.writes ?? []),
    throws: !!spec.throws,
    callsUserCode: !!spec.callsUserCode,
    diverges: !!spec.diverges,
    allocation: spec.allocation ?? 'none',
    why: spec.why,
  });
}

// Shorthands for the recurring shapes, each with its justification once.
//
// userCall: the handler can enter arbitrary JavaScript (a getter, a setter, a
//   proxy trap, valueOf/toString, or a plain call). That reads and writes the
//   whole heap, can throw, and can fail to return.
const userCall = (why, allocation = 'maybe') => E({
  reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
  throws: true, callsUserCode: true, diverges: true, allocation, why,
});
// toPrimitive: an abstract operation that calls valueOf / toString /
//   Symbol.toPrimitive when its input is an object. Same blast radius as a
//   call; the result itself is a primitive, so no identity.
const toPrimitive = (why) => E({
  reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
  throws: true, callsUserCode: true, diverges: true, allocation: 'none', why,
});
const pure = (why) => E({ why });
const alloc = (why) => E({ allocation: 'definite', why });

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------
//
// Keyed by opcode name. `Star0..Star15` are absent on purpose: src/disasm
// rewrites them to `Star` before the IR ever sees them.

export const EFFECTS = Object.freeze({
  // -- prefixes and the poison value. Never reach the IR: src/disasm consumes
  //    the prefix byte and refuses Illegal.
  Wide: pure('operand-scaling prefix, consumed by the decoder'),
  ExtraWide: pure('operand-scaling prefix, consumed by the decoder'),
  Illegal: E({ throws: true, why: 'must not appear in a BytecodeArray; kept so the table is total' }),

  // -- accumulator / register moves and constants: no state at all
  Ldar: pure('register -> accumulator'),
  Star: pure('accumulator -> register'),
  Mov: pure('register -> register'),
  LdaZero: pure('immediate 0'),
  LdaSmi: pure('immediate Smi'),
  LdaUndefined: pure('the undefined oddball'),
  LdaNull: pure('the null oddball'),
  LdaTheHole: pure('the hole oddball (TDZ marker)'),
  LdaTrue: pure('the true oddball'),
  LdaFalse: pure('the false oddball'),
  LdaConstant: pure('a constant pool entry; the pool is immutable'),

  // -- context slots.
  //    A load reads mutable memory, so it must not be moved across a store,
  //    but it cannot throw and cannot run user code: hasEffect is false and it
  //    still joins the effect chain as a read. The Immutable* forms are
  //    emitted only for bindings V8 proved are assigned once before any read
  //    (BytecodeGenerator::BuildVariableLoad), so they are pure and may be
  //    duplicated -- which is exactly ARCHITECTURE.md 4.3's "immutable context
  //    slot read" exception.
  LdaContextSlot: E({ reads: ['context'], why: 'context slot load, possibly through a ContextCell' }),
  LdaContextSlotNoCell: E({ reads: ['context'], why: 'context slot load, known not to be a cell' }),
  LdaImmutableContextSlot: pure('context slot proven assigned-once before any read'),
  LdaCurrentContextSlot: E({ reads: ['context'], why: 'slot of the current context' }),
  LdaCurrentContextSlotNoCell: E({ reads: ['context'], why: 'slot of the current context, not a cell' }),
  LdaImmutableCurrentContextSlot: pure('assigned-once slot of the current context'),
  StaContextSlot: E({ writes: ['context'], why: 'context slot store' }),
  StaContextSlotNoCell: E({ writes: ['context'], why: 'context slot store, not a cell' }),
  StaCurrentContextSlot: E({ writes: ['context'], why: 'store to a slot of the current context' }),
  StaCurrentContextSlotNoCell: E({ writes: ['context'], why: 'store to the current context, not a cell' }),

  // -- the context register itself. SetContext() is frame state, not JS state,
  //    but the value is tracked in SSA, so these are recorded as pure and the
  //    register traffic is expressed through IMPLICIT_CONTEXT_* below.
  PushContext: pure('saves the current context in a register and installs the accumulator'),
  PopContext: pure('reinstalls the context held in a register'),

  // -- tests that cannot run user code
  TestReferenceEqual: pure('tagged pointer comparison'),
  TestUndetectable: pure('a map bit test'),
  TestNull: pure('oddball identity'),
  TestUndefined: pure('oddball identity'),
  TestTypeOf: pure('a map / instance-type test against a literal type name'),
  TestEqualStrict: pure('=== never converts'),
  ToBooleanLogicalNot: pure('ToBoolean never calls user code'),
  LogicalNot: pure('negates an already-boolean accumulator'),
  ToBoolean: pure('ToBoolean never calls user code'),
  TypeOf: pure('typeof reads the map only'),

  // -- tests and arithmetic that run ToPrimitive / a trap
  TestEqual: toPrimitive('loose == applies ToPrimitive to an object operand'),
  TestLessThan: toPrimitive('relational comparison applies ToPrimitive'),
  TestGreaterThan: toPrimitive('relational comparison applies ToPrimitive'),
  TestLessThanOrEqual: toPrimitive('relational comparison applies ToPrimitive'),
  TestGreaterThanOrEqual: toPrimitive('relational comparison applies ToPrimitive'),
  TestInstanceOf: userCall('instanceof calls Symbol.hasInstance', 'none'),
  TestIn: userCall('the in operator fires a proxy "has" trap and throws on a primitive RHS', 'none'),
  Add: toPrimitive('+ applies ToPrimitive to both operands'),
  Sub: toPrimitive('- applies ToNumeric'),
  Mul: toPrimitive('* applies ToNumeric'),
  Div: toPrimitive('/ applies ToNumeric'),
  Mod: toPrimitive('% applies ToNumeric'),
  Exp: toPrimitive('** applies ToNumeric'),
  BitwiseOr: toPrimitive('| applies ToNumeric'),
  BitwiseXor: toPrimitive('^ applies ToNumeric'),
  BitwiseAnd: toPrimitive('& applies ToNumeric'),
  ShiftLeft: toPrimitive('<< applies ToNumeric'),
  ShiftRight: toPrimitive('>> applies ToNumeric'),
  ShiftRightLogical: toPrimitive('>>> applies ToNumeric'),
  Add_StringConstant_Internalize: toPrimitive('+ with a string constant still applies ToPrimitive to the other side'),
  AddSmi: toPrimitive('the accumulator side can still be an object'),
  SubSmi: toPrimitive('the accumulator side can still be an object'),
  MulSmi: toPrimitive('the accumulator side can still be an object'),
  DivSmi: toPrimitive('the accumulator side can still be an object'),
  ModSmi: toPrimitive('the accumulator side can still be an object'),
  ExpSmi: toPrimitive('the accumulator side can still be an object'),
  BitwiseOrSmi: toPrimitive('the accumulator side can still be an object'),
  BitwiseXorSmi: toPrimitive('the accumulator side can still be an object'),
  BitwiseAndSmi: toPrimitive('the accumulator side can still be an object'),
  ShiftLeftSmi: toPrimitive('the accumulator side can still be an object'),
  ShiftRightSmi: toPrimitive('the accumulator side can still be an object'),
  ShiftRightLogicalSmi: toPrimitive('the accumulator side can still be an object'),
  Inc: toPrimitive('++ applies ToNumeric'),
  Dec: toPrimitive('-- applies ToNumeric'),
  Negate: toPrimitive('unary - applies ToNumeric'),
  BitwiseNot: toPrimitive('~ applies ToNumeric'),
  ToNumber: toPrimitive('ToNumber calls valueOf'),
  ToNumeric: toPrimitive('ToNumeric calls valueOf'),
  ToName: toPrimitive('ToPropertyKey calls Symbol.toPrimitive / toString'),
  ToString: toPrimitive('ToString calls toString / valueOf'),
  ToObject: E({
    reads: ['heap'], writes: [], throws: true, callsUserCode: false, allocation: 'maybe',
    why: 'wraps a primitive in a fresh wrapper object and throws on null/undefined',
  }),

  // -- globals
  LdaGlobal: userCall('a global load fires an accessor and throws ReferenceError when absent', 'none'),
  LdaGlobalInsideTypeof: E({
    reads: ['global', 'heap'], callsUserCode: true, diverges: true, throws: true,
    why: 'same load, but typeof suppresses the ReferenceError; an accessor can still run',
  }),
  StaGlobal: userCall('a global store fires a setter and throws in strict mode', 'none'),

  // -- dynamic scope lookup: with / sloppy direct eval
  LdaLookupSlot: userCall('walks the scope chain through with-objects and extensions', 'none'),
  LdaLookupSlotInsideTypeof: userCall('same walk, ReferenceError suppressed', 'none'),
  LdaLookupContextSlot: userCall('context fast path with a dynamic-scope fallback', 'none'),
  LdaLookupContextSlotNoCell: userCall('context fast path with a dynamic-scope fallback', 'none'),
  LdaLookupContextSlotInsideTypeof: userCall('context fast path with a dynamic-scope fallback', 'none'),
  LdaLookupContextSlotNoCellInsideTypeof: userCall('context fast path with a dynamic-scope fallback', 'none'),
  LdaLookupGlobalSlot: userCall('global fast path with a dynamic-scope fallback', 'none'),
  LdaLookupGlobalSlotInsideTypeof: userCall('global fast path with a dynamic-scope fallback', 'none'),
  StaLookupSlot: userCall('dynamic-scope store', 'none'),

  // -- module variables
  LdaModuleVariable: E({
    reads: ['module'], throws: true,
    why: 'reads an import/export cell; an uninitialised cyclic import throws',
  }),
  StaModuleVariable: E({ writes: ['module'], why: 'writes an export cell' }),

  // -- property access. Every one of these can enter an accessor or a proxy
  //    trap, so they are full calls as far as ordering goes.
  GetNamedProperty: userCall('named load can run a getter or a proxy get trap', 'maybe'),
  GetNamedPropertyFromSuper: userCall('super.x load can run a getter', 'maybe'),
  GetKeyedProperty: userCall('keyed load can run a getter or a proxy get trap', 'maybe'),
  GetEnumeratedKeyedProperty: userCall('for-in keyed load can run a getter', 'maybe'),
  SetNamedProperty: userCall('named store can run a setter or a proxy set trap', 'none'),
  SetKeyedProperty: userCall('keyed store can run a setter or a proxy set trap', 'none'),
  DefineNamedOwnProperty: userCall('DefineOwnProperty can run a proxy defineProperty trap', 'none'),
  DefineKeyedOwnProperty: userCall('DefineOwnProperty can run a proxy defineProperty trap', 'none'),
  DefineKeyedOwnPropertyInLiteral: userCall('literal element definition with a computed key', 'none'),
  StaInArrayLiteral: userCall('array literal element store can grow the backing store', 'none'),
  SetPrototypeProperties: userCall('installs literal accessors / __proto__ on an object', 'none'),
  DeletePropertyStrict: userCall('delete can run a proxy deleteProperty trap and throws in strict mode', 'none'),
  DeletePropertySloppy: userCall('delete can run a proxy deleteProperty trap', 'none'),

  // -- calls and constructs
  CallAnyReceiver: userCall('a JS call'),
  CallProperty: userCall('a JS call'),
  CallProperty0: userCall('a JS call'),
  CallProperty1: userCall('a JS call'),
  CallProperty2: userCall('a JS call'),
  CallUndefinedReceiver: userCall('a JS call'),
  CallUndefinedReceiver0: userCall('a JS call'),
  CallUndefinedReceiver1: userCall('a JS call'),
  CallUndefinedReceiver2: userCall('a JS call'),
  CallWithSpread: userCall('a JS call, arguments spread through the iterator protocol'),
  CallRuntime: userCall('a C++ runtime function; the table does not model individual callees'),
  CallRuntimeForPair: userCall('a C++ runtime function returning two values'),
  CallJSRuntime: userCall('calls a native-context builtin as a JS function'),
  InvokeIntrinsic: userCall('an inlined runtime function'),
  Construct: E({
    reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
    throws: true, callsUserCode: true, diverges: true, allocation: 'definite',
    why: 'new always produces a fresh object unless the body returns one; either way the identity is new',
  }),
  ConstructWithSpread: E({
    reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
    throws: true, callsUserCode: true, diverges: true, allocation: 'definite',
    why: 'new with a spread argument list',
  }),
  ConstructForwardAllArgs: E({
    reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
    throws: true, callsUserCode: true, diverges: true, allocation: 'definite',
    why: 'the derived-constructor super(...arguments) form',
  }),
  GetSuperConstructor: E({
    reads: ['heap'],
    why: 'loads the home object prototype; mutable because a prototype can be reassigned',
  }),
  FindNonDefaultConstructorOrConstruct: E({
    reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
    throws: true, callsUserCode: true, diverges: true, allocation: 'maybe',
    why: 'walks the class hierarchy and may construct a base object',
  }),

  // -- allocation of literals, closures and contexts.
  //    These write nothing observable and cannot throw, so hasEffect is false,
  //    but every one of them hands out a brand new object, so they must never
  //    be copied to two use sites. That pair of flags is the whole point of
  //    8.4's last paragraph: it is what stops 50.27% of allocation expressions
  //    being duplicated (ARCHITECTURE.md 1.1).
  CreateObjectLiteral: alloc('a fresh JSObject from an ObjectBoilerplateDescription'),
  CreateEmptyObjectLiteral: alloc('a fresh {}'),
  CreateArrayLiteral: alloc('a fresh JSArray from an ArrayBoilerplateDescription'),
  CreateEmptyArrayLiteral: alloc('a fresh []'),
  CreateRegExpLiteral: alloc('a fresh JSRegExp; lastIndex is mutable so identity is observable'),
  CreateClosure: alloc('a fresh JSFunction capturing the current context'),
  CloneObject: userCall('object spread copies own enumerable properties, running getters, into a fresh object'),
  CreateArrayFromIterable: userCall('array spread drains an iterator into a fresh JSArray'),
  CreateMappedArguments: alloc('a fresh sloppy arguments object aliasing the parameters'),
  CreateUnmappedArguments: alloc('a fresh strict arguments object'),
  CreateRestParameter: alloc('a fresh JSArray of the trailing arguments'),
  CreateBlockContext: alloc('a fresh block Context whose previous link is the current context'),
  CreateCatchContext: alloc('a fresh catch Context holding the caught value'),
  CreateFunctionContext: alloc('a fresh function Context'),
  CreateFunctionContextWithCells: alloc('a fresh function Context with ContextCell slots'),
  CreateEvalContext: alloc('a fresh Context for a direct eval'),
  CreateWithContext: alloc('a fresh with Context around an object'),
  GetTemplateObject: E({
    allocation: 'cached',
    why: 'the template object is cached per call site: the spec requires the same object every evaluation, '
      + 'so duplicating the op is safe, but it is not a fresh allocation either',
  }),

  // -- iteration protocol
  ForInEnumerate: E({
    reads: ['heap', 'global', 'context', 'module'], writes: ['heap', 'global', 'context', 'module'],
    throws: true, callsUserCode: true, diverges: true, allocation: 'definite',
    why: 'collects enumerable keys; a proxy ownKeys trap can run; returns a fresh key array or a map',
  }),
  ForInPrepare: E({
    reads: ['heap'], allocation: 'definite',
    why: 'splits the enumeration result into cache_type / cache_array / cache_length',
  }),
  ForInNext: userCall('for-in step does a keyed load, which can run a getter', 'maybe'),
  ForInStep: pure('increments a Smi index register'),
  ForOfNext: userCall('calls the iterator next() method'),
  GetIterator: userCall('loads and calls obj[Symbol.iterator]'),

  // -- control flow. Jumps have no state effect; JumpLoop clobbers the
  //    accumulator because its interrupt check can tier up.
  Jump: pure('unconditional branch'),
  JumpConstant: pure('unconditional branch, delta in the constant pool'),
  JumpLoop: E({ why: 'backward branch; the interrupt / OSR check clobbers the accumulator but changes no JS state' }),
  JumpIfTrue: pure('branch on an already-boolean accumulator'),
  JumpIfFalse: pure('branch on an already-boolean accumulator'),
  JumpIfTrueConstant: pure('branch on an already-boolean accumulator'),
  JumpIfFalseConstant: pure('branch on an already-boolean accumulator'),
  JumpIfToBooleanTrue: pure('ToBoolean never calls user code'),
  JumpIfToBooleanFalse: pure('ToBoolean never calls user code'),
  JumpIfToBooleanTrueConstant: pure('ToBoolean never calls user code'),
  JumpIfToBooleanFalseConstant: pure('ToBoolean never calls user code'),
  JumpIfNull: pure('oddball identity test'),
  JumpIfNotNull: pure('oddball identity test'),
  JumpIfNullConstant: pure('oddball identity test'),
  JumpIfNotNullConstant: pure('oddball identity test'),
  JumpIfUndefined: pure('oddball identity test'),
  JumpIfNotUndefined: pure('oddball identity test'),
  JumpIfUndefinedConstant: pure('oddball identity test'),
  JumpIfNotUndefinedConstant: pure('oddball identity test'),
  JumpIfUndefinedOrNull: pure('oddball identity test'),
  JumpIfUndefinedOrNullConstant: pure('oddball identity test'),
  JumpIfJSReceiver: pure('instance-type test'),
  JumpIfJSReceiverConstant: pure('instance-type test'),
  JumpIfForInDone: pure('compares the for-in index against the cache length'),
  JumpIfForInDoneConstant: pure('compares the for-in index against the cache length'),
  SwitchOnSmiNoFeedback: pure('dispatches on a Smi accumulator through a constant-pool jump table'),

  // -- throw and the pending message
  Throw: E({ throws: true, diverges: true, why: 'raises the accumulator' }),
  ReThrow: E({ throws: true, diverges: true, why: 'rethrows without re-running the handler prediction' }),
  ThrowReferenceErrorIfHole: E({ throws: true, diverges: true, why: 'the TDZ check' }),
  ThrowSuperNotCalledIfHole: E({ throws: true, diverges: true, why: 'derived-constructor this check' }),
  ThrowSuperAlreadyCalledIfNotHole: E({ throws: true, diverges: true, why: 'double super() check' }),
  ThrowIfNotSuperConstructor: E({ throws: true, diverges: true, why: 'super() callee check' }),
  SetPendingMessage: E({
    reads: ['message'], writes: ['message'],
    why: 'swaps the isolate pending message with the accumulator; the finally desugaring saves and restores it',
  }),
  Return: E({ diverges: true, why: 'leaves the frame' }),
  Abort: E({ throws: true, diverges: true, why: 'emitted under --debug-code only; does not return' }),

  // -- generators and async
  SwitchOnGeneratorState: E({
    reads: ['generator'], writes: ['generator'],
    why: 'overwrites the generator state with kGeneratorExecuting and installs the generator context, '
      + 'then dispatches through a constant-pool jump table',
  }),
  SuspendGenerator: E({
    reads: ['heap'], writes: ['generator'], diverges: true,
    why: 'spills the live register file, the context and the state into the generator object and returns',
  }),
  ResumeGenerator: E({
    reads: ['generator'], writes: ['generator'],
    why: 'restores the spilled register file and yields [state, input] in the accumulator',
  }),

  // -- debugger and coverage
  Debugger: userCall('enters the debugger, which can run arbitrary code and rewrite the frame'),
  DebugBreak0: userCall('debugger breakpoint'),
  DebugBreak1: userCall('debugger breakpoint'),
  DebugBreak2: userCall('debugger breakpoint'),
  DebugBreak3: userCall('debugger breakpoint'),
  DebugBreak4: userCall('debugger breakpoint'),
  DebugBreak5: userCall('debugger breakpoint'),
  DebugBreak6: userCall('debugger breakpoint'),
  DebugBreakWide: userCall('debugger breakpoint'),
  DebugBreakExtraWide: userCall('debugger breakpoint'),
  IncBlockCounter: E({ reads: ['coverage'], writes: ['coverage'], why: 'bumps a block coverage counter' }),
});

/** The conservative row used for an opcode the table does not name. */
export const UNCLASSIFIED = E({
  reads: ['heap', 'global', 'context', 'module', 'message', 'generator', 'coverage', 'debugger'],
  writes: ['heap', 'global', 'context', 'module', 'message', 'generator', 'coverage', 'debugger'],
  throws: true, callsUserCode: true, diverges: true, allocation: 'maybe',
  why: 'not named in src/ir/opcode_effects.mjs EFFECTS; treated as fully effectful',
});

// ---------------------------------------------------------------------------
// implicit register traffic
// ---------------------------------------------------------------------------

/**
 * Handlers that call SetContext(), i.e. that redefine the frame's context
 * register without an output operand naming it.
 *
 *   PushContext              SetContext(accumulator), old context -> operand 0
 *   PopContext               SetContext(operand 0)
 *   SwitchOnGeneratorState   SetContext(generator.context) on a resume
 */
export const IMPLICIT_CONTEXT_WRITE = Object.freeze({
  PushContext: 'installs the accumulator as the current context',
  PopContext: 'reinstalls the context held in its register operand',
  SwitchOnGeneratorState: 'installs the resumed generator\'s own context',
});

/**
 * Handlers that consume the current context as a value: either they capture it
 * (a closure, a child context, a suspended generator) or they address slots in
 * it. These are the reads that make the context chain in src/ir/context.mjs
 * observable; the ambient "every IC needs a context" read is not recorded.
 */
export const IMPLICIT_CONTEXT_READ = Object.freeze({
  PushContext: 'saves the outgoing context into its register operand',
  LdaCurrentContextSlot: 'addresses a slot of the current context',
  LdaCurrentContextSlotNoCell: 'addresses a slot of the current context',
  LdaImmutableCurrentContextSlot: 'addresses a slot of the current context',
  StaCurrentContextSlot: 'addresses a slot of the current context',
  StaCurrentContextSlotNoCell: 'addresses a slot of the current context',
  CreateClosure: 'the new JSFunction captures the current context',
  CreateBlockContext: 'the new context\'s previous link is the current context',
  CreateFunctionContext: 'the new context\'s previous link is the current context',
  CreateFunctionContextWithCells: 'the new context\'s previous link is the current context',
  CreateEvalContext: 'the new context\'s previous link is the current context',
  CreateCatchContext: 'the new context\'s previous link is the current context',
  CreateWithContext: 'the new context\'s previous link is the current context',
  SuspendGenerator: 'spills the current context into the generator object',
  LdaModuleVariable: 'walks to the module context',
  StaModuleVariable: 'walks to the module context',
});

/**
 * Opcodes whose first operand is a register holding a Context rather than a
 * value: Lda/StaContextSlot's `<context>` operand, and the lookup variants
 * which take a name instead. Used by src/ir/context.mjs to decide what the
 * depth operand is counted from.
 */
export const CONTEXT_SLOT_OPS = Object.freeze({
  LdaContextSlot: { mode: 'load', base: 'operand', immutable: false, cell: true },
  LdaContextSlotNoCell: { mode: 'load', base: 'operand', immutable: false, cell: false },
  LdaImmutableContextSlot: { mode: 'load', base: 'operand', immutable: true, cell: true },
  LdaCurrentContextSlot: { mode: 'load', base: 'current', immutable: false, cell: true },
  LdaCurrentContextSlotNoCell: { mode: 'load', base: 'current', immutable: false, cell: false },
  LdaImmutableCurrentContextSlot: { mode: 'load', base: 'current', immutable: true, cell: true },
  StaContextSlot: { mode: 'store', base: 'operand', immutable: false, cell: true },
  StaContextSlotNoCell: { mode: 'store', base: 'operand', immutable: false, cell: false },
  StaCurrentContextSlot: { mode: 'store', base: 'current', immutable: false, cell: true },
  StaCurrentContextSlotNoCell: { mode: 'store', base: 'current', immutable: false, cell: false },
  // The Lookup* forms carry a kContextSlot operand too, but they fall back to
  // a dynamic scope walk, so the (depth, index) pair is a fast-path hint and
  // not the whole story. Recorded with base 'current' and flagged.
  LdaLookupContextSlot: { mode: 'load', base: 'current', immutable: false, cell: true, dynamicFallback: true },
  LdaLookupContextSlotNoCell: { mode: 'load', base: 'current', immutable: false, cell: false, dynamicFallback: true },
  LdaLookupContextSlotInsideTypeof: { mode: 'load', base: 'current', immutable: false, cell: true, dynamicFallback: true },
  LdaLookupContextSlotNoCellInsideTypeof: { mode: 'load', base: 'current', immutable: false, cell: false, dynamicFallback: true },
});

/**
 * Opcodes that create a Context whose ScopeInfo is named by a constant-pool
 * operand. The value flows to the accumulator and is normally installed by the
 * following PushContext.
 */
export const CONTEXT_CREATORS = Object.freeze({
  CreateBlockContext: { scopeInfoOperand: 0, chains: true },
  CreateCatchContext: { scopeInfoOperand: 1, chains: true },
  CreateFunctionContext: { scopeInfoOperand: 0, chains: true },
  CreateFunctionContextWithCells: { scopeInfoOperand: 0, chains: true },
  CreateEvalContext: { scopeInfoOperand: 0, chains: true },
  CreateWithContext: { scopeInfoOperand: 1, chains: true },
});

// ---------------------------------------------------------------------------
// per-profile derivation
// ---------------------------------------------------------------------------

const ACCUMULATOR_USE = Object.freeze({
  kNone: { read: false, write: false, clobber: false },
  kReadAccumulator: { read: true, write: false, clobber: false },
  kWriteAccumulator: { read: false, write: true, clobber: false },
  kReadWriteAccumulator: { read: true, write: true, clobber: false },
  kClobberAccumulator: { read: false, write: true, clobber: true },
  kReadAndClobberAccumulator: { read: true, write: true, clobber: true },
  // The short-star forms read the accumulator and write a register encoded in
  // the opcode. src/disasm rewrites them to Star, so this row exists only so
  // the derivation is total over the profile.
  kReadAccumulatorWriteShortStar: { read: true, write: false, clobber: false },
});

const cache = new WeakMap();

/**
 * Per-opcode facts for one profile: register read/write roles derived from
 * operand types, accumulator role derived from implicitRegisterUse, and the
 * declared effect row.
 *
 * @param {object} profile
 */
export function opcodeSemantics(profile) {
  let s = cache.get(profile);
  if (!s) { s = build(profile); cache.set(profile, s); }
  return s;
}

function build(profile) {
  const ops = profile.tables.operands;
  const inTypes = new Set(ops.registerInputOperandTypes);
  const outTypes = new Set(ops.registerOutputOperandTypes);
  const allReg = new Set(ops.registerOperandTypes);
  const problems = [];

  // A register operand type in neither list is an in-out type. V8 keeps those
  // in REGISTER_INPUT_OUTPUT_OPERAND_TYPE_LIST (src/interpreter/
  // bytecode-operands.h); cross-check the derivation against the name so a
  // renamed type cannot silently become write-only.
  const inOut = [...allReg].filter((t) => !inTypes.has(t) && !outTypes.has(t));
  for (const t of inOut) {
    if (!/InOut$/.test(t)) problems.push(`register operand type ${t} is in neither the input nor the output list and is not named *InOut`);
  }
  for (const t of allReg) {
    if (inTypes.has(t) && outTypes.has(t)) problems.push(`register operand type ${t} is in both the input and the output list`);
  }

  const reads = new Set([...inTypes, ...inOut]);
  const writes = new Set([...outTypes, ...inOut]);

  const unclassified = [];
  const byName = new Map();
  for (let v = 0; v < profile.opcodeCount; v++) {
    const op = profile.getOpcode(v);
    if (!op) continue;
    const acc = ACCUMULATOR_USE[op.implicitRegisterUse];
    if (!acc) { problems.push(`${op.name}: unknown implicitRegisterUse ${op.implicitRegisterUse}`); continue; }
    // StarN is normalised to Star upstream, so it is not required in EFFECTS.
    const isShortStar = op.implicitRegisterUse === 'kReadAccumulatorWriteShortStar';
    let effect = EFFECTS[op.name];
    if (!effect) {
      if (!isShortStar) unclassified.push(op.name);
      effect = isShortStar ? EFFECTS.Star : UNCLASSIFIED;
    }
    for (const k of [...effect.reads, ...effect.writes]) {
      if (!EFFECT_KINDS.includes(k)) problems.push(`${op.name}: unknown effect kind ${k}`);
    }
    if (!ALLOCATION_KINDS.includes(effect.allocation)) problems.push(`${op.name}: unknown allocation kind ${effect.allocation}`);

    const regRoles = op.operands.map((t) => ({
      type: t,
      reads: reads.has(t),
      writes: writes.has(t),
      isRegister: allReg.has(t),
    }));

    // 8.4's two required flags.
    //
    // hasEffect: the op writes observable state, can enter user code, or can
    //   throw. An op with hasEffect false may be reordered freely with respect
    //   to anything except a write to a kind it reads.
    // allocatesIdentity: copying this def to a second use site could produce
    //   two objects where the program had one. 'definite' and 'maybe' both
    //   count; 'cached' does not, because the cache guarantees one object.
    const hasEffect = effect.writes.length > 0 || effect.throws || effect.callsUserCode;
    const allocatesIdentity = effect.allocation === 'definite' || effect.allocation === 'maybe';
    const inEffectChain = hasEffect || effect.reads.length > 0;

    byName.set(op.name, Object.freeze({
      name: op.name,
      value: v,
      operands: Object.freeze(regRoles),
      accumulator: Object.freeze(acc),
      effect,
      hasEffect,
      allocatesIdentity,
      allocationKind: effect.allocation,
      inEffectChain,
      implicitContextWrite: IMPLICIT_CONTEXT_WRITE[op.name] ?? null,
      implicitContextRead: IMPLICIT_CONTEXT_READ[op.name] ?? null,
      contextSlot: CONTEXT_SLOT_OPS[op.name] ?? null,
      contextCreator: CONTEXT_CREATORS[op.name] ?? null,
      unclassified: !EFFECTS[op.name] && !isShortStar,
    }));
  }

  if (problems.length) {
    throw new Error(`profile ${profile.version}: cannot derive opcode semantics:\n  ${problems.join('\n  ')}`);
  }

  return {
    profile,
    registerReadTypes: reads,
    registerWriteTypes: writes,
    inOutTypes: inOut,
    unclassified,
    /** @returns {object} semantics for an opcode name; UNCLASSIFIED-backed if absent. */
    of(name) {
      const s = byName.get(name);
      if (s) return s;
      // A name src/disasm synthesised that the profile does not carry.
      return Object.freeze({
        name, value: null, operands: Object.freeze([]),
        accumulator: ACCUMULATOR_USE.kNone, effect: UNCLASSIFIED,
        hasEffect: true, allocatesIdentity: true, allocationKind: 'maybe', inEffectChain: true,
        implicitContextWrite: null, implicitContextRead: null,
        contextSlot: null, contextCreator: null, unclassified: true,
      });
    },
    names: [...byName.keys()],
  };
}

/** Which opcodes of a profile EFFECTS does not name. Used by the self-test. */
export function classifyProfile(profile) {
  return opcodeSemantics(profile).unclassified;
}

export default { opcodeSemantics, classifyProfile, EFFECTS, EFFECT_KINDS, UNCLASSIFIED };
