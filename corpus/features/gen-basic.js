// gen-basic -- generator function, yield, next
// group=generator script sloppy
function* g(n) {
  for (var i = 0; i < n; i++) {
    yield i;
  }
  return "done";
}
var it = g(3);
T('steps', [it.next(), it.next(), it.next(), it.next(), it.next()]);
T('spread', [...g(3)]);
