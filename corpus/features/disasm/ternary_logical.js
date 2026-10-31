function f(a, b, c) {
  var x = a ? b : c;
  var y = a && b || c;
  var z = a ?? b;
  return x + y + z;
}
f(1, 2, 3);
