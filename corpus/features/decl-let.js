// decl-let -- let declaration, block scoped
// group=declaration script sloppy
function f() {
  let a = 1;
  {
    let a = 2;
    var inner = a;
  }
  return [a, inner];
}
T('let', f());
