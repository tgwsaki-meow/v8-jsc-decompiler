// loop-while -- while loop
// group=loop script sloppy
function f(n) {
  var i = 0, s = 0;
  while (i < n) {
    s += i;
    i++;
  }
  return [i, s];
}
T('n5', f(5)); T('n0', f(0));
