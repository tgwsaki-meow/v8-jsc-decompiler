// mode-strict-function -- function-level "use strict" inside a sloppy script
// group=mode script sloppy
function sloppy() {
  return this;
}
function strict() {
  "use strict";
  return this;
}
T('sloppyThis', typeof sloppy()); T('strictThis', strict());
T('arity', [sloppy.length, strict.length]);
