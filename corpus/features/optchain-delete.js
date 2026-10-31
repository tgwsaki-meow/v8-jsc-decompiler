// optchain-delete -- delete with an optional chain
// group=optional-chain script sloppy
function f(o) {
  return delete o?.a;
}
T('present', (function () { var o = { a: 1 }; return [f(o), 'a' in o]; })()); T('nullish', f(null));
