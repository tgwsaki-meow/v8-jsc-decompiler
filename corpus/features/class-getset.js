// class-getset -- class getters and setters
// group=class script sloppy
class A {
  constructor() {
    this._v = 1;
  }
  get v() {
    return this._v * 10;
  }
  set v(x) {
    this._v = x;
  }
  static get s() {
    return "stat";
  }
}
var a = new A();
T('get', a.v); a.v = 5; T('set', [a._v, a.v]); T('staticGet', A.s);
