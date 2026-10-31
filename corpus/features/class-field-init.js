// class-field-init -- instance fields with initialisers
// group=class script sloppy
var log = [];
class A {
  a = log.push("a");
  b = this.a + 1;
  c;
  constructor(v) {
    log.push("ctor");
    this.d = v;
  }
}
var x = new A(9);
T('fields', [x.a, x.b, x.c, x.d]); T('order', log.slice()); T('own', Object.keys(x));
