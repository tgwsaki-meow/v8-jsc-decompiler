// flat-template -- template literals in top-level code
// group=flat script sloppy
var a = 1, b = "x";
var s = `a${a}b${b}c${a + 1}`;
var m = `line1
line2`;
T('template', [s, m.length]);
