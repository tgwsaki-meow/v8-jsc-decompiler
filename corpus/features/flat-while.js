// flat-while -- while loop in top-level code
// group=flat script sloppy
var i = 0, s = 0;
while (i < 5) {
  s += i;
  i++;
}
T('while', [i, s]);
