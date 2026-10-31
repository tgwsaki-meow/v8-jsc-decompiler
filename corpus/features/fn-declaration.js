// fn-declaration -- function declaration and hoisting
// group=function script sloppy
T('hoisted', f(2));
function f(a) {
  return a * 2;
}
T('after', f(3)); T('name', [f.name, f.length]);
