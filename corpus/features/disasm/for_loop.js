function f(n) {
  var t = 0;
  for (var i = 0; i < n; i++) { if (i === 2) continue; if (i === 7) break; t += i; }
  return t;
}
f(10);
