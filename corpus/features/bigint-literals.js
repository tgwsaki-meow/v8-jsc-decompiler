// bigint-literals -- BigInt literals and operators
// group=numeric script sloppy
function f(a, b) {
  return [a + b, a * b, a / b, a % b, a ** 2n, -a, a & b, a | b, a ^ b, ~a, a << 1n, a >> 1n];
}
T('ops', f(10n, 3n).map(String)); T('literals', [0n, 1n, 0x10n, 0b11n, 0o17n, 1_000n].map(String));
T('typeof', typeof 1n); T('mix', (function () { try { return 1n + 1; } catch (e) { return e.constructor.name; } })());
