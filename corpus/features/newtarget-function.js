// newtarget-function -- new.target in a function
// group=new-target script sloppy
function f() {
  return new.target === f ? "new" : new.target === undefined ? "call" : "other";
}
T('new', new f() instanceof f ? 'constructed' : 'x'); T('direct', f()); T('viaNew', (function () { var r; function g() { r = new.target && new.target.name; } new g(); return r; })());
