// op-le -- binary <= (less than or equal)
// group=operator script sloppy
function f(a, b) {
  return a <= b;
}
T('eq', f(2, 2)); T('lt', f(1, 2)); T('nan', f(NaN, NaN));
