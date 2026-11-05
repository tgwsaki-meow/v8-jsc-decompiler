// tools/probes/probe_closure.mjs
//
// Why is a function V8 makes from the original missing from our text?
//
// docs/O1.md 6.3 measures 65 013 of 184 672 functions (35.20%) present in
// stream A and absent from stream B, and self-test F of
// `tools/verify/o1_corpus_selftest.mjs` establishes the mechanism: V8 does not
// serialise an inner function DECLARATION nothing references. The suspicion
// this probe was written to test was that the reference is lost in
// `src/recover/` -- a `CreateClosure` in the input is proof the original had a
// reader, and the statement loop drops a pure value with no live use without
// counting it.
//
// Three questions, one per mode, and the answers are docs/RECOVER.md 9:
//
//   fate   per `CreateClosure` INSTRUCTION, which branch of the statement
//          loop decided it, plus the new named counters of that layer
//   cause  per child our text declares and nothing references, where the
//          reference went between T7's statements and the emitted text
//   form   the premise of the fix: does the SAME unreferenced function
//          survive a mint when it is declared with an initialiser?
//
//   node tools/probes/probe_closure.mjs fate  --corpus extracted_jsc --stride 37
//   node tools/probes/probe_closure.mjs cause --corpus extracted_jsc --stride 37
//   node tools/probes/probe_closure.mjs form
//
// `fate` and `cause` need the corpus (`extracted_jsc/`, not public); `form`
// needs the Electron 40 minter (`node tools/oracle/fetch_electron.mjs 40.0.0
// <platform> --binary`), because anything that mints has to mint with the
// corpus's own V8 (docs/O1.md 1). A table goes to stderr, one JSON object to
// stdout. Nothing from the corpus is ever executed.

import fs from 'node:fs';
import path from 'node:path';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover } from '../../src/recover/index.mjs';
import { structure } from '../../src/structure/index.mjs';
import { emit } from '../../src/emit/index.mjs';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'fate';
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const PROFILE = argOf('profile', 'profiles/14.4.258.16');
const MAX_BYTES = Number(argOf('max-bytes', '2500000'));

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : 'n/a');
const rows = (o, n = 25) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `  ${String(v).padStart(8)}  ${k}`);
const say = (lines) => process.stderr.write(lines.join('\n') + '\n');

function corpusFiles() {
  const dir = argOf('corpus', null);
  const named = argv.slice(1).filter((a) => a.endsWith('.jsc'));
  if (!dir) return named;
  const stride = Math.max(1, Number(argOf('stride', '37')) || 37);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsc')).sort()
    .filter((_, i) => i % stride === 0).map((f) => path.join(dir, f));
}

/** The opcode that defines value `id`, for naming a lost reader. */
function opOf(ir, id) {
  const v = ir.values[id];
  if (!v) return `?${id}`;
  if (v.kind !== 'Op') return v.kind;
  return ir.instructions[v.instruction]?.opcode ?? `Op@${v.instruction}`;
}

/** Every `{e:'fn'|'class', sfiId}` an expression tree mentions. */
function sfisIn(x, out = new Set(), seen = new Set()) {
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (Array.isArray(x)) { for (const y of x) sfisIn(y, out, seen); return out; }
  if ((x.e === 'fn' || x.e === 'class') && typeof x.sfiId === 'number') out.add(x.sfiId);
  for (const k of Object.keys(x)) {
    if (k === 'ref' || k === 'pos' || k === 'cites') continue;
    sfisIn(x[k], out, seen);
  }
  return out;
}

// ======================================================= fate (the T7 side)
//
// The buckets ARE the branches of `src/recover/index.mjs`'s statement loop, in
// its order, so every row is the decision that really ran:
//
//   consumedByPattern  `consumedIns.has(i)` -- an idiom folded the instruction
//   statementOverride  a pattern turned the value into a statement
//   droppedByDce       `dce.dead.has(vid) && !v.hasEffect` -> continue
//   materialised       `let f = function ...`
//   liveUse            at least one live user; inlined at that use
//   discardedResult    no live use but effectful -> emitted for its effect
//   droppedNoLiveUse   no live use and pure -> no statement, and before this
//                      work no hole and no counter either
//
// `droppedByDce` + `droppedNoLiveUse` is the loss: a function the original
// creates and our text does not mention.
function fate(files) {
  const R = {
    mode: 'fate', profile: PROFILE, files: [], filesOk: 0, filesFailed: 0, filesSkipped: 0,
    units: 0, compiled: 0, recovered: 0, recoverFailed: 0,
    createClosure: 0, byFate: {}, lost: 0,
    noUsersAtAll: 0, hadUsersAllDead: 0, rawUsersWereOnlyMoves: 0,
    rawUserOpcodes: {}, liveUserOpcodes: {}, lossByUnitKind: {}, lossByTargetKind: {},
    samples: [],
    // the layer's own named counters for the same question
    functionLiterals: 0, functionLiteralsInAStatement: 0,
    functionLiteralsNotInAnyStatement: 0, functionLiteralsMaterialisedForNoLiveUse: 0,
    byUnplacedFunctionLiteral: {}, droppedPureValues: 0, byDroppedPureOpcode: {},
    // the other half: a unit named by no `CreateClosure` anywhere. A top-level
    // declaration is carried by `DeclareGlobals` instead and V8 does not drop
    // those (mode `form`), so it is not loss.
    unitsNamedByACreateClosure: 0, unitsNamedByNothing: 0,
    unitsNamedByNothingTopLevelItself: 0, unitsNamedByNothingTopLevelParent: 0,
    unitsNamedByNothingDeeper: 0, unitsNamedByNothingDeeperSamples: [],
  };

  for (const file of files) {
    const { units, profile, scopeInfoById } = loadUnits(file, PROFILE);
    const unitsBySfi = new Map(units.map((u) => [u.sfiId, u]));
    R.units += units.length;
    const closureTargets = new Set();

    for (const u of units) {
      if (!u.bytecode) continue;
      R.compiled++;
      let ir, rec;
      try {
        ir = buildIR(u, { profile, scopeInfoById });
        rec = recover(ir, { unitsBySfi, debug: true });
      } catch { R.recoverFailed++; continue; }
      R.recovered++;

      const e = rec.stats.emit;
      R.functionLiterals += e.functionLiterals ?? 0;
      R.functionLiteralsInAStatement += e.functionLiteralsInAStatement ?? 0;
      R.functionLiteralsNotInAnyStatement += e.functionLiteralsNotInAnyStatement ?? 0;
      R.functionLiteralsMaterialisedForNoLiveUse += e.functionLiteralsMaterialisedForNoLiveUse ?? 0;
      R.droppedPureValues += e.droppedPureValues ?? 0;
      for (const [k, v] of Object.entries(e.byUnplacedFunctionLiteral ?? {})) bump(R.byUnplacedFunctionLiteral, k, v);
      for (const [k, v] of Object.entries(e.byDroppedPureOpcode ?? {})) bump(R.byDroppedPureOpcode, k, v);

      const { dce, canon, usesOf, stmtOverride } = rec.debug;
      for (let i = 0; i < ir.instructions.length; i++) {
        const ins = ir.instructions[i];
        if (ins.opcode !== 'CreateClosure') continue;
        R.createClosure++;
        const k = ins.operands?.find((o) => o.type === 'kConstantPoolIndex')?.constant;
        const tid = k?.t === 'sfi' ? k.sfiId : null;
        if (tid !== null) closureTargets.add(tid);

        const vid = ir.instructionValue[i];
        const v = vid >= 0 ? ir.values[vid] : null;
        const c = vid >= 0 ? canon(vid) : null;
        const raw = c === null ? [] : (ir.defUse.get(c) ?? []);
        const through = c === null ? [] : (usesOf(c) ?? []);
        const live = through.filter((x) => !dce.dead.has(x));

        let f;
        if (rec.consumed.instructions.has(i)) f = 'consumedByPattern';
        else if (vid < 0 || !v || v.kind !== 'Op') f = 'noValue';
        else if (stmtOverride.has(vid)) f = 'statementOverride';
        else if (dce.dead.has(vid) && !v.hasEffect) f = 'droppedByDce';
        else if (rec.materialised.has(c) && c === vid) f = 'materialised';
        else if (live.length) f = 'liveUse';
        else if (v.hasEffect) f = 'discardedResult';
        else f = 'droppedNoLiveUse';
        bump(R.byFate, f);

        if (f === 'liveUse') for (const x of live) bump(R.liveUserOpcodes, opOf(ir, x));
        if (f !== 'droppedByDce' && f !== 'droppedNoLiveUse') continue;

        R.lost++;
        if (!through.length) R.noUsersAtAll++; else R.hadUsersAllDead++;
        if (raw.length && !through.length) R.rawUsersWereOnlyMoves++;
        bump(R.lossByUnitKind, u.isTopLevel ? 'script' : (u.kind ?? 'function'));
        const tu = tid === null ? null : unitsBySfi.get(tid);
        bump(R.lossByTargetKind, tu ? (tu.kind ?? 'function') : 'notAUnitOfThisFile');
        for (const x of raw) bump(R.rawUserOpcodes, opOf(ir, x));
        if (R.samples.length < 40) {
          R.samples.push({
            file: path.basename(file), unit: u.sfiId, unitName: u.name ?? null,
            fate: f, target: tid, targetName: tu?.name ?? null, targetKind: tu?.kind ?? null,
            offset: ins.offset ?? null, vid, canon: c,
            next: [1, 2, 3].map((n) => ir.instructions[i + n]?.opcode ?? null),
            rawUses: raw.map((x) => ({ op: opOf(ir, x), dead: dce.dead.has(x) })).slice(0, 6),
          });
        }
      }
    }

    for (const u of units) {
      if (closureTargets.has(u.sfiId)) { R.unitsNamedByACreateClosure++; continue; }
      R.unitsNamedByNothing++;
      const parent = unitsBySfi.get(u.parentSfiId);
      if (u.isTopLevel) R.unitsNamedByNothingTopLevelItself++;
      else if (parent?.isTopLevel) R.unitsNamedByNothingTopLevelParent++;
      else {
        R.unitsNamedByNothingDeeper++;
        if (R.unitsNamedByNothingDeeperSamples.length < 20) {
          R.unitsNamedByNothingDeeperSamples.push({
            file: path.basename(file), sfiId: u.sfiId, name: u.name ?? null,
            kind: u.kind ?? null, parent: u.parentSfiId ?? null, compiled: !!u.bytecode,
          });
        }
      }
    }
    R.filesOk++;
    R.files.push({ file: path.basename(file), units: units.length });
  }

  const out = [];
  out.push(`profile ${PROFILE}`);
  out.push(`files ${R.filesOk}, units ${R.units}, recovered ${R.recovered}, recover failed ${R.recoverFailed}`);
  out.push('');
  out.push(`CreateClosure instructions                 ${R.createClosure}`);
  for (const [k, v] of Object.entries(R.byFate).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${k.padEnd(38)} ${String(v).padStart(8)} = ${pct(v, R.createClosure)}`);
  }
  out.push(`  LOST (droppedByDce + droppedNoLiveUse) ${String(R.lost).padStart(8)} = ${pct(R.lost, R.createClosure)}`);
  out.push('');
  out.push('the loss, broken down:');
  out.push(`  no users at all (after moves)             ${R.noUsersAtAll}`);
  out.push(`  had users, every one dead                 ${R.hadUsersAllDead}`);
  out.push(`  raw users existed but were all moves      ${R.rawUsersWereOnlyMoves}`);
  out.push(...(rows(R.lossByUnitKind).length ? ['  by the unit the CreateClosure is in:', ...rows(R.lossByUnitKind)] : []));
  out.push(...(rows(R.lossByTargetKind).length ? ['  by the kind of the TARGET function:', ...rows(R.lossByTargetKind)] : []));
  out.push(...(rows(R.rawUserOpcodes).length ? ['  raw users (moves included):', ...rows(R.rawUserOpcodes)] : []));
  out.push('');
  out.push("the layer's own counters for the same question:");
  out.push(`  function literals (any sfi constant)     ${R.functionLiterals}`);
  out.push(`    mentioned by an emitted statement      ${R.functionLiteralsInAStatement} = ${pct(R.functionLiteralsInAStatement, R.functionLiterals)}`);
  out.push(`    in no statement                        ${R.functionLiteralsNotInAnyStatement} = ${pct(R.functionLiteralsNotInAnyStatement, R.functionLiterals)}`);
  out.push(`    materialised for having no live use    ${R.functionLiteralsMaterialisedForNoLiveUse}`);
  out.push('  why a literal is in no statement:');
  out.push(...(rows(R.byUnplacedFunctionLiteral).length ? rows(R.byUnplacedFunctionLiteral) : ['  (none)']));
  out.push(`  pure values dropped with no statement    ${R.droppedPureValues}`);
  out.push(...rows(R.byDroppedPureOpcode, 12));
  out.push('');
  out.push('users of a closure that IS read (control):');
  out.push(...rows(R.liveUserOpcodes, 12));
  out.push('');
  out.push(`units named by a CreateClosure somewhere    ${R.unitsNamedByACreateClosure} = ${pct(R.unitsNamedByACreateClosure, R.units)}`);
  out.push(`units named by no CreateClosure at all      ${R.unitsNamedByNothing} = ${pct(R.unitsNamedByNothing, R.units)}`);
  out.push(`  is itself the script unit                 ${R.unitsNamedByNothingTopLevelItself}`);
  out.push(`  its parent is the script unit             ${R.unitsNamedByNothingTopLevelParent}`);
  out.push(`  deeper than that (unexplained)            ${R.unitsNamedByNothingDeeper}`);
  say(out);
  return R;
}

// ====================================================== cause (the T9 side)
//
// `fate` refuted the suspicion, so the question moves one layer down to where
// `src/emit/index.mjs` counts the consequence (`unreferencedClosures`): for a
// child our text declares that nothing references, where did the reference go?
const CAUSES = ['parentNotEmitted', 'parentFailed', 'parentRefused', 't7Missing',
  'inUnusedExprOnly', 'blockNotPlaced', 'blockConsumedByAConstruct', 'unexplained'];
const SUM = ['units', 'compiledUnits', 'functionsEmitted', 'functionsFailed',
  'functionsClaimedInline', 'orphans', 'unreferencedClosures',
  'unreferencedClosuresRebound', 'unreferencedClosuresAlreadyBound',
  'unreferencedClosuresAtTheTopLevel', 'unreferencedClosuresNotInTheInput',
  'functionsRefusedForAnUnplaceableBinding', 'droppedStatementsOnRemovedBlocks'];

function cause(files) {
  const R = {
    mode: 'cause', profile: PROFILE, files: [], filesOk: 0,
    units: 0, compiled: 0, pipelineFailed: 0, report: {},
    unreferenced: 0, byCause: {}, byCauseKind: {}, byChildKind: {},
    userChain: {}, samples: [], unexplainedSamples: [],
  };

  for (const file of files) {
    const { units, profile, scopeInfoById } = loadUnits(file, PROFILE);
    R.units += units.length;
    const recs = [];
    const sfs = [];
    const failures = [];
    const byId = new Map();
    for (const u of units) {
      if (!u.bytecode) continue;
      R.compiled++;
      try {
        const ir = buildIR(u, { profile, scopeInfoById });
        const rec = recover(ir, { verify: false });
        const sf = structure(ir, { profile, verify: false });
        recs.push(rec); sfs.push(sf);
        byId.set(u.sfiId, { unit: u, ir, rec, sf });
      } catch (e) {
        R.pipelineFailed++;
        failures.push({ sfiId: u.sfiId, name: u.name ?? null, stage: 'pipeline', error: String(e.message).slice(0, 200) });
      }
    }
    const out = emit(recs, sfs, { file, units, failures });
    for (const k of SUM) bump(R.report, k, out.report[k] ?? 0);

    // who the bytecode says each child belongs to, and the chain of users its
    // `CreateClosure` passes through on the way to a statement
    const parentOf = new Map();
    const chainOf = new Map();
    for (const [sfiId, e] of byId) {
      for (let i = 0; i < e.ir.instructions.length; i++) {
        const ins = e.ir.instructions[i];
        if (ins.opcode !== 'CreateClosure') continue;
        const k = ins.operands?.find((o) => o.type === 'kConstantPoolIndex')?.constant;
        if (k?.t !== 'sfi' || parentOf.has(k.sfiId)) continue;
        parentOf.set(k.sfiId, sfiId);
        const vid = e.ir.instructionValue[i];
        const users = vid >= 0 ? (e.ir.defUse.get(vid) ?? []) : [];
        chainOf.set(k.sfiId, users.map((x) => {
          const op = opOf(e.ir, x);
          const uv = e.ir.values[x];
          const claimed = uv?.kind === 'Op' && e.rec.consumed.instructions.has(uv.instruction);
          return claimed ? `${op} [consumed]` : op;
        }));
      }
    }
    const pf = new Map(out.perFunction.map((f) => [f.sfiId, f]));

    for (const m of String(out.code).matchAll(/unreferenced closure \(sfi (\d+)\)/g)) {
      const sfiId = Number(m[1]);
      R.unreferenced++;
      const child = byId.get(sfiId);
      const pid = parentOf.get(sfiId) ?? child?.unit?.parentSfiId ?? null;
      const parent = pid === null ? null : byId.get(pid);
      const pfp = pid === null ? null : pf.get(pid);

      let why;
      let detail = null;
      if (!parent || !pfp) why = 'parentNotEmitted';
      else if (pfp.failed) why = 'parentFailed';
      else if (pfp.refused) why = 'parentRefused';
      else {
        let block = null;
        for (const [bid, list] of parent.rec.stmts) {
          if (sfisIn(list).has(sfiId)) { block = bid; break; }
        }
        if (block === null) {
          why = [...parent.rec.exprs.values()].some((x) => sfisIn(x).has(sfiId))
            ? 'inUnusedExprOnly' : 't7Missing';
        } else if (!parent.sf.placed?.blocks?.has?.(block)) {
          why = parent.sf.placed?.consumed?.has?.(block)
            ? 'blockConsumedByAConstruct' : 'blockNotPlaced';
          detail = `block ${block}`;
        } else { why = 'unexplained'; detail = `block ${block}`; }
      }
      bump(R.byCause, why);
      bump(R.byChildKind, child?.unit?.kind ?? '?');
      bump(R.byCauseKind, `${why}:${child?.unit?.kind ?? '?'}`);
      const chain = chainOf.get(sfiId);
      bump(R.userChain, `${why}: ${chain?.length ? chain.join(' + ') : '(no users)'}`);
      const row = {
        file: path.basename(file), sfiId, name: child?.unit?.name ?? null,
        kind: child?.unit?.kind ?? null, parent: pid, parentName: parent?.unit?.name ?? null,
        parentTopLevel: !!parent?.unit?.isTopLevel, why, detail, chain: chain ?? null,
      };
      if (R.samples.length < 40) R.samples.push(row);
      if (why === 'unexplained' && R.unexplainedSamples.length < 20) R.unexplainedSamples.push(row);
    }
    R.filesOk++;
    R.files.push({ file: path.basename(file), units: units.length });
  }

  const out = [];
  out.push(`profile ${PROFILE}`);
  out.push(`files ${R.filesOk}, units ${R.units}, pipeline failed ${R.pipelineFailed}`);
  out.push('');
  out.push("the emit report, summed:");
  for (const k of SUM) out.push(`  ${k.padEnd(44)} ${R.report[k] ?? 0}`);
  out.push('');
  out.push(`unreferenced children found by marker      ${R.unreferenced}`);
  out.push(`  share of functions emitted               ${pct(R.unreferenced, R.report.functionsEmitted ?? 0)}`);
  out.push('');
  out.push('WHERE THE REFERENCE WENT:');
  for (const k of CAUSES) {
    if (!R.byCause[k]) continue;
    out.push(`  ${k.padEnd(28)} ${String(R.byCause[k]).padStart(8)} = ${pct(R.byCause[k], R.unreferenced)}`);
  }
  out.push('');
  out.push("by cause and the child's own kind:");
  out.push(...rows(R.byCauseKind, 30));
  out.push('');
  out.push('the users the CreateClosure passes through:');
  out.push(...rows(R.userChain, 20));
  say(out);
  return R;
}

// ============================================================ form (the mint)
//
// The premise of the fix, measured instead of argued.
// `bytecode-generator.cc::VisitFunctionDeclaration:2181` returns at :2187 when
// `!variable->is_used()`, so an inner declaration nothing reads is never
// visited: no `CreateClosure`, no SFI in the parent's constant pool, nothing
// in the cache. `VisitVariableDeclaration:2135` has the same early return at
// :2138, but it guards only the TDZ hole store -- the initialiser of
// `var f = e` is a separate assignment in the parser's output and
// `VisitAssignment` has no such guard. `VisitGlobalDeclarations:2281` has no
// test at all (it DCHECKs `is_used()` at :2285), so a top-level declaration is
// not at risk; `VisitModuleDeclarations:2258` does skip them at :2262, and
// nothing here emits a module.
//
// So the FORM decides, and the form is the emitter's choice. Each row is 100
// unreferenced functions in one script, minted with the corpus's own V8.
async function form() {
  const { mintCompileOnly, requireMatchingMinter } = await import('../../src/verify/o1_corpus.mjs');
  const WORK = path.resolve(argOf('work', 'scratch/probes/closure-form'));
  fs.mkdirSync(WORK, { recursive: true });
  const exe = requireMatchingMinter();
  const N = 100;
  const lines = (f) => { let s = ''; for (let i = 0; i < N; i++) s += f(i) + '\n'; return s; };
  const inFn = (body) => `function outer(){\n  var t = 0;\n${body}  return t;\n}\nvar z = outer();\n`;

  const cases = {
    'TOP LEVEL: function h(){}  (declaration)':
      [lines((i) => `function h${i}(a){ return a+${i}; }`), N + 1],
    'TOP LEVEL: var h = function h(){}':
      [lines((i) => `var h${i} = function h${i}(a){ return a+${i}; };`), N + 1],
    'TOP LEVEL, strict: function h(){}':
      [`'use strict';\n` + lines((i) => `function h${i}(a){ return a+${i}; }`), N + 1],
    'IN A BLOCK at top level: function h(){}':
      [`{\n${lines((i) => `  function h${i}(a){ return a+${i}; }`)}}\n`, N + 1],
    'IN A FUNCTION: function h(){}':
      [inFn(lines((i) => `  function h${i}(a){ return a+${i}; }`)), N + 2],
    'IN A FUNCTION: function* h(){}':
      [inFn(lines((i) => `  function* h${i}(a){ yield a+${i}; }`)), N + 2],
    'IN A FUNCTION: var h = function h(){}':
      [inFn(lines((i) => `  var h${i} = function h${i}(a){ return a+${i}; };`)), N + 2],
    'IN A FUNCTION, strict: var h = function h(){}':
      [`'use strict';\n` + inFn(lines((i) => `  var h${i} = function h${i}(a){ return a+${i}; };`)), N + 2],
    'IN A FUNCTION: var h = function* h(){}':
      [inFn(lines((i) => `  var h${i} = function* h${i}(a){ yield a+${i}; };`)), N + 2],
    'IN A FUNCTION: var h = async function h(){}':
      [inFn(lines((i) => `  var h${i} = async function h${i}(a){ return a+${i}; };`)), N + 2],
    'IN A FUNCTION: let h = function h(){}':
      [inFn(lines((i) => `  let h${i} = function h${i}(a){ return a+${i}; };`)), N + 2],
    'IN A FUNCTION: var h = (a)=>a':
      [inFn(lines((i) => `  var h${i} = (a)=>a+${i};`)), N + 2],
    'IN A FUNCTION: function h(){} + one reference':
      [inFn(lines((i) => `  function h${i}(a){ return a+${i}; } t += h${i};`)), N + 2],
  };

  const R = { mode: 'form', profile: PROFILE, minter: exe, rows: [] };
  let k = 0;
  for (const [shape, [src, expected]] of Object.entries(cases)) {
    const s = path.join(WORK, `form${k}.js`);
    const o = path.join(WORK, `form${k++}.jsc`);
    fs.writeFileSync(s, src, 'utf8');
    const m = mintCompileOnly({ srcPath: s, outPath: o, exe, flags: ['--no-lazy'] });
    if (!m.ok) { R.rows.push({ shape, expected, error: String(m.error).slice(0, 200) }); continue; }
    const { units } = loadUnits(o, PROFILE, { scopeInfos: false });
    R.rows.push({ shape, expected, units: units.length, carried: units.filter((u) => u.bytecode).length });
    process.stderr.write(`  ${shape}\n`);
  }

  const out = [];
  out.push(`${N} unreferenced functions per script, one spelling per row.`);
  out.push('"carried" = units with bytecode in the cache the mint produced; the');
  out.push('expected count is the enclosing unit(s) plus all 100.');
  out.push('');
  out.push('  carried / expected   shape');
  for (const r of R.rows) {
    out.push(`  ${String(r.carried ?? `ERR ${r.error}`).padStart(7)} / ${String(r.expected).padEnd(8)}  ${r.shape}`);
  }
  say(out);
  return R;
}

let result;
if (mode === 'form') {
  result = await form();
} else {
  const files = corpusFiles().filter((f) => {
    if (fs.statSync(f).size <= MAX_BYTES) return true;
    process.stderr.write(`  skipped (too big) ${path.basename(f)}\n`);
    return false;
  });
  if (!files.length) {
    process.stderr.write('no input: pass --corpus <dir> [--stride N] or one or more .jsc paths\n');
    process.exit(2);
  }
  result = mode === 'cause' ? cause(files) : fate(files);
}
process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
