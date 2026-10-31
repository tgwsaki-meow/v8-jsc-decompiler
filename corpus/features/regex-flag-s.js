// regex-flag-s -- regex literal with flags "s"
// group=regex script sloppy
function f() {
  return /a+/s;
}
T('flags', f().flags); T('source', f().source);
T('dotall', /a.b/s.test('a\nb'));
