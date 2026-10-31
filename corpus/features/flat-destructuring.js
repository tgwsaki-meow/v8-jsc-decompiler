// flat-destructuring -- destructuring in top-level code
// group=flat script sloppy
var [x, y, ...rest] = [1, 2, 3, 4];
var { a, b: bb = 9 } = { a: 5 };
var o = {};
({ p: o.p } = { p: 7 });
T('destructuring', [x, y, rest, a, bb, o.p]);
