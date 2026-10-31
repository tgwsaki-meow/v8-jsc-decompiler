// fn-expression -- anonymous function expression
// group=function script sloppy
var f = function (a) {
  return a + 1;
};
T('call', f(1)); T('name', f.name);
