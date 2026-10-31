function T(){}
// loop-for-3clause -- for loop with all three clauses
// group=loop script sloppy
function f(n) {
  var s = 0;
  for (var i = 0; i < n; i++) {
    s += i;
  }
  return s;
}
T('n5', f(5)); T('n1', f(1));
