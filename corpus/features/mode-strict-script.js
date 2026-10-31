// mode-strict-script -- whole-script strict mode
// group=mode script strict
'use strict';
function f() {
  return this;
}
function g() {
  try {
    undeclared = 1;
    return "assigned";
  } catch (e) {
    return e.constructor.name;
  }
}
T('this', f()); T('assign', g()); T('delete', (function () { try { return eval('delete Object.prototype'); } catch (e) { return e.constructor.name; } })());
