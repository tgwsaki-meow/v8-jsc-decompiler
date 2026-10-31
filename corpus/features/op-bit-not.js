// op-bit-not -- bitwise NOT ~
// group=operator script sloppy
function f(a) {
  return ~a;
}
T('num', f(5)); T('neg', f(-1)); T('trunc', f(2.9));
