// regex-flag-g -- regex literal with flags "g"
// group=regex script sloppy
function f() {
  return /a+/g;
}
T('flags', f().flags); T('source', f().source);
T('all', 'aAa'.match(f())); T('lastIndex', f().lastIndex);
