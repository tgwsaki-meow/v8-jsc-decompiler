// try-catch-rethrow -- catch that rethrows
// group=try script sloppy
function f() {
  try {
    throw new TypeError("t");
  } catch (e) {
    if (e instanceof TypeError) throw e;
    return "no";
  }
}
function g() {
  try {
    f();
  } catch (e) {
    return [e.constructor.name, e.message];
  }
}
T('rethrow', g());
