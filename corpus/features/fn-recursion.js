// fn-recursion -- direct recursion
// group=function script sloppy
function fact(n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}
T('fact', [fact(0), fact(1), fact(6)]);
