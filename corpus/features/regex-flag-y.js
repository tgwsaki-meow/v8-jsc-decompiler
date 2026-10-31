// regex-flag-y -- regex literal with flags "y"
// group=regex script sloppy
function f() {
  return /a+/y;
}
T('flags', f().flags); T('source', f().source);
T('sticky', f().sticky);
