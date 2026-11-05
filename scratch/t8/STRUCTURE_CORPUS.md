# `src/structure/` corpus scan

Profile `profiles/14.4.258.16`, corpus `extracted_jsc`, 1 forked job(s), 1400 MB child heap.
Wall **1 s** (2888 s of child CPU).

## Totals

| metric | value |
|---|---:|
| files read | 82 / 1039 |
| files failed | 0 |
| functions (SFI with bytecode) | 15755 |
| **functions structured** | 15755 (100.0000%) |
| functions whose structuring threw | 0 |
| blocks | 92617 |
| reachable blocks | 92617 |
| region nodes built | 133085 |

## ARCHITECTURE.md 11.3 invariant 1 — every reachable, non-removed block exactly once

| metric | value |
|---|---:|
| **coverage violations** | 0 |
| violations of all of `src/structure/verify.mjs` | 0 |
| blocks placed as `{r:block}` leaves | 90296 |
| blocks consumed by a construct (loop test chains) | 474 |
| blocks in `removed` | 2201 |

### Violations by invariant

(none)

## Metric 1 — back edges that became a loop statement

ARCHITECTURE.md 10.1: the two numbers are different questions and the
obvious cross-check between them is false. 18 201 `JumpLoop`s are back
edges, 130 are in irreducible regions and **259 are forward edges** in
243 functions, because an `await` in a loop ends the body with a
*returning* `SuspendGenerator`, so one invocation's CFG is acyclic.

| metric | expected | measured |
|---|---:|---:|
| T6 back edges (before stage 1) | 18201 | 638 |
| **of those, whose target is a loop region header** | 18201 | 619 (97.0219%) |
| reachable `JumpLoop` edges | 18590 | 658 |
| of those, whose target is a loop region header | | 635 (96.5046%) |
| natural loops found over the structuring graph | | 658 |
| loop regions emitted | | 635 |

### Loop regions by form

| key | count | share |
|---|---:|---:|
| `for` | 278 | 43.7795% |
| `while` | 187 | 29.4488% |
| `forever` | 180 | 28.3465% |
| `doWhile` | 12 | 1.8898% |

### Loop plans by form (before the region tree)

| key | count |
|---|---:|
| `for` | 278 |
| `while` | 187 |
| `forever` | 181 |
| `doWhile` | 12 |

### Where the loop test sits

| metric | value |
|---|---:|
| test in the header block | 541 |
| **test below the header, on the test chain** (the leader rule split it) | 10 |
| blocks on a multi-block test chain | 39 |
| test chain rejected because it holds statements (-> `forever`) | 5 |
| header holds a statement the test does not consume (-> `doWhile`/`forever`) | 69 |
| follow taken as the first exit after the body span | 198 |
| loops with more than one exit target | 198 |
| loops with more than one latch | 0 |
| endless loops (no exit at all) | 0 |
| loops with no follow block | 0 |
| `for-in` idiom recognised | 47 |
| `for-of` idiom recognised | 0 |
| loop test-chain blocks in `removed.loopTestBlocks` | 471 |

## Metric 2 — handler ranges that became a `try`

ARCHITECTURE.md 9.1: of 25 189 ranges, 13 713 are the `await` desugaring
and must produce **no** `try`. The 5 821 CAUGHT + 5 655 UNCAUGHT ranges
are the real ones.

| metric | expected | measured |
|---|---:|---:|
| handler ranges | 25189 | 1767 |
| CAUGHT + UNCAUGHT ranges | 11476 | 767 |
| **of those, became a `try` region** | 11476 | 749 (97.6532%) |
| ASYNC_AWAIT(+UNCAUGHT_ASYNC_AWAIT) ranges | 13713 | 1000 |
| **of those, became a `try` region** | 0 | 0 |
| `try` regions emitted | | 749 |
| ranges planned as a `try` | | 767 |
| async ranges found in `tryPlans` (independent check) | 0 | 0 |
| blocks removed as the async rejection tail | | 1025 |
| `finally` token shapes recognised | | 134 |
| normal-completion tail blocks taken into a `try` body | | 610 |

### Handler ranges by prediction

| key | count | share |
|---|---:|---:|
| `ASYNC_AWAIT` | 1000 | 56.5931% |
| `CAUGHT` | 523 | 29.5982% |
| `UNCAUGHT` | 244 | 13.8087% |

### Ranges that became a `try`, by prediction

| key | count | share |
|---|---:|---:|
| `CAUGHT` | 517 | 29.2586% |
| `UNCAUGHT` | 232 | 13.1296% |

### Ranges that did NOT become a `try`, by prediction

| key | count | share |
|---|---:|---:|
| `ASYNC_AWAIT` | 1000 | 56.5931% |
| `UNCAUGHT` | 12 | 0.6791% |
| `CAUGHT` | 6 | 0.3396% |

### Why a real range was skipped

(none)

### `finally` token dispatch shapes

| key | count |
|---|---:|
| `referenceEqual` | 101 |
| `switch` | 33 |

## Stage 1 — the generator resume dispatcher

ARCHITECTURE.md 11.2 constraint 1: remove it **before** loop structuring.
10.1 measured 121 irreducible functions in the other order and 0 in this
one, so `irreducible after removal` is the number that matters.

| metric | expected | measured |
|---|---:|---:|
| `SwitchOnGeneratorState` dispatchers seen | 10068 | 705 |
| **dispatcher blocks removed** | 10068 | 705 |
| dispatcher blocks kept (reported, not silent) | 0 | 0 |
| resume edges removed | | 1013 |
| suspend -> resume splices | | 1013 |
| resume edges that could not be spliced | 0 | 0 |
| suspend points (`ir.contextChain.suspendByIdIns`) | 15276 | 1013 |
| irreducible edges BEFORE removal | 163 | 5 |
| functions irreducible BEFORE removal | 121 | 5 |
| **irreducible edges AFTER removal** | 0 | 0 |
| **functions irreducible AFTER removal** | 0 | 0 |

## `switch` — the compare chain is the main form

ARCHITECTURE.md 9.3: 11 208 jump tables in the corpus, of which only
1 140 belong to a `switch` statement; 0.35% of functions have one. The
compare chain is 99.65% of all switches, so 4.4.4 has it backwards.

| metric | expected | measured |
|---|---:|---:|
| jump tables that are a generator dispatcher | 10068 | 0 |
| **real `SwitchOnSmiNoFeedback` jump tables planned** | 1140 | 96 |
| compare chains found | | 193 |
| compare-chain links (case labels) | | 758 |
| jump-table guard blocks reported | | 68 |

### `switch` regions by form

| key | count |
|---|---:|
| `compareChain` | 192 |
| `jumpTable` | 92 |

## The fall-back (ARCHITECTURE.md 4.4.7) — reported, never hidden

| metric | value |
|---|---:|
| **`unstructured` regions** | 17 |
| blocks inside an `unstructured` region | 1036 (1.1186% of reachable blocks) |
| functions that fell back | 17 (0.1079%) |

### `unstructured` regions by `why`

| key | count | share |
|---|---:|---:|
| `stepIntoEmittedBlock` | 12 | 70.5882% |
| `labelledJoinNeverReached` | 5 | 29.4118% |

### Fall-backs by `why`

| key | count | share |
|---|---:|---:|
| `stepIntoEmittedBlock` | 12 | 70.5882% |
| `labelledJoinNeverReached` | 5 | 29.4118% |

## Shape of the output

ARCHITECTURE.md 10.6: 55.13% of corpus functions are a single basic
block, and those have to come out as one trivial `{r:block}`.

| metric | expected | measured |
|---|---:|---:|
| single-block functions | 132 290 (55.13%) | 9270 (58.8385%) |
| **of those, a single `{r:block}`** | all | 9270 (100.0000%) |
| `if` regions | | 19110 |
| `seq` regions | | 19306 |
| `break` / `continue` | | 2095 / 0 |
| labelled `break` / `continue` | | 1705 / 0 |
| labels declared | | 1122 |
| follow from Cifuentes' dominator-children rule | | 11478 |
| follow from the immediate post-dominator fall-back | | 0 |
| no follow (the region ends at its parent's) | | 8086 |

### Warnings by code

| key | count | share |
|---|---:|---:|
| `loops:loopTestBlockNotConsumedByTest` | 69 | 100.0000% |

## Fall-back samples

* `b_544background.jsc` #1448 o stepIntoEmittedBlock blocks=71 {"block":3,"from":3,"trace":["47@49:47","48@49:48","47@49:49","40@49:49","22@3:49","51@52:51","51@52:56","52@53:52","52@53:56","22@3:53","8@3:3","3@3:3","3@56:54","3@56:56","3@56:53","3@56:3"]}
* `b_background_ex.jsc` #3259 emitEventToWindow labelledJoinNeverReached blocks=63 {"chain":7,"fallOut":43,"targets":[40],"trace":["29@33:29","29@33:30","31@33:31","31@33:32","31@33:34","29@33:33","7@43:33","7@43:34","40@43:40","35@43:35","35@43:36","35@43:37","35@43:38","35@43:39","35@43:43","7@43:43"]}
* `b_background_ex.jsc` #5661  stepIntoEmittedBlock blocks=137 {"block":23,"from":1,"trace":["49@23:108","49@23:109","49@23:110","49@23:111","49@23:112","49@23:113","49@23:114","48@23:48","33@23:23","29@23:23","28@23:28","23@23:23","1@null:28","1@null:48","1@null:114","1@null:23"]}
* `p_preload_webview.jsc` #1710  labelledJoinNeverReached blocks=52 {"chain":0,"fallOut":null,"targets":[45],"trace":["32@27:27","31@27:27","26@27:27","13@5:27","29@30:29","29@30:30","28@30:28","28@30:30","13@5:30","13@5:50","6@5:5","4@5:5","0@null:5","0@null:37","0@null:39","0@null:50"]}
* `r_10076.jsc` #1073  stepIntoEmittedBlock blocks=125 {"block":15,"from":1,"trace":["121@112:121","117@112:117","117@112:118","117@112:119","117@112:120","117@112:112","112@112:112","107@122:121","107@122:122","106@122:106","106@122:122","85@null:122","85@null:123","84@null:84","1@null:70","1@null:15"]}
* `r_10114.jsc` #1315 fetchMarketEmoticonList labelledJoinNeverReached blocks=51 {"chain":1,"fallOut":null,"targets":[33,20],"trace":["34@3:42","34@3:43","34@3:44","34@3:45","34@3:46","34@3:47","34@3:3","33@3:33","21@3:3","20@3:20","10@3:3","8@3:8","6@3:3","1@null:8","1@null:9","1@null:48"]}
* `r_10114.jsc` #2893 loadMore labelledJoinNeverReached blocks=73 {"chain":1,"fallOut":null,"targets":[62],"trace":["56@60:60","21@10:60","21@10:62","6@10:10","1@null:10","1@null:11","1@null:12","1@null:13","1@null:14","1@null:15","1@null:16","1@null:17","1@null:18","1@null:19","1@null:20","1@null:70"]}
* `r_10249.jsc` #456 u stepIntoEmittedBlock blocks=28 {"block":8,"from":2,"trace":["18@24:19","20@19:20","22@19:22","22@19:19","21@19:21","21@19:26","20@19:19","18@24:23","18@24:26","17@24:24","2@null:24","26@null:26","25@null:25","25@null:26","2@null:26","2@null:8"]}
* `r_10249.jsc` #681 a stepIntoEmittedBlock blocks=12 {"block":4,"from":0,"trace":["1@3:3","0@null:3","0@null:4","5@4:5","6@7:6","10@7:10","6@7:7","5@4:7","9@4:9","9@4:10","8@4:8","8@4:10","5@4:4","0@null:11","0@null:10","0@null:4"]}
* `r_10249.jsc` #758 d stepIntoEmittedBlock blocks=37 {"block":13,"from":0,"trace":["25@24:24","23@31:28","29@30:29","29@30:30","23@31:30","23@31:35","22@31:31","0@null:31","35@null:35","32@null:32","33@34:33","33@34:34","32@null:34","32@null:35","0@null:35","0@null:13"]}
* `r_10522.jsc` #135 t stepIntoEmittedBlock blocks=15 {"block":4,"from":0,"trace":["7@11:7","9@10:9","9@10:10","8@10:8","8@10:10","7@11:10","7@11:13","6@11:11","5@4:11","13@4:13","12@4:12","12@4:13","5@4:4","0@null:14","0@null:13","0@null:4"]}
* `r_10559.jsc` #162 m stepIntoEmittedBlock blocks=147 {"block":83,"from":83,"trace":["111@120:120","92@123:120","122@123:122","122@123:125","121@123:121","121@123:128","92@123:123","91@123:123","88@83:123","88@83:124","88@83:125","83@83:83","83@128:126","83@128:128","83@128:125","83@128:83"]}
* `r_10797.jsc` #1107 d stepIntoEmittedBlock blocks=37 {"block":13,"from":0,"trace":["25@24:24","23@31:28","29@30:29","29@30:30","23@31:30","23@31:35","22@31:31","0@null:31","35@null:35","32@null:32","33@34:33","33@34:34","32@null:34","32@null:35","0@null:35","0@null:13"]}
* `r_11203.jsc` #34 s stepIntoEmittedBlock blocks=44 {"block":4,"from":0,"trace":["20@18:20","22@23:22","22@23:23","21@23:21","21@23:23","20@18:23","24@25:24","26@25:26","26@25:27","24@25:25","20@18:25","20@18:27","19@18:18","0@null:43","0@null:16","0@null:4"]}
* `r_11825.jsc` #55 n stepIntoEmittedBlock blocks=15 {"block":4,"from":0,"trace":["7@11:7","9@10:9","9@10:10","8@10:8","8@10:10","7@11:10","7@11:13","6@11:11","5@4:11","13@4:13","12@4:12","12@4:13","5@4:4","0@null:14","0@null:13","0@null:4"]}
* `r_12084.jsc` #817 handleGameCenterPubTopBarClick labelledJoinNeverReached blocks=39 {"chain":0,"fallOut":null,"targets":[36],"trace":["20@34:27","20@34:28","20@34:29","20@34:30","20@34:31","20@34:32","20@34:34","33@34:33","19@34:34","2@35:34","2@35:36","35@37:35","35@37:36","37@38:37","37@38:38","0@null:38"]}
* `r_12217.jsc` #801 confirmCallback stepIntoEmittedBlock blocks=110 {"block":12,"from":8,"trace":["63@null:64","63@null:65","69@null:69","69@null:70","69@null:71","69@null:72","69@null:73","69@null:74","69@null:75","66@null:66","66@null:67","66@null:68","66@null:75","62@null:62","8@null:75","8@null:12"]}

## Back edges with no loop region

* `b_544background.jsc` #1448 o edge 36 -> 25
* `b_544background.jsc` #1448 o edge 53 -> 3
* `b_background_ex.jsc` #3259 emitEventToWindow edge 40 -> 7
* `r_10076.jsc` #1073  edge 120 -> 112
* `r_10249.jsc` #456 u edge 22 -> 19
* `r_10249.jsc` #456 u edge 26 -> 8
* `r_10249.jsc` #681 a edge 10 -> 4
* `r_10249.jsc` #758 d edge 27 -> 24
* `r_10249.jsc` #758 d edge 35 -> 13
* `r_10522.jsc` #135 t edge 13 -> 4
* `r_10559.jsc` #162 m edge 67 -> 5
* `r_10559.jsc` #162 m edge 107 -> 98
* `r_10559.jsc` #162 m edge 125 -> 83
* `r_10797.jsc` #1107 d edge 27 -> 24
* `r_10797.jsc` #1107 d edge 35 -> 13
* `r_11203.jsc` #34 s edge 16 -> 4
* `r_11203.jsc` #34 s edge 38 -> 32
* `r_11203.jsc` #34 s edge 42 -> 18
* `r_11825.jsc` #55 n edge 13 -> 4

## Slowest functions

| file | unit | blocks | ms |
|---|---|---:|---:|
| `p_preload_qq_browser_mixed.jsc` | 272 ne | 8 | 13968 |
| `p_preload_qq_browser_mixed.jsc` | 1292 ve | 3 | 11573 |
| `r_10797.jsc` | 1107 d | 37 | 9682 |
| `r_11142.jsc` | 17 29459 | 1 | 8963 |
| `r_10953.jsc` | 1  | 1 | 8489 |
| `p_preload_qq_browser_simple.jsc` | 3466  | 1 | 8460 |
| `r_10797.jsc` | 6238 handleGrabState | 26 | 8131 |
| `r_10797.jsc` | 3724  | 12 | 8045 |
| `b_background_ex.jsc` | 17765  | 9 | 7932 |
| `r_10797.jsc` | 555 88726 | 21 | 7717 |
| `b_background_ex.jsc` | 14161 getHashIdByExUin | 63 | 7515 |
| `r_1358.jsc` | 477 get contactName | 47 | 7246 |

