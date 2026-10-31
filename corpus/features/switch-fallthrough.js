// switch-fallthrough -- switch with fallthrough between cases
// group=switch script sloppy
function f(x) {
  var out = [];
  switch (x) {
    case 1:
      out.push(1);
    case 2:
      out.push(2);
      break;
    case 3:
      out.push(3);
    default:
      out.push("d");
  }
  return out;
}
T('1', f(1)); T('2', f(2)); T('3', f(3)); T('9', f(9));
