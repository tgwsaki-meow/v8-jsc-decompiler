// class-private-method -- private method and private accessor
// group=class script sloppy
class A {
  #secret() {
    return 7;
  }
  get #hidden() {
    return 8;
  }
  reveal() {
    return [this.#secret(), this.#hidden];
  }
}
T('privateMethod', new A().reveal());
