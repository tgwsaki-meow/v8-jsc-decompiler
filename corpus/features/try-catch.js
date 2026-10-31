// try-catch -- try/catch
// group=try script sloppy
function f(x) {
  try {
    if (x) throw new Error("boom");
    return "ok";
  } catch (e) {
    return "caught:" + e.message;
  }
}
T('throw', f(1)); T('clean', f(0));
