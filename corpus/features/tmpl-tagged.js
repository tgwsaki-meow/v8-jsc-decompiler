// tmpl-tagged -- tagged template literal
// group=template script sloppy  (GetTemplateObject: the strings array is cached per call site)
var seen = [];
function tag(strings, ...values) {
  seen.push(strings === seen.last);
  seen.last = strings;
  return [strings.slice(), strings.raw.slice(), values];
}
function f(a) {
  return tag`a${a}b${a + 1}c`;
}
T('first', f(1)); T('second', f(2)); T('cached', seen.slice(0, 2));
