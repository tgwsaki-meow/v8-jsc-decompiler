// class-extends-super-call -- extends with a super() call in a derived constructor
// group=class script sloppy  (derived ctor: FindNonDefaultConstructorOrConstruct + this-binding hole check)
class Base {
  constructor(a) {
    this.a = a;
  }
}
class Derived extends Base {
  constructor(a, b) {
    super(a * 2);
    this.b = b;
  }
}
var d = new Derived(1, 2);
T('super', [d.a, d.b, d instanceof Base, Object.getPrototypeOf(Derived) === Base]);
