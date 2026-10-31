// op-comma -- comma operator
// group=operator script sloppy
var log = [];
function side(v) {
  log.push(v);
  return v;
}
function f() {
  return (side(1), side(2), side(3));
}
T('value', f()); T('order', log.slice());
