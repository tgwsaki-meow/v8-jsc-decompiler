// op-bit-or -- binary | (bitwise OR)
// group=operator script sloppy
function f(a, b) {
  return a | b;
}
T('num', f(12, 10)); T('neg', f(-2, 1)); T('trunc', f(1.9, 0));
