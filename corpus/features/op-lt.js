// op-lt -- binary < (less than)
// group=operator script sloppy
function f(a, b) {
  return a < b;
}
T('num', f(1, 2)); T('str', f('b', 'a')); T('mixed', f('10', 9));
