// op-shl -- binary << (left shift)
// group=operator script sloppy
function f(a, b) {
  return a << b;
}
T('num', f(1, 4)); T('wrap', f(1, 32)); T('neg', f(-1, 1));
