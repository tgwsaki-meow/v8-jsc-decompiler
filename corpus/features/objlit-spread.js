// objlit-spread -- object spread
// group=literal script sloppy
function f(a, b) {
  return { x: 0, ...a, y: 1, ...b };
}
T('merge', f({ x: 9, z: 2 }, { y: 3 })); T('nullish', f(null, undefined)); T('string', { ...'ab' });
