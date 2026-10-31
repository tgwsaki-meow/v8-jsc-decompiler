// with-basic -- with statement
// group=dynamic-scope script sloppy  (sloppy mode only; creates a with-context, so every name lookup becomes dynamic)
function f(o) {
  var out = [];
  with (o) {
    out.push(a);
    a = 2;
    out.push(a);
  }
  return [out, o.a];
}
T('with', f({ a: 1 }));
