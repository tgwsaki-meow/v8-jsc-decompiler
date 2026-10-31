function f(a, b) {
  return (a == b) + (a === b) + (a != b) + (a !== b) + (a < b) + (a > b)
       + (a <= b) + (a >= b) + (a in Object(b)) + (b instanceof Object);
}
f(1, 1);
