// flat-switch-fallthrough -- switch with fallthrough in top-level code
// group=flat script sloppy
var out = [];
for (var i = 0; i < 4; i++) {
  switch (i) {
    case 0:
      out.push(0);
    case 1:
      out.push(1);
      break;
    case 2:
      out.push(2);
    default:
      out.push("d");
  }
}
T('fallthrough', out);
