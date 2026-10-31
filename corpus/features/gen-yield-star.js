// gen-yield-star -- yield* delegation
// group=generator script sloppy
function* inner() {
  yield 1;
  yield 2;
  return "inner-ret";
}
function* outer() {
  var r = yield* inner();
  yield r;
  yield* [3, 4];
}
T('delegate', [...outer()]);
