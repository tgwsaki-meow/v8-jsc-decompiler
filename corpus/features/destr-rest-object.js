// destr-rest-object -- object rest property
// group=destructuring script sloppy
function f(o) {
  var { a, ...rest } = o;
  return [a, rest];
}
T('rest', f({ a: 1, b: 2, c: 3 }));
