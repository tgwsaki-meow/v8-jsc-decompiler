// fn-arrow-expression-body -- arrow function with an expression body
// group=function script sloppy
var f = (a, b) => a + b;
var g = a => a * 2;
var h = () => 42;
T('two', f(1, 2)); T('one', g(3)); T('none', h()); T('name', [f.name, f.length]);
