// flat-for-in -- for-in in top-level code
// group=flat script sloppy
var o = { a: 1, b: 2, c: 3 };
var ks = [];
for (var k in o) {
  ks.push(k + "=" + o[k]);
}
T('forIn', ks);
