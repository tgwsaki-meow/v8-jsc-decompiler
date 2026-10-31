// decl-var -- var declaration and function-scoped hoisting
// group=declaration script sloppy
function f() {
  var a = 1;
  if (a) {
    var b = 2;
  }
  return [a, b, typeof c];
  var c = 3;
}
T('var', f());
