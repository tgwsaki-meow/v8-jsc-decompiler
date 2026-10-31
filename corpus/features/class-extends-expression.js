// class-extends-expression -- extends an arbitrary expression
// group=class script sloppy
function mixin(base) {
  return class extends base {
    extra() {
      return "extra";
    }
  };
}
class Base {
  m() {
    return "base";
  }
}
class C extends mixin(Base) {}
var c = new C();
T('mixin', [c.m(), c.extra(), c instanceof Base]);
