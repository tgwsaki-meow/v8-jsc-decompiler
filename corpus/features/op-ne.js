// op-ne -- binary != (loose inequality)
// group=operator script sloppy
function f(a, b) {
  return a != b;
}
T('coerce', f('1', 1)); T('null', f(null, 0)); T('nan', f(NaN, NaN));
