// objlit-numeric-string-keys -- numeric and string literal keys
// group=literal script sloppy
var o = { 0: "z", 1.5: "f", 1e3: "k", 0x10: "h", "with space": 1, "": 2, 10n: "big" };
T('keys', Object.keys(o)); T('values', Object.keys(o).map(function (k) { return o[k]; }));
