// flat-for -- 3-clause for loop in top-level code
// group=flat script sloppy
var s = 0;
for (var i = 0; i < 6; i++) {
  if (i === 3) continue;
  s += i;
}
T('for', s);
