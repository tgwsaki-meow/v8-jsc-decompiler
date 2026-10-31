async function f(a) { var t = 0; for await (var v of a) { t += v; } return t; }
f([1, 2]);
