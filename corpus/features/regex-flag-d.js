// regex-flag-d -- regex literal with flags "d"
// group=regex script sloppy
function f() {
  return /a+/d;
}
T('flags', f().flags); T('source', f().source);
T('indices', f().hasIndices);
