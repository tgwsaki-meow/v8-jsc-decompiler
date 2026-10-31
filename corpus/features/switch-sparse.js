// switch-sparse -- sparse switch (comparison chain)
// group=switch script sloppy
function f(x) {
  switch (x) {
    case 1: return "one";
    case 1000: return "k";
    case 1000000: return "m";
    default: return "none";
  }
}
T('all', [1, 1000, 1000000, 2].map(f));
