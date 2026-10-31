// loop-for-await-of -- for await-of over an async iterable
// group=loop script sloppy
function mk(vals) {
  return {
    [Symbol.asyncIterator]: function () {
      var i = 0;
      return { next: function () { return Promise.resolve({ value: vals[i], done: i++ >= vals.length }); } };
    },
  };
}
async function f(vals) {
  var out = [];
  for await (const v of mk(vals)) {
    out.push(v);
  }
  return out;
}
f([1, 2, 3]).then(function (r) { T('forAwait', r); });
async function g() {
  var out = [];
  for await (const v of [Promise.resolve(1), 2]) {
    out.push(v);
  }
  return out;
}
g().then(function (r) { T('forAwaitSync', r); });
