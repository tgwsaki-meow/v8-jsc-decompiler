// fn-getter-setter-object -- accessors declared in an object literal
// group=function script sloppy
var o = {
  _v: 1,
  get v() {
    return this._v * 2;
  },
  set v(x) {
    this._v = x + 1;
  },
};
T('get', o.v); o.v = 10; T('set', [o._v, o.v]);
T('descriptor', Object.keys(Object.getOwnPropertyDescriptor(o, 'v')).sort());
