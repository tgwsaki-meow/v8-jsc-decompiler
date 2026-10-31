// optchain-short-circuit -- optional chain short-circuits the whole chain
// group=optional-chain script sloppy
var log = [];
function side(v) {
  log.push(v);
  return v;
}
function f(o) {
  return o?.a[side("idx")].b(side("arg"));
}
T('nullish', f(null)); T('log', log.slice());
function g(o) {
  return (o?.a).b;
}
T('parenthesised', (function () { try { return g(null); } catch (e) { return e.constructor.name; } })());
