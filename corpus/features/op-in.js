// op-in -- in operator
// group=operator script sloppy
function f(k, o) {
  return k in o;
}
var o = { a: 1 };
T('own', f('a', o)); T('proto', f('toString', o)); T('missing', f('zz', o));
T('array', f(0, [9])); T('arrayLen', f('length', [9]));
