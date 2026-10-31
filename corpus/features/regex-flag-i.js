// regex-flag-i -- regex literal with flags "i"
// group=regex script sloppy
function f() {
  return /a+/i;
}
T('flags', f().flags); T('source', f().source);
T('ci', f().test('A'));
