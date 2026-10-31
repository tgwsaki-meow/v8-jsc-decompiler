// async-await-chain -- several sequential awaits
// group=async script sloppy
async function f() {
  var a = await 1;
  var b = await (a + 1);
  var c = await Promise.resolve(b + 1);
  return [a, b, c];
}
f().then(function (v) { T('chain', v); });
