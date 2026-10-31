// try-finally-nested-return -- nested finally blocks each with a return
// group=try script sloppy  (two token registers nested; the innermost completion wins)
function f(a, b) {
  try {
    try {
      return "inner-try";
    } finally {
      if (a) return "inner-finally";
    }
  } finally {
    if (b) return "outer-finally";
  }
}
T('00', f(0, 0)); T('10', f(1, 0)); T('01', f(0, 1)); T('11', f(1, 1));
