// flat-if-else -- if/else-if chain in top-level code
// group=flat script sloppy
var out = [];
for (var i = 0; i < 5; i++) {
  if (i === 0) {
    out.push("zero");
  } else if (i < 3) {
    out.push("small");
  } else {
    out.push("big");
  }
}
T('ifElse', out);
