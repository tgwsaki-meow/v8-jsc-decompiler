function f(o) {
  var t = '';
  for (var k in o) { t += k; }
  return t;
}
f({a: 1, b: 2});
