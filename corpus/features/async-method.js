// async-method -- async methods in classes and object literals
// group=async script sloppy
class A {
  async m(v) {
    return (await v) + 1;
  }
  static async s(v) {
    return (await v) * 2;
  }
  async *gen() {
    yield 1;
  }
}
var o = {
  async m(v) {
    return await v;
  },
};
Promise.all([new A().m(1), A.s(2), o.m(3)]).then(function (v) { T('asyncMethods', v); });
