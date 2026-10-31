// decl-let-per-iteration -- per-iteration let binding captured by closures
// group=declaration script sloppy
function f() {
  var fns = [];
  for (let i = 0; i < 3; i++) {
    fns.push(function () { return i; });
  }
  return fns.map(function (g) { return g(); });
}
function g() {
  var fns = [];
  for (var i = 0; i < 3; i++) {
    fns.push(function () { return i; });
  }
  return fns.map(function (h) { return h(); });
}
T('let', f()); T('var', g());
