// try-finally-only-fallthrough -- try/finally where the try completes normally
// group=try script sloppy
var log = [];
function f() {
  try {
    log.push("a");
  } finally {
    log.push("b");
  }
  log.push("c");
  return log.slice();
}
T('order', f());
