// destr-rest-array -- array rest element
// group=destructuring script sloppy
function f(a) {
  var [head, ...tail] = a;
  return [head, tail];
}
T('many', f([1, 2, 3])); T('one', f([1]));
