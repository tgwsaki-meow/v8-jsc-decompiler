// class-extends-super-prop -- super.method() and super property access
// group=class script sloppy  (home object + GetNamedPropertyFromSuper)
class Base {
  constructor() {
    this.tag = "base";
  }
  name() {
    return "base";
  }
  get kind() {
    return "k-base";
  }
}
class Derived extends Base {
  name() {
    return "derived+" + super.name();
  }
  get kind() {
    return "k-derived+" + super.kind;
  }
  viaComputed() {
    return super["name"]();
  }
}
var d = new Derived();
T('superProp', [d.name(), d.kind, d.viaComputed()]);
