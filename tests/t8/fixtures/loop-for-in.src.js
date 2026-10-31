function T(){}
// loop-for-in -- for-in over own and inherited keys
// group=loop script sloppy
function f(o) {
  var ks = [];
  for (var k in o) {
    ks.push(k);
  }
  return ks;
}
function P() { this.own = 1; }
P.prototype.inherited = 2;
T('plain', f({ a: 1, b: 2 })); T('proto', f(new P())); T('array', f(['x', 'y'])); T('empty', f({}));
