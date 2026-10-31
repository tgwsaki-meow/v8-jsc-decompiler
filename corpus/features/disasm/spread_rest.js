function g() { return arguments.length; }
function f(a, ...rest) {
  var arr = [1, ...a, 2];
  var o = {p: 1, ...a};
  return g(...arr, ...rest) + arr.length + o.p + new Date(...arr).getTime();
}
f([1, 2], 3, 4);
