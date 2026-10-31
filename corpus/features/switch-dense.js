// switch-dense -- dense integer switch (jump table)
// group=switch script sloppy  (V8 emits SwitchOnSmiNoFeedback with a jump table once the cases are dense enough)
function f(x) {
  switch (x) {
    case 0: return "a";
    case 1: return "b";
    case 2: return "c";
    case 3: return "d";
    case 4: return "e";
    case 5: return "f";
    case 6: return "g";
    case 7: return "h";
    default: return "z";
  }
}
T('all', [0, 1, 2, 3, 4, 5, 6, 7, 8, -1].map(f));
