function tag(s) { return s.raw.length; }
function f(a) { return tag`x${a}y` + `plain${a}` + String.raw`r${a}`; }
f(1);
