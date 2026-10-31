function f(n) {
  var t = 0;
  do { t += n; n--; } while (n > 0);
  return t;
}
f(3);
