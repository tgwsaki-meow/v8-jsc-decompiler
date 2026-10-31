// arr-sparse -- sparse array literal with holes
// group=literal script sloppy
var a = [1, , 3, , ];
T('holes', [a.length, 1 in a, 0 in a, a[1]]); T('keys', Object.keys(a));
T('map', a.map(function (x) { return x; }).length);
