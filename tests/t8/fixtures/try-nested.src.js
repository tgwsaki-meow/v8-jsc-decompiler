function T(){}
// try-nested -- nested try blocks, inner rethrow
// group=try script sloppy
var log = [];
function f(x) {
  try {
    try {
      throw new Error("inner");
    } catch (e) {
      log.push("inner-catch");
      if (x) throw e;
      return "swallowed";
    } finally {
      log.push("inner-finally");
    }
  } catch (e) {
    return "outer:" + e.message;
  } finally {
    log.push("outer-finally");
  }
}
T('rethrow', f(1)); T('swallow', f(0)); T('log', log.slice());
