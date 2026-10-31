// async-rejection -- awaiting a rejected promise
// group=async script sloppy
async function f() {
  try {
    await Promise.reject(new Error("nope"));
    return "no throw";
  } catch (e) {
    return e.message;
  }
}
f().then(function (v) { T('rejected', v); });
async function g() {
  throw new Error("thrown");
}
g().catch(function (e) { T('asyncThrow', e.message); });
