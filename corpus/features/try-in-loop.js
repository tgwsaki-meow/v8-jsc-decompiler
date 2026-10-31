// try-in-loop -- try inside a loop, catching per iteration
// group=try script sloppy
function f(vals) {
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    try {
      if (vals[i] < 0) throw new RangeError("neg");
      out.push(vals[i]);
    } catch (e) {
      out.push(e.constructor.name);
      continue;
    }
    out.push("ok");
  }
  return out;
}
T('mixed', f([1, -1, 2]));
