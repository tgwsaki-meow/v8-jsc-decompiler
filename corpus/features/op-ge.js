// op-ge -- binary >= (greater than or equal)
// group=operator script sloppy
function f(a, b) {
  return a >= b;
}
T('eq', f(2, 2)); T('gt', f(3, 2)); T('str', f('a', 'b'));
