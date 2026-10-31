// fn-arrow-block-body -- arrow function with a block body
// group=function script sloppy
var f = (a) => {
  var b = a * 2;
  return b + 1;
};
T('call', f(3));
