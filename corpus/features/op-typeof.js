// op-typeof -- typeof
// group=operator script sloppy
function f(a) {
  return typeof a;
}
T('num', f(1)); T('str', f('')); T('undef', f(undefined)); T('fn', f(f)); T('sym', f(Symbol.iterator)); T('big', f(1n));
function g() {
  return typeof notDeclaredAnywhere;
}
T('undeclared', g());
