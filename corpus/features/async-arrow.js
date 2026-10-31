// async-arrow -- async arrow function
// group=async script sloppy
var f = async (a) => {
  var v = await a;
  return v * 2;
};
var g = async a => await a;
Promise.all([f(2), g(3)]).then(function (v) { T('asyncArrow', v); });
