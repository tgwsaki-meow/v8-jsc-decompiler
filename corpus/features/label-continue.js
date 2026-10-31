// label-continue -- labeled continue
// group=label script sloppy
function f(n) {
  var s = 0;
  loop: for (var i = 0; i < n; i++) {
    if (i % 2) continue loop;
    s += i;
  }
  return s;
}
T('n7', f(7));
