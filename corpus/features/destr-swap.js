// destr-swap -- swap via array destructuring
// group=destructuring script sloppy
function f(a, b) {
  [a, b] = [b, a];
  return [a, b];
}
T('swap', f(1, 2));
