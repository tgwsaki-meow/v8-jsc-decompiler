// decl-const -- const declaration and assignment TypeError
// group=declaration script sloppy  (assignment to a const binding is a runtime TypeError, not an early error)
function f() {
  const a = 1;
  try {
    a = 2;
  } catch (e) {
    return [a, e.constructor.name];
  }
  return [a, "no throw"];
}
T('const', f());
