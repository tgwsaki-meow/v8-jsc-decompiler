// accessor-defineproperty -- Object.defineProperty getter/setter
// group=accessor script sloppy
function mk() {
  var store = 1;
  var o = {};
  Object.defineProperty(o, "v", {
    get: function () {
      return store * 2;
    },
    set: function (x) {
      store = x;
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(o, "ro", { value: 7, writable: false, enumerable: false });
  return o;
}
var o = mk();
T('get', o.v); o.v = 5; T('set', o.v); T('ro', o.ro); T('keys', Object.keys(o));
T('descriptor', Object.getOwnPropertyDescriptor(o, 'ro'));
