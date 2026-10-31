// flat-try-catch -- try/catch in top-level code (one handler range)
// group=flat script sloppy
var r = null;
try {
  throw new Error("boom");
} catch (e) {
  r = e.message;
}
T('catch', r);
