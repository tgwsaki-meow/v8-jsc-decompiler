function f(k, v) {
  var o = {a: 1, b: 'two', 3: true, [k]: v, get g() { return 1; }, set g(x) {}, m() { return 2; }, __proto__: null};
  var a = [1, 2, , 4, 'five', [6, [7]], {n: 8}];
  return o.a + a.length;
}
f('k', 1);
