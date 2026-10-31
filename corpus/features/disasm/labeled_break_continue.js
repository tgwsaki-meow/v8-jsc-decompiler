function f(n) {
  var t = 0;
  outer:
  for (var i = 0; i < n; i++) {
    inner:
    for (var j = 0; j < n; j++) {
      if (j === 1) continue inner;
      if (j === 3) continue outer;
      if (i === 4) break outer;
      if (j === 5) break inner;
      t += i * j;
    }
  }
  return t;
}
f(6);
