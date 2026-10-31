// fn-default-params -- default parameter values
// group=function script sloppy
var log = [];
function d() {
  log.push("d");
  return 10;
}
function f(a, b = d(), c = a + b) {
  return [a, b, c];
}
T('none', f(1)); T('some', f(1, 2)); T('all', f(1, 2, 3)); T('undef', f(1, undefined, 5)); T('log', log.slice()); T('length', f.length);
