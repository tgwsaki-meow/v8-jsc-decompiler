# The two fixes, measured together

Sample: every 4th corpus file. **before** 260 files, **closure** 260 files, **both** 260 files.

| metric | before | closure | both |
|---|---:|---:|---:|
| files with a comparison | 260 | 260 | 260 |
| functions in stream A, files compared | 48677 | 48677 | 48677 |
| functions in stream B | 35927 | 35889 | 34444 |
| instructions, stream A (compared) | 1861370 | 1861370 | 1861370 |
| instructions, stream B | 1982244 | 2028417 | 1783982 |
| paired functions | 35927 | 35889 | 34444 |
| **exactly equal** | 2896 | 3097 | 3741 |
| **exactly equal, share of paired** | 8.06% | 8.63% | 10.86% |
| A-side unpaired (we emit no counterpart) | 12750 | 12788 | 14233 |
| A-side unpaired, share | 26.19% | 26.27% | 29.24% |
| B-side unpaired | 0 | 0 | 0 |
| holes our emitter marked | 511 | 755 | 21534 |
| O2 byte-identical | 0 / 257 | 0 / 257 | 0 / 257 |
| mean opcode similarity | 0.5423 | 0.6403 | 0.6760 |
| mean instruction similarity | 0.3768 | 0.4370 | 0.4669 |

## Match-rate distribution

| bucket | before | closure | both |
|---|---:|---:|---:|
| [0.0, 0.1) | 21 | 15 | 222 |
| [0.1, 0.2) | 60 | 13 | 253 |
| [0.2, 0.3) | 1227 | 150 | 314 |
| [0.3, 0.4) | 7815 | 1170 | 840 |
| [0.4, 0.5) | 7792 | 4216 | 3029 |
| [0.5, 0.6) | 7079 | 9961 | 7034 |
| [0.6, 0.7) | 4805 | 10871 | 9143 |
| [0.7, 0.8) | 3096 | 3944 | 5179 |
| [0.8, 0.9) | 1046 | 1868 | 3434 |
| [0.9, 1.0) | 90 | 252 | 889 |
| **1.0 (exact)** | 2896 | 3429 | 4107 |

## Status of each file

| status | before | closure | both |
|---|---:|---:|---:|
| `ok` | 257 | 257 | 257 |
| `decompile-timeout` | 1 | 0 | 2 |
| `decompile-failed` | 2 | 3 | 1 |

## Cause families, by functions affected

| family | before | closure | both | delta |
|---|---:|---:|---:|---:|
| `replaced-block` | 25671 | 20619 | 16779 | -8892 |
| `extra-mixed` | 10010 | 12704 | 12915 | +2905 |
| `load-form` | 132 | 11840 | 12383 | +12251 |
| `missing-mixed` | 11135 | 8600 | 8800 | -2335 |
| `extra-load-store` | 12842 | 9988 | 8349 | -4493 |
| `undefined-for-a-value` | 16726 | 8560 | 8192 | -8534 |
| `reordered-block` | 5167 | 7074 | 7806 | +2639 |
| `opcode-substitution` | 4736 | 7317 | 6751 | +2015 |
| `register-class` | 7324 | 7126 | 6487 | -837 |
| `extra-temp-materialisation` | 4896 | 4395 | 4119 | -777 |
| `missing-property-access` | 1992 | 2568 | 3080 | +1088 |
| `extra-property-access` | 3758 | 4466 | 1941 | -1817 |
| `missing-allocation` | 781 | 1457 | 1900 | +1119 |
| `missing-call` | 963 | 1760 | 1793 | +830 |
| `context-load-form` | 1766 | 1841 | 1623 | -143 |
| `operand-value` | 1026 | 1474 | 1572 | +546 |
| `extra-call` | 1776 | 922 | 1338 | -438 |
| `extra-context-load` | 48 | 1607 | 1132 | +1084 |
| `extra-allocation` | 654 | 1236 | 1039 | +385 |
| `missing-temp-materialisation` | 761 | 925 | 960 | +199 |
| `call-form` | 3059 | 3290 | 736 | -2323 |
| `missing-context-load` | 3681 | 696 | 725 | -2956 |
| `missing-load-store` | 900 | 842 | 654 | -246 |
| `constant-value` | 280 | 742 | 645 | +365 |
| `extra-control-flow` | 612 | 600 | 576 | -36 |
| `missing-context-store` | 1644 | 514 | 445 | -1199 |
| `store-form` | 4 | 393 | 417 | +413 |
| `missing-coercion` | 335 | 400 | 397 | +62 |
| `jump-target` | 299 | 356 | 350 | +51 |
| `operand-order` | 86 | 57 | 273 | +187 |
| `missing-control-flow` | 228 | 279 | 253 | +25 |
| `missing-other` | 168 | 224 | 235 | +67 |
| `a-value-for-undefined` | 225 | 266 | 202 | -23 |
| `context-store-form` | 1026 | 167 | 190 | -836 |
| `extra-other` | 150 | 184 | 179 | +29 |
| `coercion-opcode` | 57 | 92 | 94 | +37 |
| `extra-context-store` | 1 | 89 | 91 | +90 |
| `missing-generator` | 1 | 80 | 59 | +58 |
| `extra-context-push` | 34 | 33 | 55 | +21 |
| `missing-context-push` | 50 | 52 | 50 | 0 |
| `extra-coercion` | 27 | 22 | 25 | -2 |
| `undiffed-too-large` | 22 | 25 | 23 | +1 |
| `compare-opcode` | 10 | 11 | 10 | 0 |
| `missing-tdz-check` | 0 | 10 | 10 | +10 |
| `named-vs-keyed-property` | 2 | 3 | 5 | +3 |
| `register-move-form` | 3 | 3 | 4 | +1 |
| `operand-arity` | 2 | 1 | 4 | +2 |
| `extra-tdz-check` | 1 | 5 | 3 | +2 |
| `define-vs-set-property` | 598 | 663 | 1 | -597 |
| `extra-super-check` | 0 | 0 | 1 | +1 |
| `missing-super-check` | 43 | 53 | 0 | -43 |

## The top shapes now

| # | family \| shape | before | now |
|---:|---|---:|---:|
| 1 | `load-form \| LdaImmutableCurrentContextSlot -> LdaCurrentContextSlotNoCell` | 0 | 8983 |
| 2 | `register-class \| Star` | 6299 | 5514 |
| 3 | `undefined-for-a-value \| GetNamedProperty -> LdaUndefined` | 5170 | 3975 |
| 4 | `undefined-for-a-value \| LdaImmutableCurrentContextSlot -> LdaUndefined` | 5999 | 2641 |
| 5 | `extra-load-store \| LdaUndefined (+1 move)` | 2402 | 2326 |
| 6 | `reordered-block \| 2:2 Star+CallUndefinedReceiver1` | 279 | 2265 |
| 7 | `opcode-substitution \| GetNamedProperty -> CreateClosure` | 329 | 1859 |
| 8 | `load-form \| LdaImmutableContextSlot -> LdaContextSlotNoCell` | 0 | 1641 |
| 9 | `opcode-substitution \| CreateClosure -> Ldar` | 0 | 1593 |
| 10 | `load-form \| LdaImmutableCurrentContextSlot -> LdaCurrentContextSlot` | 0 | 1576 |
| 11 | `extra-mixed \| GetNamedProperty+CreateObjectLiteral (+5 move)` | 0 | 1566 |
| 12 | `undefined-for-a-value \| CreateObjectLiteral -> LdaUndefined` | 2948 | 1353 |
| 13 | `extra-property-access \| GetNamedProperty (+1 move)` | 2598 | 1204 |
| 14 | `extra-load-store \| LdaUndefined (+3 move)` | 1629 | 1181 |
| 15 | `undefined-for-a-value \| LdaImmutableContextSlot -> LdaUndefined` | 2017 | 1168 |
| 16 | `replaced-block \| 1:3 CreateObjectLiteral / LdaUndefined+StaCurrentContextSlotNoCell` | 0 | 1066 |
| 17 | `missing-property-access \| GetNamedProperty (-1 move)` | 997 | 1031 |
| 18 | `extra-load-store \| LdaUndefined (+2 move)` | 1609 | 816 |
| 19 | `reordered-block \| 3:3 Star+GetNamedProperty` | 457 | 812 |
| 20 | `undefined-for-a-value \| LdaZero -> LdaUndefined` | 911 | 800 |
| 21 | `missing-allocation \| CreateClosure (-1 move)` | 388 | 783 |
| 22 | `missing-property-access \| GetNamedProperty` | 228 | 766 |
| 23 | `extra-allocation \| CreateClosure (+1 move)` | 82 | 700 |
| 24 | `extra-load-store \| LdaUndefined (+4 move)` | 1908 | 674 |
| 25 | `register-class \| Ldar` | 639 | 654 |
| 26 | `opcode-substitution \| DefineNamedOwnProperty -> Star` | 559 | 645 |
| 27 | `reordered-block \| 2:2 Star+CallProperty1` | 0 | 597 |
| 28 | `undefined-for-a-value \| LdaGlobal -> LdaUndefined` | 692 | 591 |
| 29 | `undefined-for-a-value \| CreateArrayLiteral -> LdaUndefined` | 590 | 589 |
| 30 | `undefined-for-a-value \| LdaSmi -> LdaUndefined` | 373 | 568 |

