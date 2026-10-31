// eval-strict -- eval in strict mode cannot introduce bindings
// group=dynamic-scope script strict
'use strict';
function f() {
  eval("var introduced = 5;");
  return typeof introduced;
}
T('strictEval', f());
