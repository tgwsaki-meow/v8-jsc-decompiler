// flat-typeof-delete -- typeof, delete, void, in, instanceof at top level
// group=flat script sloppy
var o = { a: 1 };
var r = [typeof o, typeof undeclaredName, delete o.a, "a" in o, o instanceof Object, void 0];
T('unary', r);
