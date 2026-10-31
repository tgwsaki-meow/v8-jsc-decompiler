// op-nullish -- nullish coalescing ??
// group=operator script sloppy
function f(a, b) {
  return a ?? b;
}
T('null', f(null, 'd')); T('undef', f(undefined, 'd')); T('zero', f(0, 'd')); T('empty', f('', 'd'));
