// fn-closure-counter -- closure over a mutable local
// group=function script sloppy
function mk() {
  var n = 0;
  return function () {
    n++;
    return n;
  };
}
var c1 = mk(), c2 = mk();
T('independent', [c1(), c1(), c2()]);
