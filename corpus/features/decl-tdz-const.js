// decl-tdz-const -- const temporal dead zone
// group=declaration script sloppy
function f() {
  let out = [];
  try {
    out.push(k);
  } catch (e) {
    out.push(e.constructor.name);
  }
  const k = 9;
  out.push(k);
  return out;
}
T('tdzConst', f());
