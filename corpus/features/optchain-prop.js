// optchain-prop -- optional property access
// group=optional-chain script sloppy
function f(o) {
  return o?.a?.b;
}
T('present', f({ a: { b: 1 } })); T('nullish', f(null)); T('mid', f({}));
