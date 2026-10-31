function f(a) {
  try { if (a) throw new Error('x'); return 1; }
  catch (e) { return e.message; }
}
f(1);
