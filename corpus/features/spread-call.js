// spread-call -- spread in a call argument list
// group=spread script sloppy
function f(a, b, c) {
  return [a, b, c, arguments.length];
}
T('only', f(...[1, 2, 3])); T('mixed', f(0, ...[1, 2], ...[3])); T('string', f(...'ab'));
var o = { m: function () { return [this.tag, arguments.length]; }, tag: "o" };
T('method', o.m(...[1, 2]));
