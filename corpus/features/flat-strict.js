// flat-strict -- top-level code in strict mode
// group=flat script strict
'use strict';
var out = [];
try {
  undeclaredAssignment = 1;
  out.push("assigned");
} catch (e) {
  out.push(e.constructor.name);
}
for (var i = 0; i < 3; i++) {
  out.push(i);
}
T('strict', out);
