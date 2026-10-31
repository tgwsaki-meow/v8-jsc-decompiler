function f(o, a) {
  var {x, y: {z} = {z: 1}, ...rest} = o;
  var [p, , q = 5, ...tail] = a;
  ({x} = o);
  return x + z + p + q + rest.n + tail.length;
}
f({x: 1, y: {z: 2}, n: 3}, [1, 2, 3, 4]);
