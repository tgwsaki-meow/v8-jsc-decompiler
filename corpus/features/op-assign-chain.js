// op-assign-chain -- chained assignment a = b = c
// group=operator script sloppy
function f(o) {
  var a, b;
  a = b = o.p = 7;
  return [a, b, o.p];
}
T('chain', f({}));
