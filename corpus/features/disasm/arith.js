function f(a, b) {
  var x = a + b, y = a - b, z = a * b, w = a / b, m = a % b, e = a ** b;
  var i = a | b, j = a & b, k = a ^ b, l = a << b, n = a >> b, o = a >>> b;
  var p = -a, q = ~a, r = !a, s = +a;
  x += 1; y -= 2; z *= 3; w /= 4; m %= 5; i |= 6; j &= 7; k ^= 8; l <<= 1; n >>= 1;
  return x + y + z + w + m + e + i + j + k + l + n + o + p + q + r + s;
}
f(3, 4);
