// tmpl-multiline -- multiline template and escapes
// group=template script sloppy
function f() {
  return `line1
line2\t\\${1}`;
}
T('multiline', f()); T('len', f().length);
