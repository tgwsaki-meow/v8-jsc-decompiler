// fn-named-expression -- named function expression (self reference)
// group=function script sloppy
var f = function fact(n) {
  return n <= 1 ? 1 : n * fact(n - 1);
};
T('call', f(5)); T('name', f.name); T('leak', typeof fact);
