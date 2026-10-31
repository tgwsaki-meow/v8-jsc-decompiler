// op-pos -- unary +
// group=operator script sloppy
function f(a) {
  return +a;
}
T('str', f('5')); T('bool', f(true)); T('nan', f({}));
