// try-catch-finally -- try/catch/finally, all three
// group=try script sloppy
var log = [];
function f(x) {
  try {
    log.push("t");
    if (x) throw new Error("e");
    return "ok";
  } catch (e) {
    log.push("c");
    return "caught";
  } finally {
    log.push("f");
  }
}
T('clean', f(0)); T('throw', f(1)); T('log', log.slice());
