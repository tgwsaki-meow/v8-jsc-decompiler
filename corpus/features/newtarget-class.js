// newtarget-class -- new.target in constructors and across extends
// group=new-target script sloppy
class Base {
  constructor() {
    this.nt = new.target.name;
  }
}
class Derived extends Base {}
T('base', new Base().nt); T('derived', new Derived().nt);
function viaReflect() {
  return new.target && new.target.name;
}
T('reflect', Reflect.construct(viaReflect, [], Base));
