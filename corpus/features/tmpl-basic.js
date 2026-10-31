// tmpl-basic -- template literal with substitutions
// group=template script sloppy
function f(a, b) {
  return `x${a}y${a + b}z`;
}
T('subst', f(1, 2)); T('empty', `${''}`); T('noSubst', `plain`);
