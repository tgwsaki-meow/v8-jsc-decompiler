// loop-for-of-break -- for-of with an early break (IteratorClose)
// group=loop script sloppy  (breaking out of for-of calls iterator.return() -- emitted as a finally)
function f() {
  var closed = false;
  var it = {
    [Symbol.iterator]: function () {
      var i = 0;
      return {
        next: function () { return { value: i++, done: i > 5 }; },
        return: function () { closed = true; return { done: true }; },
      };
    },
  };
  var out = [];
  for (var v of it) {
    if (v === 2) break;
    out.push(v);
  }
  return [out, closed];
}
T('close', f());
