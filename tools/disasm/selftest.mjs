#!/usr/bin/env node
// tools/disasm/selftest.mjs
//
// Unit-level self-test for src/disasm/. The oracle
// (tools/disasm/oracle_agreement.mjs) is the acceptance test; this one covers
// the parts an oracle run cannot isolate or cannot reach:
//
//   A  hygiene       no version-specific literal anywhere in src/disasm/
//   B  frame model   the derived interpreter-frame register encoding
//   C  opcode facts  the derived jump / switch / short-star classifications
//   D  lengths       decode plan width == profile.instructionLength, all scales
//   E  encode/decode every opcode, at every scale, round trips through a tiny
//                    profile-driven assembler
//   F  jumps         opcodeByteOffset +/- delta, including the prefixed case,
//                    where "instruction start + delta" would be off by one
//   G  jump tables   span, case numbering, negative case base, both switches
//   H  reg lists     kRegList + kRegCount pairing and kRegOutPair/Triple
//   I  short star    all 16 normalise to Star with the right register
//   J  source pos    V8's lockstep attachment, including the entry row
//   K  versioning    the six comparison bytecodes really do decode to
//                    different widths under the two profiles (ARCHITECTURE 1.3)
//   L  round trip    renderV8Listing -> bytecode_parser -> the same structure
//   M  robustness    truncated / illegal / prefix-on-prefix are reported
//
// Usage: node tools/disasm/selftest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, listProfiles } from '../../src/profile/index.mjs';
import { disassemble } from '../../src/disasm/index.mjs';
import { opcodeFacts } from '../../src/disasm/opcode_facts.mjs';
import { frameModel } from '../../src/disasm/frame.mjs';
import { renderV8Listing, toParsedForm } from '../../src/disasm/format.mjs';
import { parseBytecodeDump } from '../../src/verify/bytecode_parser.mjs';

const TAGS = listProfiles();
const PRIMARY = '14.4.258.16';
const SECONDARY = '14.6.202.34';

const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let pass = 0, fail = 0;
function check(group, name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, detail: `threw: ${e.message}` }; }
  if (r.ok) pass++; else fail++;
  say(`| ${group} | ${name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail ?? ''} |`);
}

// ---------------------------------------------------------------------------
// a tiny, profile-driven assembler -- the inverse of the decoder, used so the
// tests do not have to hardcode any byte
// ---------------------------------------------------------------------------

/**
 * @param {object} profile
 * @param {Array<{op: string, scale?: number, operands?: number[]}>} items
 * @returns {{buf: Buffer, offsets: number[], opcodeOffsets: number[]}}
 */
function assemble(profile, items) {
  const facts = opcodeFacts(profile);
  const parts = [];
  const offsets = [];
  const opcodeOffsets = [];
  let at = 0;
  for (const it of items) {
    const op = profile.getOpcode(it.op);
    if (!op) throw new Error(`no opcode ${it.op} in ${profile.version}`);
    const scale = it.scale ?? 1;
    const chunks = [];
    offsets.push(at);
    if (scale !== 1) {
      const pfx = [...facts.prefixByByte].find(([, p]) => p.scale === scale);
      if (!pfx) throw new Error(`profile has no prefix for scale ${scale}`);
      chunks.push(Buffer.from([pfx[0]]));
      at += 1;
    }
    opcodeOffsets.push(at);
    chunks.push(Buffer.from([op.value]));
    at += 1;
    const vals = it.operands ?? [];
    op.operands.forEach((t, i) => {
      const size = profile.operandSize(t, scale);
      const signed = !!profile.operandType(t).signed;
      const b = Buffer.alloc(size);
      const v = vals[i] ?? 0;
      if (size === 1) signed ? b.writeInt8(v) : b.writeUInt8(v >>> 0);
      else if (size === 2) signed ? b.writeInt16LE(v) : b.writeUInt16LE(v & 0xffff);
      else if (size === 4) signed ? b.writeInt32LE(v) : b.writeUInt32LE(v >>> 0);
      chunks.push(b);
      at += size;
    });
    parts.push(...chunks);
  }
  return { buf: Buffer.concat(parts), offsets, opcodeOffsets };
}

/**
 * A one-byte, zero-operand opcode to pad synthetic streams with. V8 removed
 * `Nop`, so pick one out of the profile instead of naming anything.
 */
function padOpcode(profile) {
  const facts = opcodeFacts(profile);
  for (let v = 0; v < profile.opcodeCount; v++) {
    const op = profile.getOpcode(v);
    if (!op || op.operands.length !== 0) continue;
    if (op.name === 'Illegal' || profile.prefixScale(v) !== null || facts.shortStarIndex.has(v)) continue;
    return op.name;
  }
  throw new Error(`${profile.version}: no zero-operand opcode to pad with`);
}

/** A minimal FunctionUnit around a bytecode buffer. */
function unitOf(buf, extra = {}) {
  return {
    sfiId: null, bytecodeId: 0, functionLiteralId: null, name: 'test', kind: null,
    isGenerator: false, isAsync: false, isStrict: null, startPosition: null, endPosition: null,
    bytecode: buf, frameSize: null, parameterCount: null, maxArguments: 0,
    registerCount: null, incomingNewTargetOrGeneratorRegister: 0,
    constants: [], handlers: [], handlerTableSize: 0,
    sourcePositions: [], sourcePositionTableSize: 0, scope: null, uncompiled: null,
    warnings: [], ...extra,
  };
}

say('# src/disasm self-test');
say('');
say(`profiles: ${TAGS.join(', ')}`);
say('');
say('| group | check | result | detail |');
say('|---|---|---|---|');

// ---------------------------------------------------------------- A hygiene
check('A', 'no version-specific literal in src/disasm/', () => {
  const dir = 'src/disasm';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of files) {
    const stripped = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hex = [...stripped.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0]);
    const big = [...stripped.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)].map((m) => m[0]);
    if (hex.length || big.length) offenders.push(`${f}: hex[${hex.join(',')}] big[${big.join(',')}]`);
  }
  return { ok: offenders.length === 0, detail: offenders.length ? offenders.join('; ') : `${files.length} files clean` };
});

for (const tag of TAGS) {
  const p = loadProfile(path.join('profiles', tag));
  const facts = opcodeFacts(p);
  const frame = frameModel(p);
  const PAD = padOpcode(p);

  // ------------------------------------------------------------ B frame
  check('B', `${tag} frame model derives V8's register encoding`, () => {
    const r0 = frame.fromLocalIndex(0);
    const thisReg = frame.fromParameterIndex(0);
    const a0 = frame.fromParameterIndex(1);
    const ok = frame.toString(r0) === 'r0' && frame.toString(thisReg) === '<this>'
      && frame.toString(a0) === 'a0'
      && frame.toString(frame.fromIndex(frame.idx.context)) === '<context>'
      && frame.toString(frame.fromIndex(frame.idx.closure)) === '<closure>'
      && frame.toString(frame.fromIndex(frame.idx.accumulator)) === '<accumulator>'
      && frame.decode(r0.operand).k === 'local' && frame.decode(thisReg.operand).i === 0
      && frame.decode(a0.operand).i === 1;
    return { ok, detail: `r0 operand ${r0.operand}, <this> ${thisReg.operand}, a0 ${a0.operand}; ${frame.meta.provenance}` };
  });
  check('B', `${tag} operand <-> index is a bijection`, () => {
    let bad = 0;
    for (let v = -1000; v <= 1000; v++) if (frame.toOperand(frame.toIndex(v)) !== v) bad++;
    for (let i = 0; i < 2000; i++) {
      const r = frame.fromLocalIndex(i);
      if (r.k !== 'local' || r.i !== i || frame.decode(r.operand).i !== i) bad++;
    }
    return { ok: bad === 0, detail: `${bad} failures over 3001 round trips` };
  });

  // ------------------------------------------------------ C opcode facts
  check('C', `${tag} jump family derived from operand types`, () => {
    const names = [...facts.isJump].sort((a, b) => a - b).map((v) => p.getOpcode(v).name);
    const allJump = names.every((n) => /^Jump/.test(n));
    const back = p.getOpcode(facts.backwardJumpValue);
    return {
      ok: allJump && facts.isJump.size === facts.isJumpImmediate.size + facts.isJumpConstant.size
        && facts.isJumpImmediate.has(facts.backwardJumpValue) && back.operands.includes('kFeedbackSlot'),
      detail: `${facts.isJump.size} jumps = ${facts.isJumpImmediate.size} immediate + ${facts.isJumpConstant.size} constant; backward = ${back.name}`,
    };
  });
  check('C', `${tag} switch family and its jump-table operand roles`, () => {
    const rows = [...facts.switchRoles].map(([v, r]) => {
      const op = p.getOpcode(v);
      return `${op.name}(start=${op.operands[r.tableStart]}@${r.tableStart}, len=${op.operands[r.tableLength]}@${r.tableLength}, base=${r.caseBase === null ? 'implicit 0' : op.operands[r.caseBase] + '@' + r.caseBase})`;
    });
    const ok = facts.switchRoles.size >= 2 && [...facts.switchRoles].every(([v, r]) => {
      const op = p.getOpcode(v);
      return op.operands[r.tableStart] === 'kConstantPoolIndex' && op.operands[r.tableLength] === 'kUImm'
        && (r.caseBase === null || op.operands[r.caseBase] === 'kImm');
    });
    return { ok, detail: rows.join(' ') };
  });
  check('C', `${tag} short-star range maps onto registers 0..n-1`, () => {
    const idx = [...facts.shortStarIndex.values()].sort((a, b) => a - b);
    const ok = idx.length === p.shortStarRange.count && idx.every((v, i) => v === i);
    return { ok, detail: `${idx.length} opcodes -> r${idx[0]}..r${idx[idx.length - 1]}` };
  });

  // ----------------------------------------------------------- D lengths
  check('D', `${tag} decode plan width == profile.instructionLength, all scales`, () => {
    let bad = 0, n = 0;
    for (const scale of facts.scales) {
      for (const [, plan] of facts.plans.get(scale).entries()) {
        if (!plan) continue;
        n++;
        if (plan.bodyLength !== p.instructionLength(plan.op.value, scale)) bad++;
      }
    }
    return { ok: bad === 0, detail: `${n} (opcode, scale) pairs, ${bad} disagreements` };
  });

  // -------------------------------------------------- E encode/decode all
  check('E', `${tag} every opcode round trips through assemble + disassemble`, () => {
    const problems = [];
    for (const scale of facts.scales) {
      const items = [];
      for (let v = 0; v < p.opcodeCount; v++) {
        const op = p.getOpcode(v);
        if (!op || op.name === 'Illegal' || p.prefixScale(v) !== null) continue;
        // Operand values that fit at every scale and stay in range.
        const operands = op.operands.map((t) => {
          if (t === 'kRegCount') return 2;
          if (p.isRegisterOperand(t)) return frame.fromLocalIndex(1).operand;
          if (t === 'kImm') return -3;
          return 1;
        });
        items.push({ op: op.name, scale, operands });
      }
      const { buf, offsets, opcodeOffsets } = assemble(p, items);
      const r = disassemble(unitOf(buf), { profile: p, strict: false });
      if (r.instructions.length !== items.length) {
        problems.push(`scale ${scale}: decoded ${r.instructions.length} of ${items.length}`);
        continue;
      }
      r.instructions.forEach((ins, i) => {
        if (ins.offset !== offsets[i]) problems.push(`scale ${scale} #${i}: offset ${ins.offset} != ${offsets[i]}`);
        if (ins.opcodeOffset !== opcodeOffsets[i]) problems.push(`scale ${scale} #${i}: opcodeOffset ${ins.opcodeOffset} != ${opcodeOffsets[i]}`);
        if (ins.scale !== scale) problems.push(`scale ${scale} #${i}: scale ${ins.scale}`);
      });
      if (r.stats.lengthMismatch.size) problems.push(`scale ${scale}: ${r.stats.lengthMismatch.size} length mismatches`);
      if (r.stats.decodedBytes !== buf.length) problems.push(`scale ${scale}: decoded ${r.stats.decodedBytes} of ${buf.length} bytes`);
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 4).join('; ') || `all ${facts.scales.length} scales clean` };
  });

  // ------------------------------------------------------------- F jumps
  check('F', `${tag} jump target = opcodeByteOffset +/- delta, prefixed included`, () => {
    const problems = [];
    const fwd = p.getOpcode('Jump');
    const back = p.getOpcode(facts.backwardJumpValue);
    for (const scale of facts.scales) {
      // Pad, then a forward jump, then a backward jump to the padding.
      const pad = Array.from({ length: 4 }, () => ({ op: PAD }));
      const items = [...pad, { op: fwd.name, scale, operands: [9] },
        { op: back.name, scale, operands: [7, 0, 0] }, ...pad];
      const { buf, offsets, opcodeOffsets } = assemble(p, items);
      const r = disassemble(unitOf(buf), { profile: p, strict: false });
      const j = r.instructions[4], l = r.instructions[5];
      if (j.jumpTarget !== opcodeOffsets[4] + 9) problems.push(`scale ${scale}: forward ${j.jumpTarget} != ${opcodeOffsets[4] + 9}`);
      if (l.jumpTarget !== opcodeOffsets[5] - 7) problems.push(`scale ${scale}: backward ${l.jumpTarget} != ${opcodeOffsets[5] - 7}`);
      // the distinction that matters: start + delta is NOT the rule
      if (scale !== 1 && j.jumpTarget === offsets[4] + 9) problems.push(`scale ${scale}: forward target used the instruction start`);
    }
    // the *Constant variant takes its delta from the pool
    const kon = [...facts.isJumpConstant].map((v) => p.getOpcode(v)).find((o) => o.operands.length === 1);
    const items = [{ op: PAD }, { op: kon.name, operands: [1] }, { op: PAD }, { op: PAD }];
    const { buf, opcodeOffsets } = assemble(p, items);
    const r = disassemble(unitOf(buf, { constants: [{ t: 'string', v: 'x' }, { t: 'number', v: 3 }] }), { profile: p, strict: false });
    if (r.instructions[1].jumpTarget !== opcodeOffsets[1] + 3) {
      problems.push(`${kon.name}: ${r.instructions[1].jumpTarget} != ${opcodeOffsets[1] + 3}`);
    }
    // a non-Smi pool entry must be reported, not guessed
    const r2 = disassemble(unitOf(buf, { constants: [{ t: 'string', v: 'x' }, { t: 'string', v: 'not a smi' }] }), { profile: p, strict: false });
    if (r2.instructions[1].jumpTarget !== null || !r2.warnings.some((w) => w.code === 'unresolvedJumpConstant')) {
      problems.push(`${kon.name} with a non-Smi constant was not reported`);
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 4).join('; ') || `forward, backward and ${kon.name} correct at every scale` };
  });

  // -------------------------------------------------------- G jump tables
  check('G', `${tag} SwitchOnSmiNoFeedback jump table, incl. negative case base`, () => {
    const problems = [];
    const op = p.getOpcode('SwitchOnSmiNoFeedback');
    const roles = facts.switchRoles.get(op.value);
    for (const scale of facts.scales) {
      for (const base of [0, -4, 10]) {
        const operands = [];
        operands[roles.tableStart] = 1;
        operands[roles.tableLength] = 3;
        operands[roles.caseBase] = base;
        const items = [{ op: PAD }, { op: op.name, scale, operands }];
        const { buf, opcodeOffsets } = assemble(p, items);
        const constants = [{ t: 'string', v: 'pad' }, { t: 'number', v: 2 }, { t: 'number', v: 5 }, { t: 'number', v: 9 }];
        const r = disassemble(unitOf(buf, { constants }), { profile: p, strict: false });
        const t = r.instructions[1].jumpTable;
        const want = [2, 5, 9].map((d, i) => ({ caseValue: base + i, target: opcodeOffsets[1] + d }));
        const got = t?.map((e) => ({ caseValue: e.caseValue, target: e.target }));
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          problems.push(`scale ${scale} base ${base}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        }
      }
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 3).join('; ') || 'spans, case numbering and targets correct at every scale' };
  });
  check('G', `${tag} SwitchOnGeneratorState jump table (implicit case base 0)`, () => {
    const op = p.getOpcode('SwitchOnGeneratorState');
    const roles = facts.switchRoles.get(op.value);
    const operands = [];
    operands[0] = frame.fromLocalIndex(0).operand;
    operands[roles.tableStart] = 0;
    operands[roles.tableLength] = 2;
    const items = [{ op: PAD }, { op: op.name, operands }];
    const { buf, opcodeOffsets } = assemble(p, items);
    const r = disassemble(unitOf(buf, { constants: [{ t: 'number', v: 4 }, { t: 'number', v: 8 }] }), { profile: p, strict: false });
    const got = r.instructions[1].jumpTable?.map((e) => `${e.caseValue}:${e.target}`).join(',');
    const want = `0:${opcodeOffsets[1] + 4},1:${opcodeOffsets[1] + 8}`;
    return { ok: got === want && roles.caseBase === null, detail: `${got} (want ${want})` };
  });
  check('G', `${tag} a jump-table entry that is not a Smi is reported, never skipped`, () => {
    const op = p.getOpcode('SwitchOnSmiNoFeedback');
    const roles = facts.switchRoles.get(op.value);
    const operands = [];
    operands[roles.tableStart] = 0;
    operands[roles.tableLength] = 2;
    operands[roles.caseBase] = 0;
    const { buf } = assemble(p, [{ op: op.name, operands }]);
    const r = disassemble(unitOf(buf, { constants: [{ t: 'number', v: 1 }, { t: 'unresolved', why: 'test' }] }), { profile: p, strict: false });
    const t = r.instructions[0].jumpTable;
    return {
      ok: t?.length === 2 && t[1].target === null && t[1].unresolved === true
        && r.warnings.some((w) => w.code === 'unresolvedJumpTableEntry') && r.stats.jumpTableHoles === 1,
      detail: `${t?.length} entries, hole reported: ${r.stats.jumpTableHoles}`,
    };
  });

  // --------------------------------------------------------- H reg lists
  check('H', `${tag} kRegList + kRegCount decode as one upward run of registers`, () => {
    const problems = [];
    const op = [...Object.values(p.tables.bytecodes.byValue)].find((o) => o.operands.includes('kRegList'));
    const li = op.operands.indexOf('kRegList');
    for (const scale of facts.scales) {
      for (const count of [0, 1, 5]) {
        const operands = op.operands.map((t, i) => {
          if (i === li) return frame.fromLocalIndex(3).operand;
          if (i === li + 1) return count;
          if (p.isRegisterOperand(t)) return frame.fromLocalIndex(0).operand;
          return 0;
        });
        const { buf } = assemble(p, [{ op: op.name, scale, operands }]);
        const r = disassemble(unitOf(buf), { profile: p, strict: false });
        const o = r.instructions[0].operands[li];
        const cnt = r.instructions[0].operands[li + 1];
        const idx = o.regs.map((x) => x.i).join(',');
        const want = Array.from({ length: count }, (_, k) => 3 + k).join(',');
        if (o.count !== count || idx !== want || cnt.type !== 'kRegCount' || cnt.count !== count) {
          problems.push(`scale ${scale} count ${count}: start r${o.start.i} regs [${idx}] want [${want}]`);
        }
        // operand values must DECREASE as the register index increases
        if (count > 1 && !(o.regs[0].operand > o.regs[1].operand)) {
          problems.push(`scale ${scale}: operand values do not decrease across the list`);
        }
      }
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 3).join('; ') || `${op.name} correct for counts 0/1/5 at every scale` };
  });
  check('H', `${tag} kRegOutPair / kRegOutTriple expand to 2 / 3 registers`, () => {
    const problems = [];
    for (const [t, n] of [['kRegOutPair', 2], ['kRegPair', 2], ['kRegOutTriple', 3]]) {
      const op = Object.values(p.tables.bytecodes.byValue).find((o) => o.operands.includes(t));
      if (!op) { problems.push(`${t} unused in this profile`); continue; }
      const i = op.operands.indexOf(t);
      const operands = op.operands.map((x) => (p.isRegisterOperand(x) ? frame.fromLocalIndex(2).operand : 0));
      const { buf } = assemble(p, [{ op: op.name, operands }]);
      const r = disassemble(unitOf(buf), { profile: p, strict: false });
      const o = r.instructions[0].operands[i];
      const idx = o.regs.map((x) => x.i).join(',');
      const want = Array.from({ length: n }, (_, k) => 2 + k).join(',');
      if (idx !== want) problems.push(`${t}: [${idx}] want [${want}]`);
    }
    return { ok: problems.length === 0, detail: problems.join('; ') || 'pair and triple correct' };
  });

  // -------------------------------------------------------- I short star
  check('I', `${tag} all ${p.shortStarRange.count} short stars normalise to Star`, () => {
    const items = [...facts.shortStarIndex.keys()].sort((a, b) => a - b).map((v) => ({ op: p.getOpcode(v).name }));
    const { buf } = assemble(p, items);
    const r = disassemble(unitOf(buf), { profile: p, strict: false });
    const problems = [];
    r.instructions.forEach((ins) => {
      const want = facts.shortStarIndex.get(ins.opcodeValue);
      if (ins.opcode !== 'Star') problems.push(`${ins.rawOpcode} -> ${ins.opcode}`);
      if (!ins.isShortStar) problems.push(`${ins.rawOpcode} not flagged`);
      const o = ins.operands[0];
      if (!o || o.reg?.i !== want || !o.fromOpcode) problems.push(`${ins.rawOpcode} -> r${o?.reg?.i} want r${want}`);
      if (ins.length !== 1) problems.push(`${ins.rawOpcode} length ${ins.length}`);
    });
    return { ok: problems.length === 0 && r.stats.shortStars === items.length, detail: problems.slice(0, 3).join('; ') || `${items.length} opcodes, all Star + explicit register` };
  });

  // ----------------------------------------------------- J source positions
  check('J', `${tag} source positions attach in lockstep, entry row skipped`, () => {
    const items = [{ op: PAD }, { op: PAD }, { op: PAD }, { op: PAD }];
    const { buf, offsets } = assemble(p, items);
    const entry = p.constants.globals.kFunctionEntryBytecodeOffset;
    const sp = [
      { codeOffset: entry, sourcePosition: 7, isStatement: false, isBreakable: true },
      { codeOffset: offsets[0], sourcePosition: 10, isStatement: true, isBreakable: true },
      { codeOffset: offsets[2], sourcePosition: 20, isStatement: false, isBreakable: false },
    ];
    const r = disassemble(unitOf(buf, { sourcePositions: sp }), { profile: p, strict: false });
    const got = r.instructions.map((i) => `${i.sourcePosition}/${i.isStatement ? 'S' : 'E'}${i.isBreakable ? '>' : ''}`).join(' ');
    const ok = got === '10/S> null/E 20/E null/E'
      && r.stats.sourcePositionsTotal === 2 && r.stats.sourcePositionsAttached === 2;
    return { ok, detail: `${got}; attached ${r.stats.sourcePositionsAttached}/${r.stats.sourcePositionsTotal}` };
  });

  // --------------------------------------------------------- L round trip
  check('L', `${tag} renderV8Listing re-parses to the same instructions`, () => {
    const items = [];
    for (let v = 0; v < p.opcodeCount; v++) {
      const op = p.getOpcode(v);
      if (!op || op.name === 'Illegal' || p.prefixScale(v) !== null) continue;
      items.push({
        op: op.name, scale: 1,
        operands: op.operands.map((t) => (t === 'kRegCount' ? 1 : p.isRegisterOperand(t) ? frame.fromLocalIndex(1).operand : 1)),
      });
    }
    const { buf } = assemble(p, items);
    const constants = Array.from({ length: 8 }, (_, i) => ({ t: 'number', v: i }));
    const r = disassemble(unitOf(buf, { constants, parameterCount: 3, registerCount: 8, frameSize: 64 }), { profile: p, strict: false });
    const listing = renderV8Listing(r);
    const reparsed = parseBytecodeDump(listing);
    if (reparsed.unparsedLines.length) return { ok: false, detail: `${reparsed.unparsedLines.length} lines our own parser could not read: ${reparsed.unparsedLines[0]?.slice(0, 80)}` };
    const back = reparsed.functions[0];
    const mine = toParsedForm(r);
    const problems = [];
    if (!back || back.instructions.length !== mine.instructions.length) {
      problems.push(`${back?.instructions.length} instructions re-parsed vs ${mine.instructions.length}`);
    } else {
      back.instructions.forEach((b, i) => {
        const a = mine.instructions[i];
        if (a.offset !== b.offset) problems.push(`#${i} offset`);
        if (a.opcode !== b.opcode) problems.push(`#${i} opcode ${a.opcode}/${b.opcode}`);
        if (Buffer.from(a.bytes).toString('hex') !== Buffer.from(b.bytes).toString('hex')) problems.push(`#${i} bytes`);
        if ((a.jumpTarget ?? null) !== (b.jumpTarget ?? null)) problems.push(`#${i} jumpTarget`);
        if (a.operands.length !== b.operands.length) problems.push(`#${i} operand count ${a.operandText} / ${b.operandText}`);
      });
    }
    return { ok: problems.length === 0, detail: problems.slice(0, 4).join('; ') || `${items.length} instructions survived listing -> parse` };
  });

  // -------------------------------------------------------- M robustness
  check('M', `${tag} truncated / illegal / prefix-on-prefix are reported`, () => {
    const problems = [];
    // an operand cut short
    const { buf } = assemble(p, [{ op: 'LdaSmi', operands: [1] }]);
    const cut = buf.subarray(0, buf.length - 1);
    const r1 = disassemble(unitOf(cut), { profile: p, strict: false });
    if (!r1.warnings.some((w) => w.code === 'truncated')) problems.push('truncated operand not reported');
    // the Illegal opcode
    const r2 = disassemble(unitOf(Buffer.from([p.illegalOpcode])), { profile: p, strict: false });
    if (!r2.warnings.some((w) => w.code === 'illegalOpcode')) problems.push('Illegal not reported');
    // a prefix at end of stream
    const pfxByte = [...facts.prefixByByte.keys()][0];
    const r3 = disassemble(unitOf(Buffer.from([pfxByte])), { profile: p, strict: false });
    if (!r3.warnings.some((w) => w.code === 'truncated')) problems.push('prefix at EOF not reported');
    // prefix followed by prefix
    const r4 = disassemble(unitOf(Buffer.from([pfxByte, pfxByte])), { profile: p, strict: false });
    if (!r4.warnings.some((w) => w.code === 'illegalOpcode')) problems.push('prefix on prefix not reported');
    // strict mode must throw instead of warning
    let threw = false;
    try { disassemble(unitOf(Buffer.from([p.illegalOpcode])), { profile: p, strict: true }); } catch { threw = true; }
    if (!threw) problems.push('strict mode did not throw on Illegal');
    // a register outside the frame
    const { buf: b5 } = assemble(p, [{ op: 'Ldar', operands: [frame.fromLocalIndex(99).operand] }]);
    const r5 = disassemble(unitOf(b5, { registerCount: 4, parameterCount: 1 }), { profile: p, strict: false });
    if (!r5.warnings.some((w) => w.code === 'registerOutOfRange')) problems.push('register out of range not reported');
    // a jump into the middle of an instruction
    const { buf: b6 } = assemble(p, [{ op: 'Jump', operands: [1] }, { op: 'LdaSmi', operands: [1] }]);
    const r6 = disassemble(unitOf(b6), { profile: p, strict: false });
    if (!r6.warnings.some((w) => w.code === 'jumpTargetNotAnInstruction')) problems.push('dangling jump target not reported');
    return { ok: problems.length === 0, detail: problems.join('; ') || '7 malformed inputs all reported' };
  });
}

// ------------------------------------------------------------ K versioning
if (TAGS.includes(PRIMARY) && TAGS.includes(SECONDARY)) {
  check('K', `${PRIMARY} vs ${SECONDARY}: the comparison bytecodes change width`, () => {
    const a = loadProfile(path.join('profiles', PRIMARY));
    const b = loadProfile(path.join('profiles', SECONDARY));
    const movers = ['TestEqual', 'TestLessThan', 'TestGreaterThan', 'TestLessThanOrEqual', 'TestGreaterThanOrEqual'];
    const rows = [];
    let differing = 0;
    for (const n of movers) {
      const la = a.instructionLength(n, 1), lb = b.instructionLength(n, 1);
      rows.push(`${n} ${la}/${lb}`);
      if (la !== lb) differing++;
    }
    return { ok: differing === movers.length, detail: `${differing}/${movers.length} differ at scale 1: ${rows.join(' ')}` };
  });
  check('K', `${SECONDARY} bytes decoded with the ${PRIMARY} table desynchronise`, () => {
    const a = loadProfile(path.join('profiles', PRIMARY));
    const b = loadProfile(path.join('profiles', SECONDARY));
    const fb = frameModel(b);
    // A stream of 14.6 comparison bytecodes, assembled with the 14.6 table.
    const items = Array.from({ length: 6 }, () => ({ op: 'TestGreaterThanOrEqual', operands: [fb.fromLocalIndex(1).operand, 0] }));
    const { buf } = assemble(b, items);
    const right = disassemble(unitOf(buf), { profile: b, strict: false });
    const wrong = disassemble(unitOf(buf), { profile: a, strict: false });
    const rightOk = right.instructions.length === items.length
      && right.instructions.every((i) => i.opcode === 'TestGreaterThanOrEqual');
    const wrongDesynced = wrong.instructions.length !== items.length
      || wrong.instructions.some((i) => i.opcode !== 'TestGreaterThanOrEqual');
    return {
      ok: rightOk && wrongDesynced,
      detail: `${SECONDARY} table: ${right.instructions.length} instructions, all TestGreaterThanOrEqual; `
        + `${PRIMARY} table on the same bytes: ${wrong.instructions.length} instructions `
        + `(${[...new Set(wrong.instructions.map((i) => i.opcode))].slice(0, 5).join(',')})`,
    };
  });
}

say('');
say(`${pass} passed, ${fail} failed`);
say('');
say(fail === 0 ? 'SELF-TEST: ALL CHECKS PASSED' : `SELF-TEST: ${fail} CHECK(S) FAILED`);
fs.mkdirSync('scratch/t5', { recursive: true });
fs.writeFileSync('scratch/t5/DISASM_SELFTEST.md', L.join('\n') + '\n');
process.exitCode = fail === 0 ? 0 : 1;
