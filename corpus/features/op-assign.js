// op-assign -- simple assignment =
// group=operator script sloppy
function f(o) {
  var x = 1;
  x = 2;
  o.p = 3;
  o['q'] = 4;
  return [x, o.p, o.q];
}
T('assign', f({}));
