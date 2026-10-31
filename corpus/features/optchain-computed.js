// optchain-computed -- optional computed access
// group=optional-chain script sloppy
var log = [];
function k() {
  log.push("k");
  return "a";
}
function f(o) {
  return o?.[k()];
}
T('present', f({ a: 1 })); T('nullish', f(null)); T('log', log.slice());
