function f(a) {
  var t = 0;
  for (var i = 0; i < 3; i++) {
    try {
      if (a === 1) return 'r';
      if (a === 2) break;
      if (a === 3) continue;
      if (a === 4) throw new Error('e');
      t += 1;
    } finally {
      t += 10;
    }
  }
  return t;
}
f(0);
