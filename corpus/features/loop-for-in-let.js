// loop-for-in-let -- for-in with a let binding and a property target
// group=loop script sloppy
function f(o) {
  var out = [];
  for (let k in o) {
    out.push(k);
  }
  var holder = { k: null };
  for (holder.k in o) {
    out.push("h:" + holder.k);
  }
  return out;
}
T('forin', f({ a: 1, b: 2 }));
