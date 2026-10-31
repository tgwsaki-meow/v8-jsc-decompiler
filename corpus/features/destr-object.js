// destr-object -- object destructuring with renaming
// group=destructuring script sloppy
function f(o) {
  var { a, b: renamed } = o;
  return [a, renamed];
}
T('rename', f({ a: 1, b: 2 })); T('missing', f({ a: 1 }));
