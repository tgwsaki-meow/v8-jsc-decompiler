# src/structure self-test

profiles: 14.4.258.16, 14.6.202.34

| group | check | result | detail |
|---|---|---|---|
| A | src/structure imports nothing from src/verify/ or tools/ | PASS | only src/ir, src/profile, src/disasm |
| A | every import of src/structure resolves inside the allowed layers | PASS | all imports are ./ or ../{ir,profile,disasm,listing}/ |
| A | no version literal, hex literal or 3+-digit number in src/structure | PASS | clean |
| A | no opcode compared by value, and every named opcode is checked against the profile | PASS | facts.mjs names 10 opcodes, nothing else names any |
| B | 14.4.258.16: structureFacts is total (predicates, named opcodes, one Smi switch) | PASS | 22 conditional jumps all have a predicate, 10 named opcodes present |
| B | 14.4.258.16: canThrow agrees with src/ir/cfg.mjs's own exception-edge test | PASS | identical on every opcode |
| B | 14.6.202.34: structureFacts is total (predicates, named opcodes, one Smi switch) | PASS | 22 conditional jumps all have a predicate, 10 named opcodes present |
| B | 14.6.202.34: canThrow agrees with src/ir/cfg.mjs's own exception-edge test | PASS | identical on every opcode |
| C | 14.4.258.16: while: the test is in the header, follow is the block after the loop | PASS | 4 blocks, 5 regions |
| C | 14.4.258.16: while whose test the leader rule split off the header (the async shape) | PASS | 8 blocks, 8 regions |
| C | 14.4.258.16: do-while: the body is ahead of the test and the latch is only the JumpLoop | PASS | 4 blocks, 7 regions |
| C | 14.4.258.16: for: the latch is a dedicated continue target with two in-body predecessors | PASS | 6 blocks, 9 regions |
| C | 14.4.258.16: if / else if / else: nested ifs, one join, nothing unstructured | PASS | 6 blocks, 10 regions |
| C | 14.4.258.16: switch as a jump table: one switch region, every case a body | PASS | 7 blocks, 15 regions |
| C | 14.4.258.16: switch as a compare chain (9.3: 99.65% of real switches) | PASS | 9 blocks, 17 regions |
| C | 14.4.258.16: try / catch: one try region, the caught value is the catch parameter | PASS | 5 blocks, 8 regions |
| C | 14.4.258.16: try / finally: the one-command token form is recognised (4.4.5 misses it) | PASS | 9 blocks, 13 regions |
| C | 14.4.258.16: generator: the resume dispatcher is deleted and each suspend spliced | PASS | 6 blocks, 8 regions |
| C | 14.4.258.16: await inside a loop: the loop only exists after the suspend is spliced (10.1) | PASS | 6 blocks, 7 regions |
| C | 14.4.258.16: irreducible with no dispatcher: falls back honestly and counts it (4.4.7) | PASS | 5 blocks, 1 regions |
| C | 14.6.202.34: while: the test is in the header, follow is the block after the loop | PASS | 4 blocks, 5 regions |
| C | 14.6.202.34: while whose test the leader rule split off the header (the async shape) | PASS | 8 blocks, 8 regions |
| C | 14.6.202.34: do-while: the body is ahead of the test and the latch is only the JumpLoop | PASS | 4 blocks, 7 regions |
| C | 14.6.202.34: for: the latch is a dedicated continue target with two in-body predecessors | PASS | 6 blocks, 9 regions |
| C | 14.6.202.34: if / else if / else: nested ifs, one join, nothing unstructured | PASS | 6 blocks, 10 regions |
| C | 14.6.202.34: switch as a jump table: one switch region, every case a body | PASS | 7 blocks, 15 regions |
| C | 14.6.202.34: switch as a compare chain (9.3: 99.65% of real switches) | PASS | 9 blocks, 17 regions |
| C | 14.6.202.34: try / catch: one try region, the caught value is the catch parameter | PASS | 5 blocks, 8 regions |
| C | 14.6.202.34: try / finally: the one-command token form is recognised (4.4.5 misses it) | PASS | 9 blocks, 13 regions |
| C | 14.6.202.34: generator: the resume dispatcher is deleted and each suspend spliced | PASS | 6 blocks, 8 regions |
| C | 14.6.202.34: await inside a loop: the loop only exists after the suspend is spliced (10.1) | PASS | 6 blocks, 7 regions |
| C | 14.6.202.34: irreducible with no dispatcher: falls back honestly and counts it (4.4.7) | PASS | 5 blocks, 1 regions |
| D | while (loop-while.jsc) | PASS | 4 blocks, 5 regions, loops={"while":1}, try=0 |
| D | do-while (loop-do-while.jsc) | PASS | 4 blocks, 7 regions, loops={"doWhile":1}, try=0 |
| D | for (3-clause) (loop-for-3clause.jsc) | PASS | 4 blocks, 5 regions, loops={"while":1}, try=0 |
| D | for-in (loop-for-in.jsc) | PASS | 7 blocks, 12 regions, loops={"for":1}, try=0 |
| D | for-of (loop-for-of.jsc) | PASS | 25 blocks, 45 regions, loops={"forever":1}, try=2 |
| D | for-of with break (loop-for-of-break.jsc) | PASS | 27 blocks, 51 regions, loops={"forever":1}, try=2 |
| D | while with continue (loop-while-continue.jsc) | PASS | 7 blocks, 10 regions, loops={"for":1}, try=0 |
| D | nested loops (loop-nested.jsc) | PASS | 7 blocks, 9 regions, loops={"while":2}, try=0 |
| D | labelled break (label-break.jsc) | PASS | 6 blocks, 11 regions, loops={"while":1}, try=0 |
| D | labelled break out of two loops (label-break-multi.jsc) | PASS | 11 blocks, 21 regions, loops={"for":1,"while":1}, try=0 |
| D | labelled continue (label-continue.jsc) | PASS | 7 blocks, 10 regions, loops={"for":1}, try=0 |
| D | labelled continue across three loops (label-continue-multi.jsc) | PASS | 14 blocks, 25 regions, loops={"for":2,"while":1}, try=0 |
| D | switch with a jump table (dense Smi cases) (switch-dense.jsc) | PASS | 15 blocks, 25 regions, loops={}, try=0 |
| D | switch as a compare chain (sparse cases) (switch-sparse.jsc) | PASS | 8 blocks, 10 regions, loops={}, try=0 |
| D | switch on strings is a compare chain (switch-string.jsc) | PASS | 8 blocks, 10 regions, loops={}, try=0 |
| D | switch with fall-through between cases (switch-fallthrough.jsc) | PASS | 9 blocks, 13 regions, loops={}, try=0 |
| D | switch with default in the middle (switch-default-middle.jsc) | PASS | 7 blocks, 13 regions, loops={}, try=0 |
| D | switch with no default (switch-no-default.jsc) | PASS | 6 blocks, 10 regions, loops={}, try=0 |
| D | try / catch (try-catch.jsc) | PASS | 7 blocks, 12 regions, loops={}, try=1 |
| D | try / finally (try-finally.jsc) | PASS | 13 blocks, 19 regions, loops={}, try=1 |
| D | try / catch / finally (try-catch-finally.jsc) | PASS | 18 blocks, 27 regions, loops={}, try=2 |
| D | nested try, four deep (try-nested.jsc) | PASS | 27 blocks, 41 regions, loops={}, try=4 |
| D | async function (async-function.jsc) | PASS | 11 blocks, 12 regions, loops={}, try=0 |
| D | await inside a loop (async-await-in-loop.jsc) | PASS | 32 blocks, 35 regions, loops={"while":2}, try=0 |
| E | every fixture: 0 invariant violations and nothing unstructured | PASS | 24 files, 80 functions, 0 violations, 0 fall-backs |
| E | every fixture: no try region for an ASYNC_AWAIT range (11.2 constraint 3) | PASS | 15 ranges, 2 ASYNC_AWAIT, 13 try regions, 0 of them async |
| E | every fixture: the structuring graph is reducible after stage 1 | PASS | 0 irreducible edges before stage 1, 0 after |
| E | a single-block function is one {r:block} leaf (10.6: 55.13% of the corpus) | PASS | 55/55 single-block functions are one leaf |
| E | structure() is deterministic: two runs give the same tree and the same labels | PASS | 5 files, identical on a second run |
| E | every Test names an SSA value of the function, or says it has none | PASS | 73 Tests, all resolvable |
| E | no region carries an expression (11.2: T8 only names SSA values) | PASS | no Expr or Stmt anywhere in a region tree |

**63 passed, 0 failed**
