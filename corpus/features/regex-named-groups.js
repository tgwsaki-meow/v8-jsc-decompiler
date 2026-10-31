// regex-named-groups -- named capture groups and backreferences
// group=regex script sloppy
function f(s) {
  var m = /(?<first>\w+)\s(?<second>\w+)\k<first>/.exec(s);
  return m && [m.groups.first, m.groups.second];
}
T('named', f('ab cdab')); T('none', f('zz'));
