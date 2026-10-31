// async-try-finally -- await inside try/catch/finally
// group=async script sloppy
var log = [];
async function f(x) {
  try {
    log.push("t");
    if (x) throw new Error("e");
    return await Promise.resolve("ok");
  } catch (e) {
    return "caught:" + e.message;
  } finally {
    log.push(await Promise.resolve("f"));
  }
}
Promise.all([f(0), f(1)]).then(function (v) { T('asyncTry', v); T('log', log.slice()); });
