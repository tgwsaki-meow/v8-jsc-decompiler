// regex-flag-u -- regex literal with flags "u"
// group=regex script sloppy
function f() {
  return /a+/u;
}
T('flags', f().flags); T('source', f().source);
T('unicode', f().unicode);
