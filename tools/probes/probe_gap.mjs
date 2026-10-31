// Is the A-side unpaired count a real absence, or does the measurement lose
// functions between "we emitted it" and "stream B carries it"?
//
// Three independent counts of the same text:
//   1. what our emitter says it emitted           (report.functionsEmitted)
//   2. function literals actually present in the text, by Babel
//   3. BytecodeArrays our loader finds in the .jsc minted from that text
//
// If (2) >> (3) the mint or the loader is dropping functions and the whole
// measurement is unsound. If (2) ~ (3) the gap is real output loss.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { decompile } from '../../src/emit/decompile.mjs';
import { loadUnits } from '../../src/load/index.mjs';
import { mintCompileOnly, requireMatchingMinter } from '../../src/verify/o1_corpus.mjs';

const file = process.argv[2] ?? 'extracted_jsc/r_18269.jsc';
const PROFILE = 'profiles/14.4.258.16';
const WORK = path.resolve('scratch/o1corpus/gap');
fs.mkdirSync(WORK, { recursive: true });
const id = path.basename(file).replace(/\.jsc$/, '');

const A = loadUnits(file, PROFILE, { scopeInfos: false });
const aCompiled = A.units.filter((u) => u.bytecode).length;

const r = decompile(file, { profile: PROFILE });
const codePath = path.join(WORK, `${id}.js`);
fs.writeFileSync(codePath, r.code, 'utf8');

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ObjectMethod', 'ClassPrivateMethod']);
let literals = 0;
const byType = {};
let parseError = null;
try {
  const ast = parse(r.code, { sourceType: 'script', errorRecovery: false });
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (typeof n.type === 'string' && FN.has(n.type)) { literals++; byType[n.type] = (byType[n.type] ?? 0) + 1; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      walk(n[k]);
    }
  };
  walk(ast.program.body);
} catch (e) { parseError = `${e.constructor.name}: ${e.message}`.slice(0, 200); }

const jscB = path.join(WORK, `${id}.B.jsc`);
const m = mintCompileOnly({ srcPath: codePath, outPath: jscB, exe: requireMatchingMinter() });
let bUnits = null, bCompiled = null, bErr = null;
if (m.ok) {
  try {
    const B = loadUnits(jscB, PROFILE, { scopeInfos: false });
    bUnits = B.units.length;
    bCompiled = B.units.filter((u) => u.bytecode).length;
  } catch (e) { bErr = `${e.constructor.name}: ${e.message}`.slice(0, 200); }
}

// and the same source with --no-lazy removed, to show the flag is load-bearing
const jscBare = path.join(WORK, `${id}.bare.jsc`);
const mb = mintCompileOnly({ srcPath: codePath, outPath: jscBare, exe: requireMatchingMinter(), flags: [] });
let bareCompiled = null;
if (mb.ok) { try { bareCompiled = loadUnits(jscBare, PROFILE, { scopeInfos: false }).units.filter((u) => u.bytecode).length; } catch { /* reported as null */ } }

console.log(JSON.stringify({
  file,
  'A: units with bytecode (corpus)': aCompiled,
  'emit: report.functionsEmitted': r.report.functionsEmitted,
  'emit: functionsClaimedInline': r.report.functionsClaimedInline,
  'emit: functionsFailed': r.report.functionsFailed,
  'emit: orphans': r.report.orphans,
  'emit: droppedStatementBlocks': r.report.droppedStatementBlocks,
  'emit: holes': r.report.holes?.total,
  'text: function literals by Babel': literals,
  'text: by type': byType,
  'text: parse error': parseError,
  'text: bytes': r.report.codeBytes,
  'mint ok': m.ok, 'mint error': m.error ?? null,
  'B: units': bUnits, 'B: units with bytecode': bCompiled, 'B: load error': bErr,
  'B without --no-lazy: units with bytecode': bareCompiled,
}, null, 1));
