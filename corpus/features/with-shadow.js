// with-shadow -- with shadowing a local and falling through to it
// group=dynamic-scope script sloppy
function f(o) {
  var a = "local";
  var b = "local-b";
  var out = [];
  with (o) {
    out.push(a);
    out.push(b);
  }
  return out;
}
T('shadow', f({ a: 'from-o' }));
