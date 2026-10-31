// class-static-block -- static initialisation block
// group=class script sloppy
var log = [];
class A {
  static x = 1;
  static {
    log.push("block1");
    A.y = A.x + 1;
  }
  static {
    log.push("block2");
    this.z = A.y + 1;
  }
}
T('staticBlock', [A.x, A.y, A.z, log.slice()]);
