// class-extends-implicit-ctor -- derived class with no explicit constructor
// group=class script sloppy
class Base {
  constructor(a, b) {
    this.sum = a + b;
  }
}
class Derived extends Base {}
T('implicit', [new Derived(1, 2).sum, Derived.length]);
