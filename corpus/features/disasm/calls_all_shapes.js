function g(a, b, c) { return a + b + c; }
function f(o) {
  return g(1, 2, 3) + o.m(1, 2) + o['m'](1) + new o.C(1, 2, 3).v + (0, o.m)(1) + g.call(null, 1, 2, 3) + g.apply(null, [1, 2, 3]);
}
f({m: function () { return 1; }, C: function (a) { this.v = a; }});
