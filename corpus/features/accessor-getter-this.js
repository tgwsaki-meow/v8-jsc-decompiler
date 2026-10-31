// accessor-getter-this -- getter receiver and inherited accessors
// group=accessor script sloppy
var base = {
  get id() {
    return this.tag;
  },
};
var child = Object.create(base);
child.tag = "child";
T('inherited', child.id); T('own', Object.prototype.hasOwnProperty.call(child, 'id'));
