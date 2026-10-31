// try-strict -- try/catch/finally in strict mode
// group=try script strict
'use strict';
function f(x) {
  try {
    if (x) throw new Error("e");
    return "ok";
  } catch (e) {
    return e.message;
  } finally {
    void 0;
  }
}
T('throw', f(1)); T('clean', f(0));
