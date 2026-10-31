// class-private-in -- ergonomic brand check (#x in obj)
// group=class script sloppy
class A {
  #tag = 1;
  static has(o) {
    return #tag in o;
  }
}
T('brand', [A.has(new A()), A.has({})]);
