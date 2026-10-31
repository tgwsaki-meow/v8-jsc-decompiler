// class-super-in-static -- super in a static method
// group=class script sloppy
class Base {
  static who() {
    return "base";
  }
}
class Derived extends Base {
  static who() {
    return "derived+" + super.who();
  }
}
T('staticSuper', Derived.who());
