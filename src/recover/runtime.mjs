// src/recover/runtime.mjs
//
// `CallRuntime` / `CallRuntimeForPair` / `InvokeIntrinsic` / `CallJSRuntime`.
//
// The table below is the CLOSED set of runtime functions
// `BytecodeGenerator` can emit -- every `Runtime::k<Name>` mentioned anywhere
// in src/interpreter/bytecode-generator.cc at the pinned tag, 63 of them. That
// is what makes this a transcription rather than a guess: a runtime id outside
// this set cannot have come from the generator, so it is reported as a hole
// instead of being given a plausible shape.
//
// `InvokeIntrinsic` and `CallRuntime` are the same table: the generator writes
// `Runtime::kInlineFoo` and the builder picks the bytecode, so the id arrives
// as the intrinsic `Foo` on one and the runtime `Foo` on the other.
// (src/interpreter/interpreter-intrinsics.h is the kInline* list.)
//
// `role` says what the recovery does with the call:
//   'expr'      a value expression
//   'stmt'      a statement
//   'skip'      desugaring plumbing with no source form
//   'inter'     an intermediate form a pattern consumes; verify.mjs turns a
//               surviving one into a counted hole

const T = (role, make, note) => Object.freeze({ role, make, note: note ?? null });

/** `args` is the flat list of argument SSA values, `E` the expr resolver. */
export const RUNTIME = Object.freeze({
  // ---- async / generator desugaring (BuildAwait, VisitYield, BuildAsyncReturn,
  //      BuildGeneratorObjectVariableInitialization, GenerateAsyncFunctionBody)
  AsyncFunctionEnter: T('inter', (a, E) => ({ e: 'generatorObject', from: 'asyncFunctionEnter' })),
  CreateJSGeneratorObject: T('inter', () => ({ e: 'generatorObject', from: 'createJSGeneratorObject' })),
  AsyncFunctionAwait: T('inter', (a, E) => ({ e: 'awaitOperand', arg: E(a[1]) })),
  AsyncGeneratorAwait: T('inter', (a, E) => ({ e: 'awaitOperand', arg: E(a[1]) })),
  AsyncGeneratorYieldWithAwait: T('inter', (a, E) => ({ e: 'yieldOperand', arg: E(a[1]), await: true })),
  CreateIterResultObject: T('inter', (a, E) => ({ e: 'iterResult', value: E(a[0]), done: E(a[1]) })),
  AsyncFunctionResolve: T('inter', (a, E) => ({ e: 'asyncResolve', value: E(a[1]) })),
  AsyncGeneratorResolve: T('inter', (a, E) => ({ e: 'asyncResolve', value: E(a[1]), done: E(a[2]) })),
  AsyncFunctionReject: T('inter', (a, E) => ({ e: 'asyncReject', value: E(a[1]) })),
  AsyncGeneratorReject: T('inter', (a, E) => ({ e: 'asyncReject', value: E(a[1]) })),
  GeneratorGetResumeMode: T('inter', () => ({ e: 'resumeMode' })),
  GeneratorClose: T('skip', null, 'generator finally'),
  CreateAsyncFromSyncIterator: T('inter', (a, E) => ({ e: 'asyncIterator', sync: E(a[0]) })),

  // ---- object spread / rest (VisitObjectLiteral, BuildDestructuringObjectAssignment)
  CopyDataProperties: T('inter', (a, E) => ({ e: 'copyDataProperties', target: E(a[0]), source: E(a[1]) })),
  CopyDataPropertiesWithExcludedPropertiesOnStack:
    T('inter', (a, E) => ({ e: 'copyDataProperties', source: E(a[0]), excludedCount: a.length - 1, excluded: a.slice(1).map(E) })),

  // ---- classes (BuildClassLiteral)
  DefineClass: T('inter', (a, E) => ({ e: 'defineClass', args: a.map(E) })),
  InternalSetPrototype: T('stmt', (a, E) => ({
    s: 'expr',
    expr: {
      e: 'call', optional: false,
      callee: { e: 'member', obj: { e: 'name', name: 'Object', ref: { k: 'global' } }, prop: 'setPrototypeOf', computed: false, optional: false },
      args: [E(a[0]), E(a[1])],
    },
  }), '__proto__: in an object literal, or a class heritage'),
  SetFunctionName: T('skip', null, 'the name an anonymous function literal infers'),
  DefineGetterPropertyUnchecked: T('inter', (a, E) => ({ e: 'accessor', kind: 'get', obj: E(a[0]), key: E(a[1]), fn: E(a[2]) })),
  DefineSetterPropertyUnchecked: T('inter', (a, E) => ({ e: 'accessor', kind: 'set', obj: E(a[0]), key: E(a[1]), fn: E(a[2]) })),
  DefineAccessorPropertyUnchecked: T('inter', (a, E) => ({ e: 'accessor', kind: 'both', obj: E(a[0]), key: E(a[1]), get: E(a[2]), set: E(a[3]) })),

  // ---- private names and brands (BuildClassLiteral, BuildPrivateBrandCheck)
  CreatePrivateNameSymbol: T('inter', (a, E) => ({ e: 'privateName', name: E(a[0]) })),
  CreatePrivateBrandSymbol: T('inter', (a, E) => ({ e: 'privateBrand', name: E(a[0]) })),
  CreatePrivateAccessors: T('inter', (a, E) => ({ e: 'privateAccessors', get: E(a[0]), set: E(a[1]) })),
  AddPrivateBrand: T('skip', null, 'BuildPrivateBrandInitialization'),
  GetPrivateMember: T('expr', (a, E) => ({ e: 'member', obj: E(a[0]), prop: E(a[1]), computed: true, optional: false, private: true })),
  SetPrivateMember: T('stmt', (a, E) => ({
    s: 'expr',
    expr: { e: 'assign', op: '=', target: { e: 'member', obj: E(a[0]), prop: E(a[1]), computed: true, optional: false, private: true }, value: E(a[2]) },
  })),
  LoadPrivateGetter: T('expr', (a, E) => ({ e: 'member', obj: E(a[0]), prop: 'get', computed: false, optional: false, private: true })),
  LoadPrivateSetter: T('expr', (a, E) => ({ e: 'member', obj: E(a[0]), prop: 'set', computed: false, optional: false, private: true })),

  // ---- super (VisitNamedSuperPropertyLoad / VisitKeyedSuperPropertyLoad /
  //      VisitCountOperation's NAMED_SUPER_PROPERTY)
  LoadFromSuper: T('expr', (a, E, cx) => ({
    e: 'member', obj: { e: 'super' }, prop: cx.stringOf(a[2]) ?? E(a[2]),
    computed: cx.stringOf(a[2]) === null, optional: false,
  })),
  LoadKeyedFromSuper: T('expr', (a, E) => ({ e: 'member', obj: { e: 'super' }, prop: E(a[2]), computed: true, optional: false })),
  StoreToSuper: T('stmt', (a, E, cx) => ({
    s: 'expr',
    expr: {
      e: 'assign', op: '=', value: E(a[3]),
      target: { e: 'member', obj: { e: 'super' }, prop: cx.stringOf(a[2]) ?? E(a[2]), computed: cx.stringOf(a[2]) === null, optional: false },
    },
  })),
  StoreKeyedToSuper: T('stmt', (a, E) => ({
    s: 'expr',
    expr: {
      e: 'assign', op: '=', value: E(a[3]),
      target: { e: 'member', obj: { e: 'super' }, prop: E(a[2]), computed: true, optional: false },
    },
  })),

  // ---- declarations in the prologue (VisitGlobalDeclarations / VisitDeclarations)
  DeclareGlobals: T('skip', null, 'the script-level var/function declaration pass'),
  DeclareEvalVar: T('skip', null, 'a var declared inside a direct eval'),
  DeclareEvalFunction: T('skip', null, 'a function declared inside a direct eval'),
  DeclareModuleExports: T('skip', null, 'VisitModuleDeclarations'),
  NewFunctionContext: T('skip', null, 'a context built through the runtime'),

  // ---- lookup-slot forms (sloppy direct eval, `with`)
  LoadLookupSlotForCall: T('expr', (a, E, cx) => {
    const n = cx.stringOf(a[0]);
    return n === null
      ? { e: 'hole', why: 'lookupSlotForCallNameUnknown', detail: null, dump: null }
      : { e: 'name', name: n, ref: { k: 'global', viaLookup: true } };
  }),
  DeleteLookupSlot: T('expr', (a, E, cx) => {
    const n = cx.stringOf(a[0]);
    return n === null
      ? { e: 'hole', why: 'deleteLookupSlotNameUnknown', detail: null, dump: null }
      : { e: 'unary', op: 'delete', arg: { e: 'name', name: n, ref: { k: 'global', viaLookup: true } } };
  }),
  ResolvePossiblyDirectEval: T('inter', (a, E) => ({ e: 'directEval', args: a.map(E) })),
  StoreGlobalNoHoleCheckForReplLetOrConst: T('stmt', (a, E, cx) => {
    const n = cx.stringOf(a[0]);
    return {
      s: 'expr',
      expr: {
        e: 'assign', op: '=', value: E(a[1]),
        target: n === null
          ? { e: 'hole', why: 'replStoreNameUnknown', detail: null, dump: null }
          : { e: 'name', name: n, ref: { k: 'global' } },
      },
    };
  }),

  // ---- modules
  GetModuleNamespace: T('inter', (a, E) => ({ e: 'moduleNamespace', index: a.length ? E(a[0]) : null })),
  DynamicImportCall: T('inter', (a, E) => ({ e: 'importCall', source: E(a[1]), options: a[2] !== undefined ? E(a[2]) : null })),

  // ---- the throw helpers. Each IS a throw in the source's control flow; what
  //      cannot be recovered is the exact error object, so the argument is an
  //      honest, counted hole rather than an invented `new TypeError(...)`.
  ThrowConstAssignError: T('stmt', () => throwHelper('ThrowConstAssignError')),
  ThrowStaticPrototypeError: T('stmt', () => throwHelper('ThrowStaticPrototypeError')),
  ThrowSymbolAsyncIteratorInvalid: T('stmt', () => throwHelper('ThrowSymbolAsyncIteratorInvalid')),
  ThrowThrowMethodMissing: T('stmt', () => throwHelper('ThrowThrowMethodMissing')),
  ThrowUnsupportedSuperError: T('stmt', () => throwHelper('ThrowUnsupportedSuperError')),
  ThrowUsingAssignError: T('stmt', () => throwHelper('ThrowUsingAssignError')),
  ThrowAwaitUsingAssignError: T('stmt', () => throwHelper('ThrowAwaitUsingAssignError')),
  // these two are guards inside a desugaring, not source statements
  ThrowIteratorResultNotAnObject: T('skip', null, 'BuildIteratorNext\'s result check'),
  ThrowPatternAssignmentNonCoercible: T('skip', null, 'BuildDestructuring*Assignment\'s null check'),

  NewError: T('inter', (a, E) => ({ e: 'newError', args: a.map(E) })),
  NewTypeError: T('inter', (a, E) => ({ e: 'newError', kind: 'TypeError', args: a.map(E) })),

  // ---- `using` / `await using` (BuildDisposeScope). Rare; shape-confidence.
  InitializeDisposableStack: T('inter', () => ({ e: 'disposableStack' })),
  AddDisposableValue: T('inter', (a, E) => ({ e: 'addDisposable', stack: E(a[0]), value: E(a[1]) })),
  AddAsyncDisposableValue: T('inter', (a, E) => ({ e: 'addDisposable', stack: E(a[0]), value: E(a[1]), async: true })),
  DisposeDisposableStack: T('skip', null, 'BuildDisposeScope'),
  HandleExceptionsInDisposeDisposableStack: T('skip', null, 'BuildDisposeScope'),

  // ---- only emitted under --trace
  TraceEnter: T('skip', null, 'v8_flags.trace'),
  TraceExit: T('skip', null, 'v8_flags.trace'),
});

function throwHelper(name) {
  return {
    s: 'throw',
    arg: { e: 'hole', why: 'runtimeThrowHelper', detail: name, dump: null },
    helper: name,
  };
}

/** Every name the table knows, for the self-test's totality check. */
export const RUNTIME_NAMES = Object.freeze(Object.keys(RUNTIME));

/**
 * The 63 `Runtime::k*` names that appear in bytecode-generator.cc at the
 * pinned tag, with the `kInline` prefix stripped (the builder turns
 * `kInlineFoo` into `InvokeIntrinsic Foo`). tools/recover/selftest.mjs
 * re-derives this list from the pinned source and asserts the table covers it.
 */
export const GENERATOR_EMITTED = Object.freeze([
  'AddAsyncDisposableValue', 'AddDisposableValue', 'AddPrivateBrand',
  'AsyncFunctionAwait', 'AsyncFunctionEnter', 'AsyncFunctionReject',
  'AsyncFunctionResolve', 'AsyncGeneratorAwait', 'AsyncGeneratorReject',
  'AsyncGeneratorResolve', 'AsyncGeneratorYieldWithAwait', 'CopyDataProperties',
  'CopyDataPropertiesWithExcludedPropertiesOnStack', 'CreateAsyncFromSyncIterator',
  'CreateIterResultObject', 'CreateJSGeneratorObject', 'CreatePrivateAccessors',
  'CreatePrivateBrandSymbol', 'CreatePrivateNameSymbol', 'DeclareEvalFunction',
  'DeclareEvalVar', 'DeclareGlobals', 'DeclareModuleExports',
  'DefineAccessorPropertyUnchecked', 'DefineClass', 'DefineGetterPropertyUnchecked',
  'DefineSetterPropertyUnchecked', 'DeleteLookupSlot', 'DisposeDisposableStack',
  'DynamicImportCall', 'GeneratorClose', 'GeneratorGetResumeMode',
  'GetModuleNamespace', 'GetPrivateMember',
  'HandleExceptionsInDisposeDisposableStack', 'InitializeDisposableStack',
  'InternalSetPrototype', 'LoadFromSuper', 'LoadKeyedFromSuper',
  'LoadLookupSlotForCall', 'LoadPrivateGetter', 'LoadPrivateSetter', 'NewError',
  'NewFunctionContext', 'NewTypeError', 'ResolvePossiblyDirectEval',
  'SetFunctionName', 'SetPrivateMember', 'StoreGlobalNoHoleCheckForReplLetOrConst',
  'StoreKeyedToSuper', 'StoreToSuper', 'ThrowAwaitUsingAssignError',
  'ThrowConstAssignError', 'ThrowIteratorResultNotAnObject',
  'ThrowPatternAssignmentNonCoercible', 'ThrowStaticPrototypeError',
  'ThrowSymbolAsyncIteratorInvalid', 'ThrowThrowMethodMissing',
  'ThrowUnsupportedSuperError', 'ThrowUsingAssignError', 'TraceEnter', 'TraceExit',
]);

export default { RUNTIME, RUNTIME_NAMES, GENERATOR_EMITTED };
