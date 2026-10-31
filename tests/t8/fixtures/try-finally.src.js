function T(){}
// try-finally -- try/finally with no catch
// group=try script sloppy
var log = [];
function f(x) {
  try {
    log.push("try");
    if (x) throw new Error("boom");
    return "ok";
  } finally {
    log.push("finally");
  }
}
function g(x) {
  try {
    return f(x);
  } catch (e) {
    return "outer:" + e.message;
  }
}
T('clean', g(0)); T('throw', g(1)); T('log', log.slice());
