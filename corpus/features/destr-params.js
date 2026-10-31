// destr-params -- destructuring in parameter position
// group=destructuring script sloppy
function f({ a, b = 2 }, [c, d = 4] = []) {
  return [a, b, c, d];
}
T('full', f({ a: 1, b: 9 }, [3, 8])); T('defaults', f({ a: 1 })); T('length', f.length);
