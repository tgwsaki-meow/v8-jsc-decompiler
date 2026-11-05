// tools/probes/probe_class.mjs
//
// What is actually in a corpus `ClassBoilerplate`, and what reaches the output?
//
// docs/RECOVER.md 9.6 measured the cost of not decoding it: 648 of 5 284
// function literals -- 12.3% -- were class members emitted as SIBLING
// declarations next to a class whose body was empty, counted as
// `classMembersNotDecoded`. This probe is the evidence for the decode that
// closed it, and for the two parts of the shape that are still refused.
//
// Three questions, one per mode:
//
//   shape    per boilerplate, what the seven fields hold: which class each of
//            the six templates is, how many descriptors it carries, and which
//            of them are members as against the five descriptors
//            `ObjectDescriptor::AddConstant` adds itself. This is the question
//            `src/heap/objects.mjs::decodeClassBoilerplate` was written
//            against, and the answer decides which shapes are worth decoding
//            and which are worth refusing by name.
//
//   members  the join: every member the decode found, with the argument index
//            it names, checked against the %DefineClass argument list T7 sees.
//            An index outside the call's own register list would mean the
//            `Smi(value_index)` reading is wrong, and nothing downstream could
//            catch it.
//
//   emit     the whole pipeline: how many members land inside a class body,
//            how many classes are still empty, and every named refusal with
//            its count. The row this exists to move is
//            `classMembersNotDecoded`.
//
//   node tools/probes/probe_class.mjs shape   --corpus extracted_jsc --stride 37
//   node tools/probes/probe_class.mjs members --corpus extracted_jsc --stride 37
//   node tools/probes/probe_class.mjs emit    --corpus extracted_jsc --stride 37
//
// All three need the corpus (`extracted_jsc/`, not public). A table goes to
// stderr and one JSON object to stdout. Nothing from the corpus is executed.

import fs from 'node:fs';
import path from 'node:path';
import { loadUnits } from '../../src/load/index.mjs';
import { buildIR } from '../../src/ir/index.mjs';
import { recover } from '../../src/recover/index.mjs';
import { structure } from '../../src/structure/index.mjs';
import { emit } from '../../src/emit/index.mjs';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'shape';
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const PROFILE = argOf('profile', 'profiles/14.4.258.16');
const CORPUS = argOf('corpus', 'extracted_jsc');
const STRIDE = Number(argOf('stride', '37'));
const MAX_BYTES = Number(argOf('max-bytes', '2500000'));

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : 'n/a');
const rows = (o, n = 30) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `  ${String(v).padStart(8)}  ${k}`);
const say = (lines) => process.stderr.write(lines.join('\n') + '\n');

function corpusFiles() {
  if (!fs.existsSync(CORPUS)) {
    process.stderr.write(`no corpus at ${CORPUS}; this probe needs extracted_jsc/\n`);
    process.exit(2);
  }
  return fs.readdirSync(CORPUS).filter((f) => f.endsWith('.jsc')).sort()
    .filter((_, i) => i % STRIDE === 0)
    .map((f) => path.join(CORPUS, f))
    .filter((f) => fs.statSync(f).size <= MAX_BYTES);
}

/** Every ClassBoilerplate constant of every unit, with the unit it is in. */
function* boilerplates(units) {
  for (const u of units) {
    for (const c of u.constants ?? []) if (c?.t === 'classBoilerplate') yield { unit: u, cb: c };
  }
}

// ============================================================ shape
//
// The seven fields, read as data rather than as the set of shapes
// literal-objects.cc could in principle produce.

function shape(files) {
  const R = {
    mode: 'shape', profile: PROFILE, files: 0, boilerplates: 0,
    argumentsCount: {}, descriptorsPerSide: {}, templateClass: {},
    entriesByKind: {}, synthesisedBy: {}, refusals: {},
    argumentsUnclaimed: {}, totals: { entries: 0, synthesised: 0, descriptors: 0, unclaimed: 0 },
  };
  for (const file of files) {
    let L;
    try { L = loadUnits(file, PROFILE); } catch { continue; }
    R.files++;
    const { ctx, graph, units } = L;
    // the templates, by the class the map resolves to -- the decode's own
    // branch point, so it is counted from the objects and not inferred
    for (const rec of graph.objects) {
      if (ctx.classifier.mapName(rec.map) !== 'ClassBoilerplateMap') continue;
      const cls = ctx.classifyObject(rec);
      bump(R.templateClass, `boilerplate map resolves to ${cls?.className ?? '(no layout)'}`);
    }
    for (const { cb } of boilerplates(units)) {
      R.boilerplates++;
      bump(R.argumentsCount, `arguments_count=${cb.argumentsCount}`);
      bump(R.argumentsUnclaimed, `unclaimed=${cb.argumentsUnclaimed}`);
      R.totals.entries += cb.entries.length;
      R.totals.synthesised += cb.synthesised.length;
      R.totals.descriptors += cb.descriptorsRead;
      R.totals.unclaimed += cb.argumentsUnclaimed ?? 0;
      for (const e of cb.entries) bump(R.entriesByKind, `${e.side}/${e.kind}/${e.keyKind}`);
      for (const s of cb.synthesised) {
        bump(R.synthesisedBy, `${s.side} ${JSON.stringify(s.key)} -> ${s.valueRoot ?? s.valueClass ?? `args[${s.valueIndex}]`}`);
      }
      for (const r of cb.refusals) bump(R.refusals, `${r.side ?? '-'} ${r.why}${r.detail ? `:${r.detail}` : ''}`);
      bump(R.descriptorsPerSide, `descriptors=${cb.descriptorsRead}`);
    }
  }
  const out = [`profile ${PROFILE}`, `files ${R.files}, ClassBoilerplate constants ${R.boilerplates}`, ''];
  out.push('what the map resolves to:', ...rows(R.templateClass, 6), '');
  out.push(`descriptors read ${R.totals.descriptors}, members ${R.totals.entries}, `
    + `added by V8 ${R.totals.synthesised}, dynamic arguments no template describes ${R.totals.unclaimed}`, '');
  out.push('members by side / kind / key kind:', ...rows(R.entriesByKind), '');
  out.push("the descriptors ObjectDescriptor::AddConstant adds (not members):", ...rows(R.synthesisedBy, 10), '');
  out.push('refusals:', ...(Object.keys(R.refusals).length ? rows(R.refusals) : ['  (none)']), '');
  out.push('arguments_count distribution:', ...rows(R.argumentsCount, 12));
  say(out);
  return R;
}

// ============================================================ members
//
// The join T7 makes: boilerplate index i is %DefineClass's args[i].

function members(files) {
  const R = {
    mode: 'members', profile: PROFILE, files: 0, classes: 0, classesWithAMemberList: 0,
    membersInT7: 0, notPlaced: {}, byKind: {}, indexOutsideTheCall: 0,
    valueNotAClosure: 0, samples: [],
  };
  for (const file of files) {
    let L;
    try { L = loadUnits(file, PROFILE); } catch { continue; }
    R.files++;
    const { units, profile, scopeInfoById } = L;
    for (const u of units) {
      if (!u.bytecode) continue;
      let rec;
      try {
        const ir = buildIR(u, { profile, scopeInfoById });
        rec = recover(ir, { verify: false });
      } catch { continue; }
      const seen = new Set();
      const walk = (x) => {
        if (!x || typeof x !== 'object' || seen.has(x)) return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        seen.add(x);
        if (x.e === 'class') {
          R.classes++;
          if (x.membersDecoded) R.classesWithAMemberList++;
          R.membersInT7 += (x.members ?? []).length;
          for (const m of x.members ?? []) {
            bump(R.byKind, `${m.static ? 'static ' : ''}${m.kind}${m.computed ? ' [computed]' : ''}`);
            if (m.value?.e !== 'fn') R.valueNotAClosure++;
          }
          for (const r of x.membersNotPlaced ?? []) bump(R.notPlaced, r.why);
          if (R.samples.length < 12 && (x.members ?? []).length) {
            R.samples.push({
              file: path.basename(file), sfi: u.sfiId, name: x.name ?? null,
              members: x.members.map((m) => `${m.static ? 'static ' : ''}${m.kind} `
                + `${m.computed ? '[computed]' : m.key} = sfi ${m.value?.sfiId}`),
              notPlaced: (x.membersNotPlaced ?? []).map((r) => r.why),
            });
          }
        }
        for (const k of Object.keys(x)) { if (k !== 'pos' && k !== 'values' && k !== 'ref') walk(x[k]); }
      };
      for (const l of rec.stmts.values()) walk(l);
      for (const e of rec.exprs.values()) walk(e);
    }
  }
  const out = [`profile ${PROFILE}`, `files ${R.files}`, ''];
  out.push(`{e:'class'} nodes ${R.classes}, with a decoded member list ${R.classesWithAMemberList} `
    + `= ${pct(R.classesWithAMemberList, R.classes)}`);
  out.push(`members carried into {e:'class'}.members: ${R.membersInT7}`);
  out.push(`members whose value is not a closure: ${R.valueNotAClosure}`, '');
  out.push('members by kind:', ...rows(R.byKind), '');
  out.push('refused, by reason:', ...(Object.keys(R.notPlaced).length ? rows(R.notPlaced) : ['  (none)']), '');
  out.push('samples:');
  for (const s of R.samples) {
    out.push(`  ${s.file} sfi ${s.sfi} ${s.name ?? '(anonymous)'}: ${s.members.join(' | ')}`
      + (s.notPlaced.length ? `   refused: ${s.notPlaced.join(',')}` : ''));
  }
  say(out);
  return R;
}

// ============================================================ emit
//
// The number docs/RECOVER.md 9.6 is about.

function emitted(files) {
  const SUM = ['units', 'compiledUnits', 'functionsEmitted', 'functionsClaimedInline',
    'classMembersPlaced', 'classArgumentsNoTemplateDescribes', 'unreferencedClosures',
    'unreferencedClosuresRebound'];
  const R = {
    mode: 'emit', profile: PROFILE, files: 0, pipelineFailed: 0,
    report: {}, holes: {}, classHoles: {}, holesTotal: 0,
    functionLiteralsNotInAnyStatement: {}, literalsInAStatement: 0, literalsTotal: 0,
  };
  for (const file of files) {
    let L;
    try { L = loadUnits(file, PROFILE); } catch { continue; }
    R.files++;
    const { units, profile, scopeInfoById } = L;
    const recs = [];
    const sfs = [];
    const failures = [];
    for (const u of units) {
      if (!u.bytecode) continue;
      try {
        const ir = buildIR(u, { profile, scopeInfoById });
        const rec = recover(ir, { verify: false });
        recs.push(rec);
        sfs.push(structure(ir, { profile, verify: false }));
        const s = rec.stats.emit ?? {};
        R.literalsTotal += s.functionLiterals ?? 0;
        R.literalsInAStatement += s.functionLiteralsInAStatement ?? 0;
        for (const [k, v] of Object.entries(s.byUnplacedFunctionLiteral ?? {})) bump(R.functionLiteralsNotInAnyStatement, k, v);
      } catch (e) {
        R.pipelineFailed++;
        failures.push({ sfiId: u.sfiId, name: u.name ?? null, stage: 'pipeline', error: String(e.message).slice(0, 160) });
      }
    }
    let out;
    try { out = emit(recs, sfs, { file, units, failures }); } catch { continue; }
    for (const k of SUM) bump(R.report, k, out.report[k] ?? 0);
    R.holesTotal += out.report.holes.total;
    for (const [k, v] of Object.entries(out.report.holes.byWhy ?? {})) {
      bump(R.holes, k, v);
      if (/^class/.test(k)) bump(R.classHoles, k, v);
    }
  }
  const out = [`profile ${PROFILE}`, `files ${R.files}, pipeline failures ${R.pipelineFailed}`, ''];
  for (const k of SUM) out.push(`  ${k.padEnd(40)} ${R.report[k] ?? 0}`);
  out.push('');
  out.push(`function literals ${R.literalsTotal}, in a statement ${R.literalsInAStatement} `
    + `= ${pct(R.literalsInAStatement, R.literalsTotal)}`);
  out.push('function literals in no statement, by reason:',
    ...(Object.keys(R.functionLiteralsNotInAnyStatement).length
      ? rows(R.functionLiteralsNotInAnyStatement) : ['  (none)']), '');
  out.push(`holes ${R.holesTotal}; the class rows:`,
    ...(Object.keys(R.classHoles).length ? rows(R.classHoles) : ['  (none)']), '');
  out.push('all holes, top 20:', ...rows(R.holes, 20));
  say(out);
  return R;
}

const files = corpusFiles();
const result = mode === 'members' ? members(files) : (mode === 'emit' ? emitted(files) : shape(files));
process.stdout.write(JSON.stringify(result, null, 1));
