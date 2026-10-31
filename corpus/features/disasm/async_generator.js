async function* f(a) { for (var v of a) { yield await v; } }
f([1, 2]).next();
