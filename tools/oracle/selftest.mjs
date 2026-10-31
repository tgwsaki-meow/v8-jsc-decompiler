#!/usr/bin/env node
// O1 oracle self-test.
//
// Three independent assertions, run against every engine given on the command
// line (default: `node`, plus the 14.4 d8 if it is in .v8bin-cache):
//
//  A. ROUND TRIP -- every instruction line that V8 printed must re-render
//     byte-for-byte (modulo column padding and the incidental address) from the
//     parsed structure alone. This catches operand-parser gaps: anything the
//     parser lumps into `other` renders back verbatim and passes, so the test
//     also reports how many operands fell through to `other`, which must be 0.
//
//  B. RENAME INVARIANCE -- two sources that differ only in identifier names
//     must normalise to EQUAL streams.
//
//  C. DISCRIMINATION -- structurally different programs must normalise to
//     UNEQUAL streams. Without C, a comparator that returns "match" for
//     everything would pass B.
//
// Usage:
//   node tools/oracle/selftest.mjs
//   node tools/oracle/selftest.mjs .v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe

import fs from 'node:fs';
import path from 'node:path';
import { dumpBytecode, roundTripCheck, resolveEngine, engineVersion } from '../../src/verify/oracle.mjs';
import { compareFunctions } from '../../src/verify/compare.mjs';
import { SNIPPETS, EQUAL_PAIRS, UNEQUAL_PAIRS } from './snippets.mjs';

const WORK = 'scratch/t2/selftest';
fs.mkdirSync(WORK, { recursive: true });

const engineSpecs = process.argv.slice(2);
if (engineSpecs.length === 0) {
  engineSpecs.push('node');
  const d8 = '.v8bin-cache/v8-win64-rel-14.4.258.17/d8.exe';
  if (fs.existsSync(d8)) engineSpecs.push(d8);
}

const L = [];
const say = (s = '') => { L.push(s); console.log(s); };
let hardFailures = 0;

for (const spec of engineSpecs) {
  let engine;
  try { engine = resolveEngine(spec); } catch (e) { say(`SKIP ${spec}: ${e.message}`); continue; }
  const ver = engineVersion(engine);
  say(`========================================================================`);
  say(`engine: ${engine.label}   V8 ${ver}`);
  say(`========================================================================`);

  const dumps = new Map();
  let instrChecked = 0, rtFail = 0, otherOperands = 0, functionsParsed = 0, unparsed = 0;
  const perSnippet = [];

  for (const s of SNIPPETS) {
    const d = dumpBytecode({ engine, source: s.source, filter: s.filter, name: `${path.basename(spec)}__${s.name}`, workDir: WORK });
    dumps.set(s.name, d);
    const rt = roundTripCheck(d.parsed);
    instrChecked += rt.checked;
    rtFail += rt.failures.length;
    functionsParsed += d.parsed.functions.length;
    unparsed += d.parsed.unparsedLines.length;
    let others = 0;
    for (const fn of d.parsed.functions) for (const ins of fn.instructions) for (const op of ins.operands) if (op.kind === 'other') others++;
    otherOperands += others;
    const target = d.parsed.functions.find((f) => f.name === s.filter) ?? d.parsed.functions[0];
    perSnippet.push({
      name: s.name,
      status: d.status,
      functions: d.parsed.functions.length,
      instrs: rt.checked,
      rtFailures: rt.failures.length,
      otherOperands: others,
      unparsed: d.parsed.unparsedLines.length,
      len: target?.bytecodeLength ?? null,
      params: target?.parameterCount ?? null,
      regs: target?.registerCount ?? null,
      frame: target?.frameSize ?? null,
      pool: target?.constantPoolSize ?? null,
      poolRes: target?.constantPoolResolution ?? null,
      handlers: target?.handlerTable.length ?? 0,
    });
    if (rt.failures.length) {
      say(`  ROUND-TRIP FAILURES in ${s.name}:`);
      for (const f of rt.failures.slice(0, 6)) {
        say(`    raw      : ${f.raw.trim()}`);
        say(`    rendered : ${f.rendered}`);
        say(`    canonical: ${f.canonical}`);
      }
    }
  }

  say('## A. parse + round trip');
  say('');
  say('| snippet | fns | instrs | bc len | params | regs | frame | pool | handlers | rt fail | other-ops | unparsed |');
  say('|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|');
  for (const p of perSnippet) {
    say(`| ${p.name} | ${p.functions} | ${p.instrs} | ${p.len} | ${p.params} | ${p.regs} | ${p.frame} | ${p.pool}/${p.poolRes} | ${p.handlers} | ${p.rtFailures} | ${p.otherOperands} | ${p.unparsed} |`);
  }
  say('');
  say(`total: ${functionsParsed} functions, ${instrChecked} instructions parsed`);
  say(`round-trip mismatches : ${rtFail}  ${rtFail === 0 ? 'PASS' : 'FAIL'}`);
  say(`operands falling through to kind=other : ${otherOperands}  ${otherOperands === 0 ? 'PASS' : 'FAIL'}`);
  say(`unrecognised listing lines : ${unparsed}  ${unparsed === 0 ? 'PASS' : 'FAIL'}`);
  if (rtFail !== 0 || otherOperands !== 0 || unparsed !== 0) hardFailures++;
  say('');

  const pick = (name) => {
    const d = dumps.get(name);
    const s = SNIPPETS.find((x) => x.name === name);
    const i = d.parsed.functions.findIndex((f) => f.name === s.filter);
    return d.normalized[i >= 0 ? i : 0];
  };

  say('## B. rename invariance (must be EQUAL)');
  say('');
  say('| pair | exact | opcode sim | instr sim | verdict |');
  say('|---|---|---:|---:|---|');
  let bFail = 0;
  for (const [x, y] of EQUAL_PAIRS) {
    const c = compareFunctions(pick(x), pick(y));
    const ok = c.exactMatch;
    if (!ok) bFail++;
    say(`| ${x} vs ${y} | ${c.exactMatch} | ${(100 * c.opcodeSimilarity).toFixed(2)}% | ${(100 * c.instructionSimilarity).toFixed(2)}% | ${ok ? 'PASS' : 'FAIL'} |`);
    if (!ok && c.firstDivergence) {
      say(`|   | first divergence at ${c.firstDivergence.index}: \`${c.firstDivergence.left}\` vs \`${c.firstDivergence.right}\` | | | |`);
    }
  }
  say('');
  say(`rename invariance: ${EQUAL_PAIRS.length - bFail}/${EQUAL_PAIRS.length} ${bFail === 0 ? 'PASS' : 'FAIL'}`);
  if (bFail) hardFailures++;
  say('');

  say('## C. discrimination (must be UNEQUAL)');
  say('');
  say('| pair | exact | opcode sim | instr sim | verdict |');
  say('|---|---|---:|---:|---|');
  let cFail = 0;
  for (const [x, y] of UNEQUAL_PAIRS) {
    const c = compareFunctions(pick(x), pick(y));
    const ok = !c.exactMatch;
    if (!ok) cFail++;
    say(`| ${x} vs ${y} | ${c.exactMatch} | ${(100 * c.opcodeSimilarity).toFixed(2)}% | ${(100 * c.instructionSimilarity).toFixed(2)}% | ${ok ? 'PASS' : 'FAIL'} |`);
  }
  say('');
  say(`discrimination: ${UNEQUAL_PAIRS.length - cFail}/${UNEQUAL_PAIRS.length} ${cFail === 0 ? 'PASS' : 'FAIL'}`);
  if (cFail) hardFailures++;
  say('');

  say('## D. self-comparison sanity (every snippet vs itself must be exact)');
  let dFail = 0;
  for (const s of SNIPPETS) {
    const c = compareFunctions(pick(s.name), pick(s.name));
    if (!c.exactMatch) { dFail++; say(`  FAIL ${s.name} does not equal itself`); }
  }
  say(`identity: ${SNIPPETS.length - dFail}/${SNIPPETS.length} ${dFail === 0 ? 'PASS' : 'FAIL'}`);
  if (dFail) hardFailures++;
  say('');
}

// ---------------------------------------------------------------------------
// E. CROSS-ENGINE: does the normaliser make a 14.4 stream and a 14.6 stream of
//    the same source compare equal? This is the whole point of erasing the
//    feedback-slot operand (14.4 kFeedbackSlot vs 14.6 kEmbeddedFeedback).
//    Reported, not asserted: V8 14.4 -> 14.6 also changed some *generated*
//    sequences, so a residual difference here is a real engine difference and
//    not a normaliser bug. The point is that the number is small and the
//    divergence is nameable.
// ---------------------------------------------------------------------------
if (engineSpecs.length >= 2) {
  const [sa, sb] = engineSpecs;
  const ea = resolveEngine(sa), eb = resolveEngine(sb);
  say(`========================================================================`);
  say(`## E. cross-engine comparison: ${engineVersion(ea)} vs ${engineVersion(eb)}`);
  say('');
  say('| snippet | exact | opcode sim | instr sim | first divergence |');
  say('|---|---|---:|---:|---|');
  let exact = 0;
  for (const s of SNIPPETS) {
    const da = dumpBytecode({ engine: ea, source: s.source, filter: s.filter, name: `x_a__${s.name}`, workDir: WORK });
    const db = dumpBytecode({ engine: eb, source: s.source, filter: s.filter, name: `x_b__${s.name}`, workDir: WORK });
    const fa = da.normalized[da.parsed.functions.findIndex((f) => f.name === s.filter)] ?? da.normalized[0];
    const fb = db.normalized[db.parsed.functions.findIndex((f) => f.name === s.filter)] ?? db.normalized[0];
    const c = compareFunctions(fa, fb);
    if (c.exactMatch) exact++;
    const d = c.firstDivergence ? `\`${c.firstDivergence.left}\` vs \`${c.firstDivergence.right}\`` : '';
    say(`| ${s.name} | ${c.exactMatch} | ${(100 * c.opcodeSimilarity).toFixed(2)}% | ${(100 * c.instructionSimilarity).toFixed(2)}% | ${d} |`);
  }
  say('');
  say(`cross-engine exact matches: ${exact}/${SNIPPETS.length} (informational)`);
  say('');
}

say(`========================================================================`);
say(hardFailures === 0 ? 'SELF-TEST: ALL CHECKS PASSED' : `SELF-TEST: ${hardFailures} CHECK GROUP(S) FAILED`);
fs.writeFileSync('scratch/t2/O1_SELFTEST.md', L.join('\n') + '\n');
process.exitCode = hardFailures === 0 ? 0 : 1;
