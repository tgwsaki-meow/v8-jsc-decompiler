// flat-logical -- short-circuit operators and optional chaining in top-level code
// group=flat script sloppy
var o = { a: { b: 2 } };
var n = null;
var r = [o && o.a.b, n || 'dflt', n ?? 'nullish', o?.a?.b, n?.x, o?.missing?.deep];
T('logical', r);
