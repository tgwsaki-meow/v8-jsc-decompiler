// switch-no-default -- switch with no default clause
// group=switch script sloppy
function f(x) {
  var r = "init";
  switch (x) {
    case 1: r = "one"; break;
    case 2: r = "two"; break;
  }
  return r;
}
T('all', [1, 2, 3].map(f));
