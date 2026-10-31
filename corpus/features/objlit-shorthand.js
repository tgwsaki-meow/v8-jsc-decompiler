// objlit-shorthand -- shorthand properties and methods
// group=literal script sloppy
function f(a, b) {
  return {
    a,
    b,
    sum() {
      return this.a + this.b;
    },
  };
}
var o = f(1, 2);
T('shorthand', [o.a, o.b, o.sum(), Object.keys(o)]);
