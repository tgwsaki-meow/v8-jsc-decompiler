function T(){}
// loop-while-continue -- continue inside a while loop
// group=loop script sloppy
function f(n) {
  var i = 0, s = 0;
  while (i < n) {
    i++;
    if (i % 2) continue;
    s += i;
  }
  return s;
}
T('n6', f(6));
