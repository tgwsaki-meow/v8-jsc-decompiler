# src/ir self-test

profiles: 14.4.258.16, 14.6.202.34

| group | check | result | detail |
|---|---|---|---|
| A | no version-specific literal in src/ir/ | PASS | 11 files clean |
| A | no opcode value, operand width or root index written down | PASS | no numeric opcode comparison |
| B | 14.4.258.16: every opcode is named in the EFFECTS table | PASS | 212 opcodes classified |
| B | 14.4.258.16: EFFECTS names no opcode the profile does not have | PASS | exact |
| B | 14.4.258.16: register read/write roles come from the operand-type lists | PASS | kReg/kRegOut/kRegInOut all correct |
| B | 14.4.258.16: hasEffect and allocatesIdentity are consistent with the row | PASS | 212 opcodes consistent |
| B | 14.4.258.16: the context header length is derived, and the profile gap is reported | PASS | MIN_CONTEXT_SLOTS=2 extended=3 source=profile layouts.json enums.ContextSlot |
| B | 14.6.202.34: every opcode is named in the EFFECTS table | PASS | 212 opcodes classified |
| B | 14.6.202.34: EFFECTS names no opcode the profile does not have | PASS | exact |
| B | 14.6.202.34: register read/write roles come from the operand-type lists | PASS | kReg/kRegOut/kRegInOut all correct |
| B | 14.6.202.34: hasEffect and allocatesIdentity are consistent with the row | PASS | 212 opcodes consistent |
| B | 14.6.202.34: the context header length is derived, and the profile gap is reported | PASS | MIN_CONTEXT_SLOTS=2 extended=3 source=profile layouts.json enums.ContextSlot |
| C | diamond: idom matches the brute-force oracle | PASS | idom=[0,0,0,0] |
| C | diamond: ipdom matches the brute-force oracle | PASS | ipdom=[3,3,3,E] virtual=0 |
| C | diamond: dominance frontiers | PASS | frontiers agree with the definition |
| C | diamond: loops, nesting and reducibility | PASS | 0 loop(s), 0 irreducible, depths [] |
| C | nestedLoop: idom matches the brute-force oracle | PASS | idom=[0,0,1,2,3,1] |
| C | nestedLoop: ipdom matches the brute-force oracle | PASS | ipdom=[1,5,3,4,1,E] virtual=0 |
| C | nestedLoop: dominance frontiers | PASS | frontiers agree with the definition |
| C | nestedLoop: loops, nesting and reducibility | PASS | 2 loop(s), 0 irreducible, depths [0,1] |
| C | multiExitLoop: idom matches the brute-force oracle | PASS | idom=[0,0,1,2,1,2,1] |
| C | multiExitLoop: ipdom matches the brute-force oracle | PASS | ipdom=[1,6,6,1,6,6,E] virtual=0 |
| C | multiExitLoop: dominance frontiers | PASS | frontiers agree with the definition |
| C | multiExitLoop: loops, nesting and reducibility | PASS | 1 loop(s), 0 irreducible, depths [0] |
| C | irreducible: idom matches the brute-force oracle | PASS | idom=[0,0,0,1] |
| C | irreducible: ipdom matches the brute-force oracle | PASS | ipdom=[1,3,1,E] virtual=0 |
| C | irreducible: dominance frontiers | PASS | frontiers agree with the definition |
| C | irreducible: loops, nesting and reducibility | PASS | 0 loop(s), 1 irreducible, depths [] |
| C | switchFanOut: idom matches the brute-force oracle | PASS | idom=[0,0,0,0,0,0,0,0] |
| C | switchFanOut: ipdom matches the brute-force oracle | PASS | ipdom=[7,7,7,7,7,7,7,E] virtual=0 |
| C | switchFanOut: dominance frontiers | PASS | frontiers agree with the definition |
| C | switchFanOut: loops, nesting and reducibility | PASS | 0 loop(s), 0 irreducible, depths [] |
| C | endlessLoop: idom matches the brute-force oracle | PASS | idom=[0,0,1] |
| C | endlessLoop: ipdom matches the brute-force oracle | PASS | ipdom=[1,2,E] virtual=1 |
| C | endlessLoop: dominance frontiers | PASS | frontiers agree with the definition |
| C | endlessLoop: loops, nesting and reducibility | PASS | 1 loop(s), 0 irreducible, depths [0] |
| D | diamond: one phi for the accumulator at the join | PASS | 4 blocks, phi r0 arity 2, edges fallthrough/false/true/unconditional |
| D | loop: a phi at the header, a back edge, and the latch found | PASS | 1 loop, 1 latch, phi r0 at the header, 1 back edge |
| D | nested try: innermost-first handler lookup and the exception edges | PASS | 2 handlers, 3 exception edges, innermost-first, CaughtException at both |
| D | exception edges leave the throwing instruction, not the block | PASS | 2 exception predecessors, phi r1 with distinct operands (v9, v12) |
| D | switch fan-out: a jump table with five cases and a fall-through | PASS | 5 switch edges + fall-through, join phi arity 6 |
| D | generator dispatcher: resume points are ordinary multi-predecessor joins | PASS | 2 resume edges onto ResumeGenerator leaders, suspends terminate, continuation phi arity 2 |
| D | finally token dispatch: SwitchOnSmiNoFeedback on a saved token register | PASS | UNCAUGHT range, token phi at the cleanup join, 2 token dispatch edges |
| D | effect order: a total order per block, merged across blocks | PASS | chain GetNamedProperty -> SetNamedProperty, pure allocation excluded, effect phi at the join |
| D | the incoming new.target / generator register is an ordinary local | PASS | r2 is a FrameEntry local with 2 uses |
| D | context slots resolve against a hand-built scope chain | PASS | depth 0/1/1/2 -> f, d, e, c |
| D | PushContext / PopContext move the depth baseline | PASS | before/inside/depth-1/after -> captured, inBlock, captured, captured |
| E | diamond: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 4 blocks, 4 edges, 1 phis, 0 loops |
| E | nested loop: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 7 blocks, 8 edges, 2 phis, 2 loops |
| E | loop with two exits: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 6 blocks, 6 edges, 1 phis, 1 loops |
| E | switch fan-out: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 6 blocks, 8 edges, 1 phis, 0 loops |
| E | nested try: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 6 blocks, 6 edges, 0 phis, 0 loops |
| E | generator dispatcher: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 6 blocks, 6 edges, 1 phis, 0 loops |
| E | finally token dispatch: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 10 blocks, 10 edges, 2 phis, 0 loops |
| E | endless loop: all structural invariants, with the brute-force oracles | PASS | 17 invariants, 1 blocks, 1 edges, 0 phis, 1 loops |
| E | the disassembler and the assembler agree on every jump target | PASS | 8 cases, every target is a label |

56 passed, 0 failed
