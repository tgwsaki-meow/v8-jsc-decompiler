// class-computed-keys -- computed method and accessor names
// group=class script sloppy
var log = [];
function k(n) {
  log.push(n);
  return n;
}
class A {
  [k("m")]() {
    return "m";
  }
  get [k("g")]() {
    return "g";
  }
  static [k("s")]() {
    return "s";
  }
}
var a = new A();
T('computed', [a.m(), a.g, A.s()]); T('keyOrder', log.slice());
