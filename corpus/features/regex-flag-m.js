// regex-flag-m -- regex literal with flags "m"
// group=regex script sloppy
function f() {
  return /a+/m;
}
T('flags', f().flags); T('source', f().source);
T('multiline', 'x\na'.split(f()).length);
