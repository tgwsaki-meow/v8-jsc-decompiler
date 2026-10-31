// destr-array-holes -- array destructuring with elisions
// group=destructuring script sloppy
function f(a) {
  var [, second, , fourth] = a;
  return [second, fourth];
}
T('elide', f([1, 2, 3, 4]));
