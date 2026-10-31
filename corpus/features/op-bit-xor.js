// op-bit-xor -- binary ^ (bitwise XOR)
// group=operator script sloppy
function f(a, b) {
  return a ^ b;
}
T('num', f(12, 10)); T('self', f(255, 255)); T('neg', f(-1, 0));
