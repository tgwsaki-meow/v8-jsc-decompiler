// flat-switch-dense -- dense switch in top-level code (jump table)
// group=flat script sloppy
var out = [];
for (var i = 0; i < 9; i++) {
  switch (i) {
    case 0: out.push("a"); break;
    case 1: out.push("b"); break;
    case 2: out.push("c"); break;
    case 3: out.push("d"); break;
    case 4: out.push("e"); break;
    case 5: out.push("f"); break;
    case 6: out.push("g"); break;
    case 7: out.push("h"); break;
    default: out.push("z");
  }
}
T('switch', out);
