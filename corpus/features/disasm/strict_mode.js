function f(o) {
  'use strict';
  var x = delete o.a;
  return x + (o.b = 1);
}
f({a: 1});
