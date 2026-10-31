// class-strict-body -- class bodies are always strict
// group=class script sloppy  (no "use strict" needed: assigning to an undeclared name inside a method throws)
class A {
  m() {
    try {
      undeclaredGlobalName = 1;
      return "assigned";
    } catch (e) {
      return e.constructor.name;
    }
  }
}
T('implicitStrict', new A().m());
