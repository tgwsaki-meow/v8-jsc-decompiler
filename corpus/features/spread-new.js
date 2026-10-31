// spread-new -- spread in a new expression
// group=spread script sloppy
function C(a, b) {
  this.v = [a, b];
}
class K {
  constructor(a, b) {
    this.v = a + b;
  }
}
T('fn', new C(...[1, 2]).v); T('class', new K(...[1, 2]).v); T('date', new Date(...[2020, 0, 1]).getFullYear());
