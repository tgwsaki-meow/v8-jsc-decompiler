// async-function -- async function and await
// group=async script sloppy
async function f(a) {
  var b = await a;
  return b + 1;
}
f(1).then(function (v) { T('awaitValue', v); });
f(Promise.resolve(10)).then(function (v) { T('awaitPromise', v); });
