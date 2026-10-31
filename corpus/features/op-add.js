// op-add -- binary + (addition)
// group=operator script sloppy
function f(a, b) {
  return a + b;
}
T('num', f(7, 3)); T('str', f('7', 3)); T('obj', f([1], 2));
