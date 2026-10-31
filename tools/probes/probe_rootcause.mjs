// Corroboration for the #1 ranked cause: are closure variables being
// re-declared as function locals instead of shared through a context?
//
// `src/emit/index.mjs`'s own report already counts the decision
// (`outerSlotDeclaredLocally`, `namesReadButNeverWritten`), and
// `src/disasm`'s histogram counts the context opcodes on both sides. If the
// ranked list is right, stream A has CreateFunctionContext / PushContext /
// Sta*ContextSlot* and stream B has almost none.
import fs from 'node:fs';
import path from 'node:path';
import { decompile } from '../../src/emit/decompile.mjs';
import { loadUnits } from '../../src/load/index.mjs';
import { disassemble } from '../../src/disasm/index.mjs';
import { mintCompileOnly, requireMatchingMinter } from '../../src/verify/o1_corpus.mjs';

const PROFILE = 'profiles/14.4.258.16';
const WORK = path.resolve('scratch/o1corpus/rootcause');
fs.mkdirSync(WORK, { recursive: true });
const EXE = requireMatchingMinter();
const KEYS = ['CreateFunctionContext', 'CreateFunctionContextWithCells', 'CreateBlockContext',
  'PushContext', 'PopContext', 'StaCurrentContextSlotNoCell', 'StaContextSlot',
  'StaCurrentContextSlot', 'LdaImmutableCurrentContextSlot', 'LdaImmutableContextSlot',
  'LdaCurrentContextSlotNoCell', 'LdaContextSlot', 'ThrowReferenceErrorIfHole',
  'LdaUndefined', 'CreateClosure'];

function histogram(jsc) {
  const { units, profile } = loadUnits(jsc, PROFILE, { scopeInfos: false });
  const h = {};
  let instructions = 0, functions = 0;
  for (const u of units) {
    if (!u.bytecode) continue;
    functions++;
    const d = disassemble(u, { profile, strict: false, resolveConstants: false });
    instructions += d.instructions.length;
    for (const [k, n] of d.stats.opcodeHistogram) if (KEYS.includes(k)) h[k] = (h[k] ?? 0) + n;
  }
  return { functions, instructions, h };
}

const out = [];
for (const f of process.argv.slice(2)) {
  const id = path.basename(f).replace(/\.jsc$/, '');
  const r = decompile(f, { profile: PROFILE });
  const codePath = path.join(WORK, `${id}.js`);
  fs.writeFileSync(codePath, r.code, 'utf8');
  const jscB = path.join(WORK, `${id}.B.jsc`);
  const m = mintCompileOnly({ srcPath: codePath, outPath: jscB, exe: EXE });
  const A = histogram(f);
  const B = m.ok ? histogram(jscB) : null;
  out.push({
    file: path.basename(f),
    emit: {
      functionsEmitted: r.report.functionsEmitted,
      outerSlotDeclaredLocally: r.report.outerSlotDeclaredLocally,
      localsRenamed: r.report.localsRenamed,
      namesDeclared: r.report.namesDeclared,
      namesReadButNeverWritten: r.report.namesReadButNeverWritten,
      unresolvedNames: r.report.unresolvedNames,
      globalReads: r.report.globalReads,
      duplicatedValues: r.report.duplicatedValues,
      holes: r.report.holes?.total,
      droppedStatementBlocks: r.report.droppedStatementBlocks,
    },
    A: { functions: A.functions, instructions: A.instructions },
    B: B ? { functions: B.functions, instructions: B.instructions } : { error: m.error?.slice(0, 160) },
    opcodes: Object.fromEntries(KEYS.map((k) => [k, [A.h[k] ?? 0, B ? (B.h[k] ?? 0) : null]])),
  });
}
console.log(JSON.stringify(out, null, 1));
