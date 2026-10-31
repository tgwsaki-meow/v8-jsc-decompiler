// async-iife -- async IIFE
// group=async script sloppy
(async function () {
  var v = await 5;
  T("asyncIife", v);
})();
(async () => {
  T("asyncArrowIife", await 6);
})();
