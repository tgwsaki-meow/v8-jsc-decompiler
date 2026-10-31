// flat-objlit -- object and array literals in top-level code, mutated in place
// group=flat script sloppy  (the module-cache shape: one object created, stored, mutated, read back -- metric 8 is exactly this)
var cache = {};
var key = "k";
cache[key] = { id: 1, loaded: false };
cache[key].loaded = true;
cache[key].extra = [1, 2, 3];
var same = cache[key] === cache[key];
T('identity', [cache[key].id, cache[key].loaded, cache[key].extra.length, same]);
