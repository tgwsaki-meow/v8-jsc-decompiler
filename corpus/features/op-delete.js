// op-delete -- delete
// group=operator script sloppy
function f(o, k) {
  return delete o[k];
}
var o = { a: 1, b: 2 };
T('del', f(o, 'a')); T('left', Object.keys(o)); T('missing', f(o, 'zz'));
T('namedDelete', (function () { var p = { x: 1 }; return [delete p.x, 'x' in p]; })());
