// src/disasm/opcode_facts.mjs
//
// Everything the decoder needs to know about an opcode, DERIVED FROM THE
// PROFILE and nothing else, computed once per profile and memoised.
//
// The three classifications below replace the string-prefix guesses in
// src/lifter.js. Each is derived from operand *types* and then cross-checked
// against a second, independent signal; a disagreement throws instead of
// silently mis-decoding, because every one of these drives a jump edge.
//
// 1. PREFIXES.  bytecodes.json names them and gives their scale.
//
// 2. SHORT STAR.  bytecodes.json carries `shortStarRange`, the span of the
//    SHORT_STAR_BYTECODE_LIST block. V8 maps the opcode back to a register with
//
//        Register::FromShortStar(bc) = Register(kStar0 - bc)
//                                      -- src/interpreter/bytecode-register.h
//
//    which we reproduce by reading the index out of the opcode's own name and
//    cross-checking it against that arithmetic.
//
// 3. JUMPS.  V8's predicates are opcode-value ranges:
//
//        IsJump(bc)          = bc >= kJumpLoop && bc <= kJumpIfForInDone
//        IsJumpImmediate(bc) = bc == kJump || bc == kJumpLoop
//                              || IsConditionalJumpImmediate(bc)
//        IsJumpConstant(bc)  = bc >= kJumpConstant
//                              && bc <= kJumpIfToBooleanFalseConstant
//        IsForwardJump(bc)   = bc >= kJump && bc <= kJumpIfForInDone
//                                      -- src/interpreter/bytecodes.h
//
//    i.e. the whole family is one contiguous block, the jump-immediate members
//    are exactly the ones taking kUImm as operand 0, and the single backward
//    jump (kJumpLoop) sits at the bottom of the block, just below kJump. So:
//
//      jumpImmediate := { op : op.operands[0] == kUImm }
//      block         := [min(jumpImmediate.value), max(jumpImmediate.value)]
//      jumpConstant  := { op in block : op.operands[0] == kConstantPoolIndex }
//      backward      := the member of the block with the lowest opcode value
//
//    In every profile to date `jumpImmediate` is exactly the 13 jump-immediate
//    bytecodes and no other opcode takes kUImm in position 0, which is what
//    makes step 1 a derivation rather than a guess. Cross-checks: the block
//    must be exactly jumpImmediate + jumpConstant, the backward jump must be
//    the unique jump carrying a loop-depth kImm and a kFeedbackSlot
//    (`JumpLoop [kUImm, kImm, kFeedbackSlot]`), and the block must coincide
//    with the set of opcodes whose name begins with `Jump`.
//
// 4. SWITCHES.  IsSwitch(bc) = bc == kSwitchOnSmiNoFeedback
//                              || bc == kSwitchOnGeneratorState,
//    an enumeration rather than a range, and the two have *different* operand
//    orders. Members are found by name prefix `SwitchOn`; their three
//    jump-table operands are then located BY TYPE, exactly as
//    BytecodeArrayIterator::GetJumpTableTargetOffsets() does:
//        table start  <- the kConstantPoolIndex operand
//        table length <- the kUImm operand
//        case base    <- the kImm operand, or 0 when absent
//    (SwitchOnSmiNoFeedback [kConstantPoolIndex, kUImm, kImm];
//     SwitchOnGeneratorState [kReg, kConstantPoolIndex, kUImm], base 0.)

const cache = new WeakMap();

/** Registers represented by one register operand, from the type's own name. */
function registersPerOperand(type) {
  if (/List$/.test(type)) return null;      // variable: paired with kRegCount
  if (/Triple$/.test(type)) return 3;
  if (/Pair$/.test(type)) return 2;
  return 1;
}

export function opcodeFacts(profile) {
  let f = cache.get(profile);
  if (!f) { f = build(profile); cache.set(profile, f); }
  return f;
}

function build(profile) {
  const bc = profile.tables.bytecodes;
  const ops = Object.values(bc.byValue).sort((a, b) => a.value - b.value);
  const problems = [];

  // ---------------------------------------------------------------- prefixes
  /** @type {Map<number, {scale:number, name:string}>} */
  const prefixByByte = new Map();
  for (const [name, p] of Object.entries(bc.prefixes ?? {})) {
    prefixByByte.set(p.value, { scale: p.scale, name });
  }
  if (prefixByByte.size === 0) problems.push('bytecodes.json carries no operand-scaling prefixes');
  const scales = [1, ...new Set([...prefixByByte.values()].map((p) => p.scale))].sort((a, b) => a - b);

  // ------------------------------------------------------------- short star
  const ssr = bc.shortStarRange ?? null;
  /** @type {Map<number, number>} opcode value -> local register index */
  const shortStarIndex = new Map();
  if (ssr) {
    const star0 = profile.getOpcode(ssr.lastName);
    for (let v = ssr.first; v <= ssr.last; v++) {
      const op = profile.getOpcode(v);
      const m = /^Star(\d+)$/.exec(op?.name ?? '');
      if (!m) { problems.push(`shortStarRange covers opcode ${v} (${op?.name}) which is not StarN`); continue; }
      const byName = Number(m[1]);
      const byArith = star0 ? star0.value - v : null;
      if (byArith !== null && byArith !== byName) {
        problems.push(`short star ${op.name}: name says r${byName} but kStar0-opcode says r${byArith}`);
      }
      shortStarIndex.set(v, byName);
    }
    if (shortStarIndex.size !== ssr.count) {
      problems.push(`shortStarRange.count is ${ssr.count} but ${shortStarIndex.size} StarN opcodes were found`);
    }
  }
  const longStar = profile.getOpcode('Star');
  if (shortStarIndex.size && !longStar) problems.push('profile has short-star opcodes but no long-form Star');

  // ------------------------------------------------------------------ jumps
  const jumpImmediate = ops.filter((o) => o.operands[0] === 'kUImm');
  let jumpBlock = null, jumpConstant = [], backwardJumpValue = null;
  const isJump = new Set();
  const isJumpImmediate = new Set();
  const isJumpConstant = new Set();
  if (jumpImmediate.length === 0) {
    problems.push('no opcode takes kUImm as its first operand: cannot locate the jump family');
  } else {
    const lo = Math.min(...jumpImmediate.map((o) => o.value));
    const hi = Math.max(...jumpImmediate.map((o) => o.value));
    jumpBlock = [lo, hi];
    const block = ops.filter((o) => o.value >= lo && o.value <= hi);
    jumpConstant = block.filter((o) => o.operands[0] === 'kConstantPoolIndex');
    for (const o of block) isJump.add(o.value);
    for (const o of jumpImmediate) isJumpImmediate.add(o.value);
    for (const o of jumpConstant) isJumpConstant.add(o.value);

    const unexplained = block.filter((o) => !isJumpImmediate.has(o.value) && !isJumpConstant.has(o.value));
    if (unexplained.length) {
      problems.push(`opcodes inside the jump block [${lo},${hi}] take neither kUImm nor kConstantPoolIndex first: `
        + unexplained.map((o) => `${o.name}[${o.operands.join(',')}]`).join(', '));
    }
    // cross-check 1: name agreement in both directions
    const nameJumps = new Set(ops.filter((o) => /^Jump/.test(o.name)).map((o) => o.value));
    const onlyByValue = [...isJump].filter((v) => !nameJumps.has(v)).map((v) => profile.getOpcode(v).name);
    const onlyByName = [...nameJumps].filter((v) => !isJump.has(v)).map((v) => profile.getOpcode(v).name);
    if (onlyByValue.length || onlyByName.length) {
      problems.push(`jump family derived from operand types disagrees with the Jump* names: `
        + `only-by-type [${onlyByValue.join(',')}] only-by-name [${onlyByName.join(',')}]`);
    }
    // the backward jump: bottom of the block
    backwardJumpValue = lo;
    if (!isJumpImmediate.has(backwardJumpValue)) {
      problems.push(`the lowest opcode in the jump block (${profile.getOpcode(lo).name}) is not a jump-immediate`);
    }
    // cross-check 2: it must be the unique jump carrying a loop depth + feedback slot
    const loopShaped = jumpImmediate.filter((o) => o.operands.includes('kImm') && o.operands.includes('kFeedbackSlot'));
    if (loopShaped.length !== 1 || loopShaped[0].value !== backwardJumpValue) {
      problems.push(`expected exactly one jump with a loop-depth kImm + kFeedbackSlot and for it to be the lowest `
        + `in the block; found [${loopShaped.map((o) => o.name).join(',')}] vs lowest ${profile.getOpcode(lo).name}`);
    }
  }

  // --------------------------------------------------------------- switches
  /** @type {Map<number, {tableStart:number, tableLength:number, caseBase:number|null}>} */
  const switchRoles = new Map();
  for (const o of ops) {
    if (!/^SwitchOn/.test(o.name)) continue;
    const tableStart = o.operands.indexOf('kConstantPoolIndex');
    const tableLength = o.operands.indexOf('kUImm');
    const caseBase = o.operands.indexOf('kImm');
    if (tableStart < 0 || tableLength < 0) {
      problems.push(`${o.name}[${o.operands.join(',')}] looks like a switch but has no `
        + `kConstantPoolIndex/kUImm operand pair to read a jump table from`);
      continue;
    }
    if (tableLength !== tableStart + 1) {
      problems.push(`${o.name}[${o.operands.join(',')}]: the jump-table length operand does not follow the table index`);
    }
    switchRoles.set(o.value, { tableStart, tableLength, caseBase: caseBase < 0 ? null : caseBase });
  }

  // --------------------------------------------- per-opcode decode plans
  // plans[scale][value] = [{type, size, signed, offset}], offset relative to
  // the first operand byte. Precomputed because the corpus decodes millions of
  // instructions and operandSize() does a table lookup each time.
  const plans = new Map();
  for (const scale of scales) {
    const arr = new Array(bc.totalOpcodes).fill(null);
    for (const o of ops) {
      let off = 0;
      const plan = [];
      for (const t of o.operands) {
        const size = profile.operandSize(t, scale);
        plan.push({ type: t, size, signed: !!profile.operandType(t).signed, offset: off, isRegister: profile.isRegisterOperand(t), regCount: registersPerOperand(t) });
        off += size;
      }
      arr[o.value] = { operands: plan, bodyLength: 1 + off, op: o };
      const want = profile.instructionLength(o.value, scale);
      if (want !== 1 + off) problems.push(`${o.name}@scale${scale}: plan length ${1 + off} != profile.instructionLength ${want}`);
    }
    plans.set(scale, arr);
  }

  // --------------------------------- register-list pairing + arity coverage
  for (const t of profile.tables.operands.registerOperandTypes) {
    if (registersPerOperand(t) === null) continue;      // the List types
    if (![1, 2, 3].includes(registersPerOperand(t))) problems.push(`register operand type ${t}: cannot tell how many registers it names`);
  }
  for (const o of ops) {
    o.operands.forEach((t, i) => {
      if (registersPerOperand(t) !== null || !profile.isRegisterOperand(t)) return;
      // a *List register operand must be followed by its kRegCount
      if (o.operands[i + 1] !== 'kRegCount') {
        problems.push(`${o.name}[${o.operands.join(',')}]: ${t} at ${i} is not followed by kRegCount`);
      }
    });
  }

  if (problems.length) {
    throw new Error(`profile ${profile.version}: cannot derive a safe decode table:\n  ${problems.join('\n  ')}`);
  }

  return {
    profile,
    prefixByByte,
    scales,
    shortStarIndex,
    longStar,
    jumpBlock,
    isJump,
    isJumpImmediate,
    isJumpConstant,
    backwardJumpValue,
    switchRoles,
    plans,
    registersPerOperand,
    /** The jump delta operand index, located by type (kUImm or kConstantPoolIndex). */
    jumpDeltaOperand(value) {
      if (isJumpImmediate.has(value)) return { index: profile.getOpcode(value).operands.indexOf('kUImm'), via: 'immediate' };
      if (isJumpConstant.has(value)) return { index: profile.getOpcode(value).operands.indexOf('kConstantPoolIndex'), via: 'constant' };
      return null;
    },
    describe() {
      const nm = (v) => profile.getOpcode(v).name;
      return [
        `opcode facts for ${profile.version}: ${bc.totalOpcodes} opcodes`,
        `  prefixes: ${[...prefixByByte].map(([b, p]) => `${p.name}=0x${b.toString(16)}->x${p.scale}`).join(' ')}`,
        `  short star: ${shortStarIndex.size} opcodes (${ssr ? `${ssr.firstName}..${ssr.lastName}` : '-'}) -> ${longStar?.name}`,
        `  jump block: [${jumpBlock?.join(',')}] = ${nm(jumpBlock[0])}..${nm(jumpBlock[1])}`,
        `    ${isJumpImmediate.size} immediate + ${isJumpConstant.size} constant = ${isJump.size}`,
        `    backward jump: ${nm(backwardJumpValue)}`,
        `  switches: ${[...switchRoles].map(([v, r]) => `${nm(v)}(start@${r.tableStart},len@${r.tableLength},base@${r.caseBase ?? 'none'})`).join(' ')}`,
      ].join('\n');
    },
  };
}

export default { opcodeFacts };
