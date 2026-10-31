// destr-computed-key -- computed property key in a destructuring pattern
// group=destructuring script sloppy
var log = [];
function k() {
  log.push("k");
  return "a";
}
function f(o) {
  var { [k()]: v } = o;
  return v;
}
T('computed', f({ a: 5 })); T('log', log.slice());
