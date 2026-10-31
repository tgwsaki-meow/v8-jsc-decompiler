// class-private-static -- private static field and method
// group=class script sloppy
class A {
  static #n = 0;
  static #inc() {
    A.#n += 1;
    return A.#n;
  }
  static run() {
    return [A.#inc(), A.#inc()];
  }
}
T('privateStatic', A.run());
