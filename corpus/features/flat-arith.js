// flat-arith -- arithmetic in top-level code, no function literal
// group=flat script sloppy
var a = 7, b = 3;
var r = [a + b, a - b, a * b, a / b, a % b, a ** b, -a, ~a];
T('arith', r);
