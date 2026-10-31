// flat-do-while -- do-while loop in top-level code
// group=flat script sloppy
var i = 0, s = 0;
do {
  s += i;
  i++;
} while (i < 4);
T('doWhile', [i, s]);
