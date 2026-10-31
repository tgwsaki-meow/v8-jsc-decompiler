function T(){}
// switch-default-middle -- switch with default in the middle
// group=switch script sloppy
function f(x) {
  var out = [];
  switch (x) {
    case 1:
      out.push("one");
      break;
    default:
      out.push("def");
      break;
    case 2:
      out.push("two");
      break;
  }
  return out;
}
T('1', f(1)); T('2', f(2)); T('9', f(9));
