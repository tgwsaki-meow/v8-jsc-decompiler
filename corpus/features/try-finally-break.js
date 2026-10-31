// try-finally-break -- break inside finally, out of the enclosing loop
// group=try script sloppy  (token register + dispatch shape)
function f(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    try {
      out.push("t" + i);
      if (i === 1) continue;
      if (i === 2) return out;
    } finally {
      out.push("f" + i);
      if (i === 3) break;
    }
    out.push("tail" + i);
  }
  out.push("after");
  return out;
}
T('n2', f(2)); T('n3', f(3)); T('n6', f(6));
