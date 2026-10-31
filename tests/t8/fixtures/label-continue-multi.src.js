function T(){}
// label-continue-multi -- labeled continue across three loop levels
// group=label script sloppy
function f() {
  var hits = [];
  a: for (var i = 0; i < 3; i++) {
    b: for (var j = 0; j < 3; j++) {
      c: for (var k = 0; k < 3; k++) {
        if (k === 1) continue b;
        if (j === 2) continue a;
        hits.push([i, j, k].join(""));
      }
    }
  }
  return hits;
}
T('three', f());
