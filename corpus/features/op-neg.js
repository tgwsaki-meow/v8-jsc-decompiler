// op-neg -- unary -
// group=operator script sloppy
function f(a) {
  return -a;
}
T('num', f(5)); T('str', f('5')); T('nan', f('x'));
