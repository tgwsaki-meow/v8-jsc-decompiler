// op-mul -- binary * (multiplication)
// group=operator script sloppy
function f(a, b) {
  return a * b;
}
T('num', f(7, 3)); T('zero', f(0, -1)); T('str', f('4', 2));
