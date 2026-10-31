// fn-closure-depth -- closure capturing across four scope depths
// group=function script sloppy  (exercises LdaContextSlot with depth > 1)
function d1(a) {
  var l1 = a + 1;
  return function d2(b) {
    var l2 = l1 + b;
    return function d3(c) {
      var l3 = l2 + c;
      return function d4(d) {
        return [a, l1, l2, l3, d, a + l1 + l2 + l3 + d];
      };
    };
  };
}
T('deep', d1(1)(2)(3)(4));
