// fn-arrow-this -- arrow function capturing this and arguments lexically
// group=function script sloppy
function outer() {
  var self = this;
  var arrow = () => [this === self, arguments.length];
  return arrow();
}
T('bound', outer.call({ tag: 1 }, 'a', 'b'));
