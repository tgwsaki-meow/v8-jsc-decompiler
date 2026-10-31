// op-assign-shr -- compound assignment >>=
// group=operator script sloppy
function f(a, b) {
  a >>= b;
  return a;
}
function g(o, b) {
  o.n >>= b;
  return o.n;
}
function h(arr, b) {
  arr[0] >>= b;
  return arr[0];
}
T('local', f(12, 3)); T('prop', g({ n: 12 }, 3)); T('elem', h([12], 3)); T('neg', f(-12, 3));
