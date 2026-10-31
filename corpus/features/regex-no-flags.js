// regex-no-flags -- regex literal with flags ""
// group=regex script sloppy
function f() {
  return /a+/;
}
T('flags', f().flags); T('source', f().source);
T('match', f('aAa'));
