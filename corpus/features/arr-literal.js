// arr-literal -- array literal, nested and empty
// group=literal script sloppy
var a = [1, "two", [3, [4]], {}, null, undefined];
T('shape', [a.length, a[2][1][0], typeof a[3], a[4], a[5]]); T('empty', [].length);
