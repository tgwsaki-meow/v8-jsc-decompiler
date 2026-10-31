// arr-trailing-comma -- trailing commas in literals, params and calls
// group=literal script sloppy
function f(a, b,) {
  return [a, b];
}
var o = { a: 1, };
var arr = [1, 2,];
T('trailing', [f(1, 2,), Object.keys(o), arr.length]);
