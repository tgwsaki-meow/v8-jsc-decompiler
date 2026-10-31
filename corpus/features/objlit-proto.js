// objlit-proto -- __proto__ in an object literal sets the prototype
// group=literal script sloppy  (the literal form is special-cased; the computed and shorthand forms are not)
var base = { tag: "base" };
var a = { __proto__: base };
var b = { ["__proto__"]: base };
T('literal', [Object.getPrototypeOf(a) === base, a.tag]);
T('computed', [Object.getPrototypeOf(b) === base, Object.prototype.hasOwnProperty.call(b, '__proto__')]);
