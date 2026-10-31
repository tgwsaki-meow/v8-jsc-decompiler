function T(){}
// label-break -- labeled break out of one loop
// group=label script sloppy
function f(n) {
  var s = 0;
  outer: for (var i = 0; i < n; i++) {
    if (i === 3) break outer;
    s += i;
  }
  return s;
}
T('n9', f(9));
