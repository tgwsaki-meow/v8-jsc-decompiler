// newtarget-arrow -- new.target is lexical in arrows
// group=new-target script sloppy
function f() {
  var a = () => new.target;
  return a() === f ? "outer-new" : String(a());
}
T('called', f()); T('constructed', new f());
