// class-static -- static methods and static fields
// group=class script sloppy
class A {
  static count = 0;
  static make() {
    A.count++;
    return new A();
  }
  static get label() {
    return "A" + A.count;
  }
}
A.make(); A.make();
T('static', [A.count, A.label, A.make() instanceof A]);
