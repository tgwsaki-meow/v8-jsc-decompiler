// try-catch-destructuring-binding -- catch with a destructuring binding
// group=try script sloppy
function f() {
  try {
    throw { code: 7, msg: "m", extra: [1, 2] };
  } catch ({ code, msg, extra: [first] }) {
    return [code, msg, first];
  }
}
T('destr', f());
