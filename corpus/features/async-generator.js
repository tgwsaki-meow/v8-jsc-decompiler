// async-generator -- async generator function
// group=async script sloppy
async function* g(n) {
  for (var i = 0; i < n; i++) {
    yield await Promise.resolve(i);
  }
}
async function drain() {
  var out = [];
  for await (var v of g(3)) {
    out.push(v);
  }
  return out;
}
drain().then(function (v) { T('asyncGen', v); });
