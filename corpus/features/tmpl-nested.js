// tmpl-nested -- nested template literals
// group=template script sloppy
function f(a) {
  return `outer${`inner${a}`}end`;
}
T('nested', f(1));
