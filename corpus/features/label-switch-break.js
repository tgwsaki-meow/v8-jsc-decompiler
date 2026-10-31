// label-switch-break -- labeled break out of a switch inside a loop
// group=label script sloppy
function f(vals) {
  var out = [];
  outer: for (var i = 0; i < vals.length; i++) {
    switch (vals[i]) {
      case 1: out.push("one"); break;
      case 2: continue outer;
      case 3: break outer;
      default: out.push("other");
    }
    out.push("tail" + i);
  }
  return out;
}
T('mix', f([1, 2, 9, 3, 1]));
