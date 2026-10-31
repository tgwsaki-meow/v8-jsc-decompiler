// flat-for-of -- for-of in top-level code
// group=flat script sloppy
var out = [];
for (var v of [1, 2, 3]) {
  out.push(v * 2);
}
for (var ch of "ab") {
  out.push(ch);
}
T('forOf', out);
