// op-strict-ne -- binary !== (strict inequality)
// group=operator script sloppy
function f(a, b) {
  return a !== b;
}
T('same', f(1, 1)); T('coerce', f('1', 1)); T('nan', f(NaN, NaN));
