// spread-array -- spread in an array literal
// group=spread script sloppy
function f(a) {
  return [0, ...a, 9];
}
T('array', f([1, 2])); T('string', f('ab')); T('set', f(new Set([1, 1])));
