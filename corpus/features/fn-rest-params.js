// fn-rest-params -- rest parameter
// group=function script sloppy
function f(a, ...rest) {
  return [a, rest, rest.length];
}
T('none', f(1)); T('some', f(1, 2, 3)); T('length', f.length);
