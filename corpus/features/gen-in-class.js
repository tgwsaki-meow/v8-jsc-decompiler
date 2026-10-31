// gen-in-class -- generator method in a class and an object literal
// group=generator script sloppy
class A {
  *items() {
    yield 1;
    yield 2;
  }
  static *statics() {
    yield "s";
  }
}
var o = {
  *gen() {
    yield "o";
  },
};
T('class', [...new A().items()]); T('static', [...A.statics()]); T('objlit', [...o.gen()]);
