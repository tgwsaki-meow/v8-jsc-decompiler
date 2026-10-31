// try-finally-continue -- continue inside finally
// group=try script sloppy  (token register + dispatch shape)
function f(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    try {
      if (i % 2) throw new Error("odd" + i);
      out.push("even" + i);
    } catch (e) {
      out.push("caught" + i);
    } finally {
      if (i === 2) continue;
      out.push("fin" + i);
    }
    out.push("tail" + i);
  }
  return out;
}
T('n5', f(5));
