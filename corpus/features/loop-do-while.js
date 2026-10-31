// loop-do-while -- do-while loop (body runs at least once)
// group=loop script sloppy
function f(n) {
  var i = 0, s = 0;
  do {
    s += i;
    i++;
  } while (i < n);
  return [i, s];
}
T('n5', f(5)); T('n0', f(0));
