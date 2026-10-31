// optchain-call -- optional call
// group=optional-chain script sloppy
function f(o) {
  return o?.m?.(1);
}
function g(fn) {
  return fn?.(2);
}
T('present', f({ m: function (v) { return v + 1; } })); T('missing', f({})); T('null', f(null)); T('fn', g(null));
