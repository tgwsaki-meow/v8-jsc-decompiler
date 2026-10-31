// fn-iife -- immediately invoked function expression
// group=function script sloppy
var r = (function (a) {
  return a + 1;
})(1);
var s = (function () {
  return "arrow-iife";
})();
var t = (() => 7)();
T('iife', [r, s, t]);
