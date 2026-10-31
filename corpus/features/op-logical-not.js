// op-logical-not -- logical NOT !
// group=operator script sloppy
function f(a) {
  return !a;
}
T('truthy', f(1)); T('falsy', f(0)); T('obj', f({}));
