function f(a) {
  for (var v of a) { if (v > 1) break; }
  return v;
}
f([1, 2, 3]);
