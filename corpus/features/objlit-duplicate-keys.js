// objlit-duplicate-keys -- duplicate keys, last wins
// group=literal script sloppy
var log = [];
function v(n) {
  log.push(n);
  return n;
}
var o = { a: v(1), b: v(2), a: v(3) };
T('dup', [o.a, o.b]); T('order', log.slice());
