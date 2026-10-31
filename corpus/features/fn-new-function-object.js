// fn-new-function-object -- constructor function with new, prototype methods
// group=function script sloppy
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.sum = function () {
  return this.x + this.y;
};
var p = new Point(1, 2);
T('new', [p.x, p.y, p.sum(), p instanceof Point]);
