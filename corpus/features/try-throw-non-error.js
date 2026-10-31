// try-throw-non-error -- throwing primitives and objects
// group=try script sloppy
function f(v) {
  try {
    throw v;
  } catch (e) {
    return [typeof e, String(e)];
  }
}
T('num', f(1)); T('str', f('s')); T('null', f(null)); T('undef', f(undefined)); T('obj', f({ toString: function () { return 'O'; } }));
