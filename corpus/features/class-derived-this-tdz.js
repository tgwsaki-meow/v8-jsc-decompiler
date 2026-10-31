// class-derived-this-tdz -- derived constructor touching this before super()
// group=class script sloppy  (the this-binding starts as the hole; reading it throws ReferenceError)
class Base {
  constructor() {
    this.ok = 1;
  }
}
class Derived extends Base {
  constructor(touch) {
    if (touch) {
      try {
        this.x = 1;
      } catch (e) {
        super();
        this.err = e.constructor.name;
        return;
      }
    }
    super();
    this.err = "none";
  }
}
T('touch', new Derived(true).err); T('clean', new Derived(false).err);
