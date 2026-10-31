// accessor-defineproperty-class -- defineProperty on a class prototype
// group=accessor script sloppy
class A {}
Object.defineProperty(A.prototype, "computed", {
  get: function () {
    return "c";
  },
  configurable: true,
});
Object.defineProperties(A, { s: { value: 1, enumerable: true } });
T('proto', new A().computed); T('static', A.s);
