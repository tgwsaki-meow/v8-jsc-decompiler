// op-instanceof -- instanceof operator
// group=operator script sloppy
function C() {}
function f(v, k) {
  return v instanceof k;
}
T('yes', f(new C(), C)); T('no', f({}, C)); T('fn', f(f, Function)); T('arr', f([], Array));
