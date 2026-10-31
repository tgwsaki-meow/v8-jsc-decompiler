function T(){}
// label-break-multi -- labeled break across two loop levels
// group=label script sloppy
function f(n) {
  var hits = [];
  outer: for (var i = 0; i < n; i++) {
    inner: for (var j = 0; j < n; j++) {
      if (j === 2) continue outer;
      if (i === 2) break outer;
      hits.push(i + "," + j);
    }
  }
  return hits;
}
T('n4', f(4));
