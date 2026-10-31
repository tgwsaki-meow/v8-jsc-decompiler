// destr-assign-no-decl -- destructuring assignment without a declaration
// group=destructuring script sloppy  (the parenthesised object form is the one that needs an ExpressionStatement guard)
function f(o) {
  var a, b, c;
  ({ a, b } = o);
  [c] = o.arr;
  return [a, b, c];
}
function g(target, o) {
  ({ p: target.p } = o);
  return target;
}
T('plain', f({ a: 1, b: 2, arr: [3] })); T('member', g({}, { p: 7 }));
