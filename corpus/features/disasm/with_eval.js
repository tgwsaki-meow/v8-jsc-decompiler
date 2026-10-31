function f(o, s) {
  var r = 0;
  with (o) { r = a + b; }
  r += eval(s);
  return r;
}
f({a: 1, b: 2}, '1+1');
