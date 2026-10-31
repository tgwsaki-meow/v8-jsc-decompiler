// op-shr -- binary >> (signed right shift)
// group=operator script sloppy
function f(a, b) {
  return a >> b;
}
T('num', f(-16, 2)); T('pos', f(16, 2)); T('wrap', f(1, 33));
