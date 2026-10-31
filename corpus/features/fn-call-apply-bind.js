// fn-call-apply-bind -- call / apply / bind receivers
// group=function script sloppy
function f(a, b) {
  return [this && this.tag, a, b];
}
var bound = f.bind({ tag: "b" }, 1);
T('call', f.call({ tag: 'c' }, 1, 2)); T('apply', f.apply({ tag: 'a' }, [3, 4])); T('bound', bound(5)); T('name', bound.name);
