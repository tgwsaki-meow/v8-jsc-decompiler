// flat-try-in-loop -- try/catch inside a top-level loop, with continue in the catch
// group=flat script sloppy
var out = [];
for (var i = 0; i < 4; i++) {
  try {
    if (i % 2) throw new RangeError("odd");
    out.push(i);
  } catch (e) {
    out.push(e.constructor.name);
    continue;
  }
  out.push("ok");
}
T('tryLoop', out);
