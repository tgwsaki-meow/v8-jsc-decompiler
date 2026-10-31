// eval-direct -- direct eval sees the local scope
// group=dynamic-scope script sloppy
function f(n) {
  var local = n;
  return eval("local + 1");
}
function g() {
  eval("var introduced = 5;");
  return typeof introduced === "undefined" ? "none" : introduced;
}
T('direct', f(1)); T('introduces', g());
