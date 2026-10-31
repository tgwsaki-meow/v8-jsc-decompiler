function f(o, k) {
  var a = {...o};
  for (var x in o) { if (x === k) { delete o[x]; } }
  return Object.keys(a).length + (o instanceof Object);
}
f({a: 1}, 'a');
