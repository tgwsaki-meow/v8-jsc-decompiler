function f(a) {
  var t = 0;
  switch (a) {
    case 10: t += 1;
    case 11: t += 2; break;
    case 12: t += 3;
    case 13:
    case 14: t += 4; break;
    case 15: t += 5;
    case 16: t += 6;
    case 17: t += 7; break;
    case 18: t += 8; break;
    case 19: t += 9; break;
    default: t -= 1;
  }
  return t;
}
f(12);
