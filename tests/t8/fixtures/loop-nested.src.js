function T(){}
// loop-nested -- nested loops
// group=loop script sloppy
function f(n, m) {
  var s = 0;
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < m; j++) {
      s += i * j;
    }
  }
  return s;
}
T('3x4', f(3, 4)); T('0x4', f(0, 4));
