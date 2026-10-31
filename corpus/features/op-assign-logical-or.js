// op-assign-logical-or -- logical assignment ||=
// group=operator script sloppy  (short-circuits: the store only happens on one branch)
var log = [];
function f(a, b) {
  a ||= b;
  return a;
}
function g(o, b) {
  log.push("g");
  o.n ||= b;
  return o.n;
}
T('truthy', f(1, 2)); T('falsy', f(0, 2)); T('prop', g({ n: 0 }, 7)); T('propTruthy', g({ n: 5 }, 7));
T('log', log.slice());
