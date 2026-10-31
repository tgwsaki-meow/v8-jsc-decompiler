// op-ushr -- binary >>> (unsigned right shift)
// group=operator script sloppy
function f(a, b) {
  return a >>> b;
}
T('neg', f(-16, 2)); T('pos', f(16, 2)); T('zero', f(-1, 0));
