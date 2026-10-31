function* g(n) {
  var t = 0;
  yield 1;
  for (var i = 0; i < n; i++) { t += yield i; }
  try { yield 'in try'; } finally { yield 'in finally'; }
  return t;
}
var it = g(2); it.next(); it.next(); it.next();
