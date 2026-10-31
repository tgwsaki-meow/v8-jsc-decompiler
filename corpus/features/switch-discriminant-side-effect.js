// switch-discriminant-side-effect -- switch whose discriminant and cases have side effects
// group=switch script sloppy
var log = [];
function k(v) {
  log.push("k" + v);
  return v;
}
function f(x) {
  switch (k(x)) {
    case k(1): return "one";
    case k(2): return "two";
    default: return "def";
  }
}
T('two', f(2)); T('log', log.slice());
