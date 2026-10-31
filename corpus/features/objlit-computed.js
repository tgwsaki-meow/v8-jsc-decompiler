// objlit-computed -- computed property keys
// group=literal script sloppy
var log = [];
function k(n) {
  log.push(n);
  return n;
}
function f(x) {
  return { [k("a")]: 1, [k(x)]: 2, [k("c")]: 3 };
}
T('computed', f('b')); T('order', log.slice()); T('overwrite', f('a'));
