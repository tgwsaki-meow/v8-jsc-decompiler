class A {
  #p = 1;
  static s = 2;
  static { A.t = 3; }
  constructor(x) { this.x = x; }
  get v() { return this.#p; }
  set v(n) { this.#p = n; }
  m() { return this.x; }
  static sm() { return 1; }
}
class B extends A {
  constructor(x) { super(x + 1); }
  m() { return super.m() + 1; }
  ['computed' + 1]() { return 2; }
}
new B(1).m();
