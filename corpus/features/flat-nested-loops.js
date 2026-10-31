// flat-nested-loops -- nested loops with break and continue in top-level code
// group=flat script sloppy
var hits = [];
for (var i = 0; i < 3; i++) {
  for (var j = 0; j < 3; j++) {
    if (j === 2) break;
    if (i === 1) continue;
    hits.push(i + "," + j);
  }
}
T('nested', hits);
