// op-mod -- binary % (remainder)
// group=operator script sloppy
function f(a, b) {
  return a % b;
}
T('num', f(7, 3)); T('neg', f(-7, 3)); T('frac', f(5.5, 2));
