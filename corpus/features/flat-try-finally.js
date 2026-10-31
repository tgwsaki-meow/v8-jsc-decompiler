// flat-try-finally -- try/finally in top-level code
// group=flat script sloppy
var log = [];
try {
  log.push("try");
} finally {
  log.push("finally");
}
log.push("after");
T('finally', log);
