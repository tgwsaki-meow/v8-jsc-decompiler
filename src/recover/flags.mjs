// src/recover/flags.mjs
//
// The small enums a `kFlag8` operand encodes. These are NOT in
// profiles/<tag>/*.json -- `src/disasm` hands a kFlag8 through as a raw number
// and `src/listing` prints it in hex, exactly as V8's own BytecodeDecoder
// does. That is a SIXTH silent profilegen gap on top of ARCHITECTURE.md 9.6's
// four and docs/IR.md 10.7's fifth, and it is reported rather than papered
// over: see docs/RECOVER.md "Known gaps".
//
// Until profilegen exports them, they are declared here with their exact
// pinned-source origin, and `tools/recover/selftest.mjs` re-derives each one
// from that source file (which it may download, being under tools/) and fails
// if the declaration and the source disagree. So the table is checked against
// the version it claims to describe rather than trusted.
//
//   src/interpreter/bytecode-flags-and-tokens.h @ 14.4.258.16
//   sha256 887348609e244385be0001579fe6910f7221be5c6cf1a9eeafbe6d43783ab1c1
//
//     #define TYPEOF_LITERAL_LIST(V) \
//       V(Number, number) V(String, string) V(Symbol, symbol)
//       V(Boolean, boolean) V(BigInt, bigint) V(Undefined, undefined)
//       V(Function, function) V(Object, object) V(Other, other)
//     enum class LiteralFlag : uint8_t { k##name, ... };     // in list order
//
//     enum class TryFinallyContinuationToken : int {
//       kFallthroughToken = -1, kRethrowToken = 0 };
//
//   src/objects/js-generator.h @ 14.4.258.16
//     enum ResumeMode { kNext, kReturn, kThrow };

/** TestTypeOfFlags::LiteralFlag, in declaration order. */
export const TYPEOF_LITERALS = Object.freeze([
  'number', 'string', 'symbol', 'boolean', 'bigint', 'undefined', 'function',
  'object', 'other',
]);

/** The source text the self-test re-derives TYPEOF_LITERALS from. */
export const TYPEOF_SOURCE = Object.freeze({
  path: 'src/interpreter/bytecode-flags-and-tokens.h',
  macro: 'TYPEOF_LITERAL_LIST',
});

/**
 * JSGeneratorObject::ResumeMode.
 *
 * Four members, not three: the pinned header declares
 * `enum ResumeMode { kNext, kReturn, kThrow, kRethrow }`. The three-member
 * version is what BuildAwait's comment implies (it only compares against
 * kNext) and it is what this table said until the self-test re-derived it from
 * the source and disagreed -- which is the whole reason the check exists.
 */
export const RESUME_MODES = Object.freeze(['next', 'return', 'throw', 'rethrow']);
export const RESUME_MODE_SOURCE = Object.freeze({
  path: 'src/objects/js-generator.h',
  enumName: 'ResumeMode',
});

/** TryFinallyContinuationToken. */
export const FINALLY_TOKENS = Object.freeze({ fallthrough: -1, rethrow: 0 });

/**
 * `typeof x === '<flag>'` -- the string TestTypeOf compares against.
 * Returns null for an out-of-range flag, which is reported, never guessed.
 */
export function typeOfLiteral(flag) {
  return TYPEOF_LITERALS[flag] ?? null;
}

export function resumeModeName(v) {
  return RESUME_MODES[v] ?? null;
}

export default { TYPEOF_LITERALS, RESUME_MODES, FINALLY_TOKENS, typeOfLiteral, resumeModeName };
