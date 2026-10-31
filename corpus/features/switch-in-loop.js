// switch-in-loop -- switch inside a loop with break and continue
// group=switch script sloppy
function f(vals) {
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    switch (vals[i] % 3) {
      case 0:
        out.push("z" + i);
        break;
      case 1:
        continue;
      default:
        out.push("d" + i);
    }
    out.push("end" + i);
  }
  return out;
}
T('seq', f([0, 1, 2, 3, 4]));
