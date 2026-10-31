// op-dec-pre -- --x (prefix decrement)
// group=operator script sloppy
function f(start) {
  var x = start;
  var v = --x;
  return [v, x];
}
function g(o) {
  var v = --o.n;
  return [v, o.n];
}
T('local', f(5)); T('str', f('5')); T('prop', g({ n: 1 }));
