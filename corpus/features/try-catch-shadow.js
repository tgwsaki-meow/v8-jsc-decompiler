// try-catch-shadow -- catch parameter shadowing an outer binding
// group=try script sloppy
function f() {
  var e = "outer";
  var seen = [];
  try {
    throw "inner";
  } catch (e) {
    seen.push(e);
  }
  seen.push(e);
  return seen;
}
T('shadow', f());
