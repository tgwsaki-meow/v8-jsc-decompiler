// destr-array -- array destructuring
// group=destructuring script sloppy
function f(a) {
  var [x, y, z] = a;
  return [x, y, z];
}
T('full', f([1, 2, 3])); T('short', f([1])); T('string', (function () { var [c1, c2] = 'ab'; return [c1, c2]; })());
