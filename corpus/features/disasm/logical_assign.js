function f(o) {
  o.a ||= 1;
  o.b &&= 2;
  o.c ??= 3;
  return o;
}
f({});
