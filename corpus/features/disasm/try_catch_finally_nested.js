function f(a) {
  try {
    try { throw new Error('inner'); }
    catch (e) { if (a) throw e; return 'caught'; }
    finally { a = a + 1; }
  } catch (e2) { return 'outer:' + e2.message; }
  finally { a = a + 2; }
}
f(1);
