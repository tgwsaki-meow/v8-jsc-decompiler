// op-eq -- binary == (loose equality)
// group=operator script sloppy
function f(a, b) {
  return a == b;
}
T('coerce', f('1', 1)); T('null', f(null, undefined)); T('obj', f({}, {}));
