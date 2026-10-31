// switch-empty -- switch with no cases, and an empty case body
// group=switch script sloppy
var log = [];
function f(x) {
  switch (log.push(x), x) {
  }
  switch (x) {
    case 1:
    case 2:
      return "12";
    case 3:
      break;
  }
  return "none";
}
T('1', f(1)); T('3', f(3)); T('log', log.slice());
