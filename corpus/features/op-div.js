// op-div -- binary / (division)
// group=operator script sloppy
function f(a, b) {
  return a / b;
}
T('num', f(7, 2)); T('inf', f(1, 0)); T('negzero', f(-0, 5));
