// flat-label-break -- labeled break across two top-level loops
// group=flat script sloppy
var hits = [];
outer: for (var i = 0; i < 4; i++) {
  for (var j = 0; j < 4; j++) {
    if (j === 2) continue outer;
    if (i === 3) break outer;
    hits.push(i * 10 + j);
  }
}
T('labels', hits);
