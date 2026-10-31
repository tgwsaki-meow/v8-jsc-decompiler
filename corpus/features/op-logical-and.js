// op-logical-and -- logical AND && (short circuit)
// group=operator script sloppy
var log = [];
function side(v) {
  log.push(v);
  return v;
}
function f(a, b) {
  return side(a) && side(b);
}
T('short', f(0, 1)); T('long', f(1, 2)); T('order', log.slice());
