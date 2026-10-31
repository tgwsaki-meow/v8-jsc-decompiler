// op-strict-eq -- binary === (strict equality)
// group=operator script sloppy
function f(a, b) {
  return a === b;
}
T('same', f(1, 1)); T('coerce', f('1', 1)); T('negzero', f(0, -0));
