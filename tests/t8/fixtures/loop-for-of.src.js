function T(){}
// loop-for-of -- for-of over an iterable
// group=loop script sloppy
function f(it) {
  var out = [];
  for (var v of it) {
    out.push(v);
  }
  return out;
}
T('array', f([1, 2, 3])); T('string', f('abc')); T('set', f(new Set([1, 1, 2]))); T('empty', f([]));
