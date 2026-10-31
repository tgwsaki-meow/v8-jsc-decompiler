// fn-arguments -- the arguments object (mapped, sloppy mode)
// group=function script sloppy
function f(a) {
  arguments[0] = 99;
  return [a, arguments.length, Array.prototype.slice.call(arguments)];
}
function g() {
  return arguments.length;
}
T('mapped', f(1, 2)); T('noparams', g(1, 2, 3));
