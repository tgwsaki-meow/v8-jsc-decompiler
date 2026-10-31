// class-methods -- class with prototype methods
// group=class script sloppy
class A {
  constructor(v) {
    this.v = v;
  }
  twice() {
    return this.v * 2;
  }
  other(n) {
    return this.twice() + n;
  }
}
var a = new A(3);
T('methods', [a.v, a.twice(), a.other(1)]); T('name', A.name);
T('enumerable', Object.keys(A.prototype));
