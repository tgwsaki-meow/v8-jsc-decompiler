function T(){}
// switch-string -- switch on strings
// group=switch script sloppy
function f(x) {
  switch (x) {
    case "a": return 1;
    case "b": return 2;
    case "": return 3;
    default: return 0;
  }
}
T('all', ['a', 'b', '', 'z'].map(f));
