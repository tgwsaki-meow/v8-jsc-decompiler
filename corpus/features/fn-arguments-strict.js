// fn-arguments-strict -- the arguments object (unmapped, strict mode)
// group=function script strict
'use strict';
function f(a) {
  arguments[0] = 99;
  return [a, arguments.length];
}
T('unmapped', f(1, 2));
