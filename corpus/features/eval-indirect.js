// eval-indirect -- indirect eval runs in global scope
// group=dynamic-scope script sloppy
var g = eval;
function f() {
  var local = 1;
  try {
    return g("typeof local");
  } catch (e) {
    return e.constructor.name;
  }
}
T('indirect', f()); T('alias', (0, eval)('1 + 1'));
