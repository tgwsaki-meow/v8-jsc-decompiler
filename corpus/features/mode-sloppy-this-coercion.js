// mode-sloppy-this-coercion -- sloppy-mode this coercion vs strict mode
// group=mode script sloppy
function sloppy() {
  return typeof this;
}
function strict() {
  "use strict";
  return typeof this;
}
T('primitive', [sloppy.call(1), strict.call(1)]); T('null', [sloppy.call(null), strict.call(null)]);
