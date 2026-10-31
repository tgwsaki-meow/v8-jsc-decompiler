// optchain-mixed -- optional chain mixed with ?? and &&
// group=optional-chain script sloppy
function f(o) {
  return o?.a ?? "dflt";
}
function g(o) {
  return o?.a && o.a.b;
}
T('nullish', [f(null), f({}), f({ a: 0 })]); T('and', [g(null), g({ a: { b: 2 } })]);
