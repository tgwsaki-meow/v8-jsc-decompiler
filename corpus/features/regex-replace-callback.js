// regex-replace-callback -- regex used with replace and a callback
// group=regex script sloppy
function f(s) {
  return s.replace(/(\d)(\w)/g, function (m, a, b) {
    return b + a;
  });
}
T('replace', f('1a2b'));
