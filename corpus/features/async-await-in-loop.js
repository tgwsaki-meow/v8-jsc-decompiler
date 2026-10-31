// async-await-in-loop -- await inside a loop body
// group=async script sloppy
async function f(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push(await Promise.resolve(i));
  }
  var j = 0;
  while (j < 2) {
    await null;
    j++;
  }
  return [out, j];
}
f(3).then(function (v) { T('awaitLoop', v); });
