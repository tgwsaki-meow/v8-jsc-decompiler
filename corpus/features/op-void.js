// op-void -- void
// group=operator script sloppy
function f(a) {
  return void a;
}
T('num', f(1)); T('call', void (0, 1));
