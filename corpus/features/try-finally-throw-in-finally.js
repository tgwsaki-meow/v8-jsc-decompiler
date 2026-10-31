// try-finally-throw-in-finally -- finally that throws, replacing the pending exception
// group=try script sloppy
function f(x) {
  try {
    throw new Error("first");
  } finally {
    if (x) throw new Error("second");
  }
}
function g(x) {
  try {
    return f(x);
  } catch (e) {
    return e.message;
  }
}
T('replaced', g(1)); T('original', g(0));
