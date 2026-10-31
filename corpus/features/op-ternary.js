// op-ternary -- conditional ?:
// group=operator script sloppy
function f(a) {
  return a ? 1 : 2;
}
function g(a) {
  return a ? a > 1 ? 3 : 4 : 5;
}
T('t', f(true)); T('f', f(0)); T('nested', [g(0), g(1), g(2)]);
