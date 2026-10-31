// destr-defaults -- destructuring defaults (only for undefined)
// group=destructuring script sloppy
var log = [];
function d(v) {
  log.push(v);
  return v;
}
function f(o) {
  var { a = d("a"), b = d("b") } = o;
  var [x = d("x"), y = d("y")] = o.arr || [];
  return [a, b, x, y];
}
T('all', f({})); T('some', f({ a: 1, arr: [null] })); T('log', log.slice());
