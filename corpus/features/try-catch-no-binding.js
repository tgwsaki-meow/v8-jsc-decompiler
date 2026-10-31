// try-catch-no-binding -- optional catch binding
// group=try script sloppy
function f(x) {
  try {
    if (x) throw new Error("e");
    return "ok";
  } catch {
    return "caught";
  }
}
T('throw', f(1)); T('clean', f(0));
