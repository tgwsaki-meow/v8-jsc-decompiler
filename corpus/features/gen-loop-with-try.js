// gen-loop-with-try -- generator with a loop and a try/finally around the yield
// group=generator script sloppy  (SuspendGenerator inside a protected range)
function* g(n) {
  var log = [];
  for (var i = 0; i < n; i++) {
    try {
      yield i;
    } finally {
      log.push("f" + i);
    }
  }
  return log;
}
var it = g(2);
T('steps', [it.next(), it.next(), it.next()]);
