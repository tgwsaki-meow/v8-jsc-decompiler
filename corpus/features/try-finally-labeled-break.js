// try-finally-labeled-break -- labeled break out of finally across two loops
// group=try script sloppy  (the token register has to carry which labelled target to resume)
function f() {
  var out = [];
  outer: for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      try {
        out.push(i + "," + j);
        if (j === 1) continue outer;
      } finally {
        out.push("f" + i + j);
        if (i === 2) break outer;
      }
    }
  }
  out.push("done");
  return out;
}
T('labels', f());
