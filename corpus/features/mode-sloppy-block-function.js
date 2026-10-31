// mode-sloppy-block-function -- block-scoped function declaration in sloppy mode (annex B hoisting)
// group=mode script sloppy
function f(x) {
  if (x) {
    function g() {
      return "inner";
    }
  }
  return typeof g;
}
T('taken', f(true)); T('not', f(false));
