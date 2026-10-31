// label-block-break -- break out of a labeled block (no loop)
// group=label script sloppy
function f(x) {
  var out = [];
  block: {
    out.push(1);
    if (x) break block;
    out.push(2);
  }
  out.push(3);
  return out;
}
T('taken', f(true)); T('not', f(false));
