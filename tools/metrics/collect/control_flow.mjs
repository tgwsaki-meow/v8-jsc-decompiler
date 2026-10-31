#!/usr/bin/env node
// Metrics 1, 2, 3 and 10: control flow present in the bytecode vs control flow
// present in the emitted JavaScript, on the SAME files.
//
// Bytecode side, per function (src/deserializer.js + src/lifter.js):
//   JumpLoop                                      loop back-edges
//   handler-table ranges                          try regions  <- the real denominator
//   Throw / ReThrow / SetPendingMessage           exception opcodes (what the
//                                                 baseline's 667 actually counted)
//   SwitchOnSmiNoFeedback / SwitchOnGeneratorState switch dispatch
//   ForInNext                                     for-in loops
//   SuspendGenerator / ResumeGenerator            generator suspends
//
// Output side, by AST (not regex: a lexical `while` also matches inside a
// string, which BASELINE_AUDIT.md 1.4 had to correct for):
//   While/DoWhile/For/ForIn/ForOf statements, TryStatement, SwitchStatement,
//   Break/Continue/Labeled statements, and the UNSTRUCTURED markers.
//
// Derived from scratch/audit/loop_matched.mjs, which produced the baseline.
// Three deliberate changes:
//   * handler-table RANGES are counted, so metric 2 has the denominator its
//     name claims; the exception-opcode count is kept beside it
//   * one child process per file, so a 10 MB input cannot take the run down
//   * the output side can come from decompiled_js/ (stored) or from a fresh
//     decompile (fresh); stored is only valid while the archive matches the
//     pipeline, which BASELINE_AUDIT.md 3.5 showed holds for 8 of 10 files
//
// Usage: node tools/metrics/collect/control_flow.mjs --mode quick --out <json>
//        node tools/metrics/collect/control_flow.mjs --file <jsc> --child <json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const LOOP_AST = /^(While|DoWhile|For|ForIn|ForOf)Statement$/;
const SKIP = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);

// --------------------------------------------------------------- child mode
if (argv.includes('--child')) {
  const jscPath = val('--file');
  const outPath = val('--child');
  const outputsFrom = val('--outputs', 'stored');
  const row = { jsc: path.basename(jscPath), inputBytes: fs.statSync(jscPath).size };
  try {
    const { JSCDeserializer } = await import('../../../src/deserializer.js');
    const { V8Profile } = await import('../../../src/profile.js');
    const { Lifter } = await import('../../../src/lifter.js');
    const profile = new V8Profile();
    const des = new JSCDeserializer(profile);
    const lifter = new Lifter(profile);
    const res = des.deserializeFile(jscPath);
    row.deserializedFunctions = res.functions.length;
    let instructions = 0, jumpLoop = 0, forIn = 0, excOps = 0, switchOps = 0, suspend = 0, handlerRanges = 0, handlerFns = 0;
    for (const fn of res.functions) {
      const hs = fn.handlers ?? [];
      handlerRanges += hs.length;
      if (hs.length) handlerFns++;
      const insts = lifter.disassemble(fn.bytecode, fn.constants);
      instructions += insts.length;
      for (const i of insts) {
        switch (i.name) {
          case 'JumpLoop': jumpLoop++; break;
          case 'ForInNext': forIn++; break;
          case 'Throw': case 'ReThrow': case 'SetPendingMessage': excOps++; break;
          case 'SwitchOnSmiNoFeedback': case 'SwitchOnGeneratorState': switchOps++; break;
          case 'SuspendGenerator': case 'ResumeGenerator': suspend++; break;
        }
      }
    }
    Object.assign(row, { instructions, jumpLoop, forIn, excOps, switchOps, suspend, handlerRanges, handlerFns, bytecodeOk: true });
  } catch (e) {
    row.bytecodeOk = false;
    row.bytecodeError = `${e?.constructor?.name}: ${String(e?.message).slice(0, 200)}`;
  }

  // output side
  let jsPath = null;
  if (outputsFrom === 'stored') {
    const p = path.join('decompiled_js', row.jsc.replace(/\.jsc$/, '.js'));
    if (fs.existsSync(p)) jsPath = p;
  } else {
    const { decompileInChild } = await import('../../../src/verify/pipeline.mjs');
    const d = decompileInChild(jscPath, { timeoutMs: Number(val('--timeout', '180000')), workDir: 'scratch/t3/work/metrics-cf' });
    row.freshStage = d.stage;
    row.freshOk = d.ok;
    if (d.ok && d.codePath) jsPath = d.codePath;
    else row.freshError = `${d.errorClass}: ${String(d.error).slice(0, 160)}`;
  }
  if (jsPath) {
    row.outputPath = jsPath;
    row.outputBytes = fs.statSync(jsPath).size;
    try {
      const { parse } = await import('@babel/parser');
      const src = fs.readFileSync(jsPath, 'utf8');
      const ast = parse(src, { sourceType: 'unambiguous', attachComment: false, tokens: false, ranges: false });
      const c = { loops: 0, whileS: 0, doWhileS: 0, forS: 0, forIn: 0, forOf: 0, tryS: 0, catchC: 0, finallyS: 0, switchS: 0, breakS: 0, continueS: 0, labeled: 0, ifS: 0, fnDecl: 0, fnExpr: 0 };
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) walk(x); return; }
        if (typeof n.type !== 'string') return;
        if (LOOP_AST.test(n.type)) {
          c.loops++;
          if (n.type === 'WhileStatement') c.whileS++;
          else if (n.type === 'DoWhileStatement') c.doWhileS++;
          else if (n.type === 'ForStatement') c.forS++;
          else if (n.type === 'ForInStatement') c.forIn++;
          else c.forOf++;
        } else if (n.type === 'TryStatement') { c.tryS++; if (n.handler) c.catchC++; if (n.finalizer) c.finallyS++; }
        else if (n.type === 'SwitchStatement') c.switchS++;
        else if (n.type === 'BreakStatement') c.breakS++;
        else if (n.type === 'ContinueStatement') c.continueS++;
        else if (n.type === 'LabeledStatement') c.labeled++;
        else if (n.type === 'IfStatement') c.ifS++;
        else if (n.type === 'FunctionDeclaration') c.fnDecl++;
        else if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') c.fnExpr++;
        for (const k in n) if (!SKIP.has(k)) walk(n[k]);
      })(ast.program);
      row.ast = c;
      row.outputParses = true;
      // metric 10: markers for regions the structuring step gave up on
      row.unstructured = {
        unstructuredComment: (src.match(/UNSTRUCTURED/g) || []).length,
        regionLabel: (src.match(/\b__region\b/g) || []).length,
        stateDispatch: (src.match(/switch\s*\(\s*__state\s*\)/g) || []).length,
        stateVar: (src.match(/\b__state\b/g) || []).length,
      };
    } catch (e) {
      row.outputParses = false;
      row.outputParseError = `${e?.constructor?.name}: ${String(e?.message).slice(0, 160)}`;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(row));
  process.exit(0);
}

// -------------------------------------------------------------- driver mode
const mode = val('--mode', 'quick');
const outputsFrom = val('--outputs', 'stored');
const outPath = val('--out', `scratch/t3/metrics/control_flow.${mode}.json`);
const { controlFlowSample } = await import('../samples.mjs');
const sample = controlFlowSample(mode);
const work = 'scratch/t3/work/metrics-cf';
fs.mkdirSync(work, { recursive: true });

const rows = [];
for (const f of sample.files) {
  const childOut = path.join(work, f.name + '.cf.json');
  fs.rmSync(childOut, { force: true });
  const logFd = fs.openSync(path.join(work, f.name + '.cf.log'), 'w');
  try {
    spawnSync(process.execPath, ['--max-old-space-size=1400', import.meta.filename ?? process.argv[1],
      '--file', f.path, '--child', childOut, '--outputs', outputsFrom, '--timeout', val('--timeout', '180000')],
      { stdio: ['ignore', logFd, logFd], timeout: Number(val('--filetimeout', '300000')), windowsHide: true });
  } finally { fs.closeSync(logFd); }
  if (fs.existsSync(childOut)) rows.push(JSON.parse(fs.readFileSync(childOut, 'utf8')));
  else rows.push({ jsc: f.name, inputBytes: f.size, bytecodeOk: false, bytecodeError: 'child produced no result (timeout or crash)' });
  const r = rows[rows.length - 1];
  process.stderr.write(`${r.jsc.padEnd(40)} JumpLoop=${r.jumpLoop ?? '-'} handlerRanges=${r.handlerRanges ?? '-'} excOps=${r.excOps ?? '-'} switchOps=${r.switchOps ?? '-'} -> loops=${r.ast?.loops ?? '-'} try=${r.ast?.tryS ?? '-'} switch=${r.ast?.switchS ?? '-'}\n`);
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const sumAst = (k) => rows.reduce((a, r) => a + (r.ast?.[k] ?? 0), 0);
const sumUn = (k) => rows.reduce((a, r) => a + (r.unstructured?.[k] ?? 0), 0);
const paired = rows.filter((r) => r.bytecodeOk && r.ast);

const result = {
  collector: 'control_flow',
  generatedAt: new Date().toISOString(),
  mode, outputsFrom,
  sample: { ...sample, files: sample.files.map((f) => ({ name: f.name, size: f.size })) },
  filesAttempted: rows.length,
  filesPaired: paired.length,
  bytecode: {
    functions: sum('deserializedFunctions'), instructions: sum('instructions'),
    jumpLoop: sum('jumpLoop'), forInNext: sum('forIn'),
    handlerRanges: sum('handlerRanges'), functionsWithHandlers: sum('handlerFns'),
    exceptionOpcodes: sum('excOps'), switchDispatchOpcodes: sum('switchOps'),
    generatorSuspends: sum('suspend'),
  },
  emitted: {
    loops: sumAst('loops'), while: sumAst('whileS'), doWhile: sumAst('doWhileS'),
    for: sumAst('forS'), forIn: sumAst('forIn'), forOf: sumAst('forOf'),
    try: sumAst('tryS'), catch: sumAst('catchC'), finally: sumAst('finallyS'),
    switch: sumAst('switchS'), break: sumAst('breakS'), continue: sumAst('continueS'),
    labeled: sumAst('labeled'), if: sumAst('ifS'),
    functionDeclarations: sumAst('fnDecl'), functionExpressions: sumAst('fnExpr'),
  },
  unstructuredMarkers: {
    unstructuredComment: sumUn('unstructuredComment'), regionLabel: sumUn('regionLabel'),
    stateDispatch: sumUn('stateDispatch'), stateVar: sumUn('stateVar'),
  },
  metrics: {
    m1_loopsPerBackEdge: { numerator: sumAst('loops'), denominator: sum('jumpLoop') },
    // `tryS`, not `try`: the per-file counter is named `tryS` because `try` is
    // a reserved word and an object literal key of that name reads badly next
    // to `catch`/`finally`. Asking sumAst() for 'try' returned undefined, so
    // BOTH of these metrics reported `0 / N` for every pipeline ever measured,
    // including the ones that really did emit a `try`. The `emitted` block
    // above maps it correctly (`try: sumAst('tryS')`), which is why the
    // dashboard's own detail rows disagreed with its metric rows.
    m2_tryPerHandlerRange: { numerator: sumAst('tryS'), denominator: sum('handlerRanges') },
    m2_tryPerExceptionOpcode: { numerator: sumAst('tryS'), denominator: sum('excOps'), note: 'the denominator BASELINE_AUDIT.md 5.4 actually used for its 667' },
    m3_switchPerDispatchOpcode: { numerator: sumAst('switchS'), denominator: sum('switchOps') },
    m10_unstructuredRegions: { value: sumUn('unstructuredComment') + sumUn('regionLabel') + sumUn('stateDispatch') },
  },
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.metrics, null, 1));
console.log(`wrote ${outPath}`);
