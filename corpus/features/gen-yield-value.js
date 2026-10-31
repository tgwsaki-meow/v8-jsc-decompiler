// gen-yield-value -- yield as an expression receiving next(v)
// group=generator script sloppy
function* g() {
  var a = yield 1;
  var b = yield a + 1;
  return [a, b];
}
var it = g();
T('sent', [it.next(), it.next(10), it.next(20)]);
