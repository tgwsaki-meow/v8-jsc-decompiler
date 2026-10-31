// objlit-nested-deep -- deeply nested object/array literal
// group=literal script sloppy
var o = { a: { b: { c: { d: [1, { e: { f: 2 } }] } } }, g: [[[3]]] };
T('deep', [o.a.b.c.d[1].e.f, o.g[0][0][0]]); T('json', JSON.stringify(o));
