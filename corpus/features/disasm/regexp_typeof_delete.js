function f(s, o) {
  var re = /a(b)c/gi;
  var t = typeof s === 'string' && typeof o === 'object' && typeof undefinedGlobalXyz === 'undefined';
  delete o.a;
  delete o['b'];
  return re.test(s) + t + ('c' in o) + void 0;
}
f('abc', {a: 1, b: 2});
