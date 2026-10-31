// objlit-getset -- getters and setters in an object literal
// group=literal script sloppy
var calls = [];
var o = {
  get v() {
    calls.push("get");
    return 1;
  },
  set v(x) {
    calls.push("set:" + x);
  },
  get ["computed" + 1]() {
    return 2;
  },
};
T('get', o.v); o.v = 5; T('computed', o.computed1); T('calls', calls.slice());
