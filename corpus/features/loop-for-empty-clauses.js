// loop-for-empty-clauses -- for loop with empty init/test/update
// group=loop script sloppy  (for(;;) has no test, so the only exit is the break)
function f(n) {
  var i = 0;
  for (;;) {
    if (i >= n) break;
    i++;
  }
  var j = 0;
  for (; j < n;) {
    j += 2;
  }
  return [i, j];
}
T('n5', f(5)); T('n0', f(0));
