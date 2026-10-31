function outer(a) {
  let b = a + 1;
  const c = a + 2;
  function mid(d) {
    let e = b + d;
    {
      let f = e + c;
      return function inner() { return a + b + c + d + e + f; };
    }
  }
  return mid(1)();
}
outer(1);
