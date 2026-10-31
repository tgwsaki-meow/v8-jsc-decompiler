// try-finally-return -- return inside finally overrides the try return
// group=try script sloppy  (token register + SwitchOnSmiNoFeedback dispatch shape)
function f(x) {
  try {
    return "try";
  } finally {
    if (x) return "finally";
  }
}
function g() {
  try {
    throw new Error("e");
  } finally {
    return "finally-swallows-throw";
  }
}
T('override', f(1)); T('passthrough', f(0)); T('swallow', g());
