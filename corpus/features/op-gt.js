// op-gt -- binary > (greater than)
// group=operator script sloppy
function f(a, b) {
  return a > b;
}
T('num', f(1, 2)); T('str', f('b', 'a')); T('nan', f(NaN, 1));
