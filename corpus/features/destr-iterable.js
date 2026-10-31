// destr-iterable -- destructuring a non-array iterable
// group=destructuring script sloppy
function f(it) {
  var [a, b] = it;
  return [a, b];
}
T('set', f(new Set([1, 2, 3]))); T('map', f(new Map([['k', 'v']])));
function g() {
  try {
    var [x] = 1;
    return x;
  } catch (e) {
    return e.constructor.name;
  }
}
T('nonIterable', g());
