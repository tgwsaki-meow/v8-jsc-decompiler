// async-promise-combinators -- await on Promise.all / race / allSettled
// group=async script sloppy
async function f() {
  var all = await Promise.all([1, Promise.resolve(2)]);
  var race = await Promise.race([Promise.resolve("fast"), new Promise(function () {})]);
  var settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("r"))]);
  return [all, race, settled.map(function (s) { return s.status; })];
}
f().then(function (v) { T('combinators', v); });
