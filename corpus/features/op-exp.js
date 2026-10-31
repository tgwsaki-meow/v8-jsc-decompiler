// op-exp -- binary ** (exponentiation)
// group=operator script sloppy
function f(a, b) {
  return a ** b;
}
T('num', f(2, 10)); T('frac', f(4, 0.5)); T('neg', f(2, -1));
