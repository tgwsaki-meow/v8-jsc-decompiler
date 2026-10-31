// gen-iterator-protocol -- generator used as a custom iterator
// group=generator script sloppy
var obj = {
  data: [1, 2, 3],
  *[Symbol.iterator]() {
    for (var v of this.data) {
      yield v * 2;
    }
  },
};
T('forOf', (function () { var out = []; for (var v of obj) out.push(v); return out; })());
