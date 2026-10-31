// op-bit-and -- binary & (bitwise AND)
// group=operator script sloppy
function f(a, b) {
  return a & b;
}
T('num', f(12, 10)); T('neg', f(-1, 255)); T('big', f(0x7fffffff, 1));
