// decl-var-redeclare -- var redeclaration and function/var interaction
// group=declaration script sloppy
function f() {
  var a = 1;
  var a;
  function a2() { return 1; }
  var a2 = 3;
  return [a, a2, typeof a2];
}
T('redeclare', f());
