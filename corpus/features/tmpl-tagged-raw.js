// tmpl-tagged-raw -- tagged template raw strings with escapes
// group=template script sloppy
function tag(s) {
  return [s[0], s.raw[0]];
}
T('raw', tag`a\nb`); T('invalidEscape', (function (s) { return [s[0], s.raw[0]]; })`\unicode`);
