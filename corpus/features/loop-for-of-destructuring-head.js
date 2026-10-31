// loop-for-of-destructuring-head -- for-of with a destructuring pattern in the head
// group=loop script sloppy
function f(pairs) {
  var out = [];
  for (const [k, v] of pairs) {
    out.push(k + "=" + v);
  }
  for (const { a, b = 9 } of [{ a: 1 }, { a: 2, b: 3 }]) {
    out.push(a + ":" + b);
  }
  return out;
}
T('destr', f([['x', 1], ['y', 2]]));
