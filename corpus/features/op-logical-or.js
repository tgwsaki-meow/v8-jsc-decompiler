// op-logical-or -- logical OR || (short circuit)
// group=operator script sloppy
var log = [];
function side(v) {
  log.push(v);
  return v;
}
function f(a, b) {
  return side(a) || side(b);
}
T('short', f(1, 2)); T('long', f(0, 3)); T('order', log.slice());
