// decl-tdz-let -- let temporal dead zone
// group=declaration script sloppy  (the TDZ check is a ThrowReferenceErrorIfHole in the bytecode)
function f() {
  let out = [];
  {
    try {
      out.push(x);
    } catch (e) {
      out.push(e.constructor.name);
    }
    let x = 1;
    out.push(x);
  }
  return out;
}
function g() {
  let out = [];
  try {
    out.push(y);
  } catch (e) {
    out.push(e.constructor.name);
  }
  let y = 2;
  out.push(y);
  return out;
}
T('tdzBlock', f()); T('tdzFunction', g());
