// class-private-field -- private instance field
// group=class script sloppy
class A {
  #v = 1;
  constructor(v) {
    this.#v = v;
  }
  get() {
    return this.#v;
  }
  bump() {
    this.#v += 1;
    return this.#v;
  }
}
var a = new A(5);
T('private', [a.get(), a.bump(), Object.keys(a).length]);
