// gen-return-throw -- generator .return() and .throw()
// group=generator script sloppy
function* g() {
  try {
    yield 1;
    yield 2;
  } catch (e) {
    yield "caught:" + e;
  } finally {
    T("finally", true);
  }
}
var a = g();
a.next(); T('return', a.return('early'));
var b = g();
b.next(); T('throw', b.throw('boom')); T('after', b.next());
