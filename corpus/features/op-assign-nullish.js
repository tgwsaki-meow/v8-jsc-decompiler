// op-assign-nullish -- logical assignment ??=
// group=operator script sloppy  (short-circuits: the store only happens on one branch)
var log = [];
function f(a, b) {
  a ??= b;
  return a;
}
function g(o, b) {
  log.push("g");
  o.n ??= b;
  return o.n;
}
T('nullish', f(null, 2)); T('zero', f(0, 2)); T('prop', g({ n: undefined }, 7)); T('propSet', g({ n: 1 }, 7));
T('log', log.slice());
