// numeric-separators -- numeric separators and every literal radix
// group=numeric script sloppy
var ns = [1_000_000, 0b1010_1010, 0o7_7, 0x1_F, 1_0.5_5, 1e1_0, .5, 5., 0.0001, 1e-7, 0xFFFFFFFF, 2 ** 53];
T('values', ns); T('legacyOctal', (function () { return 0o10; })());
