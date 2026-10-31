// spread-rest-roundtrip -- rest parameter forwarded with spread
// group=spread script sloppy
function target() {
  return Array.prototype.slice.call(arguments);
}
function forward(...args) {
  return target(...args);
}
T('forward', forward(1, 2, 3));
