// destr-nested -- nested array/object destructuring
// group=destructuring script sloppy
function f(o) {
  var { a: [first, { deep }], b: { c } } = o;
  return [first, deep, c];
}
T('nested', f({ a: [1, { deep: 2 }], b: { c: 3 } }));
