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
//   context  what a class body COSTS, which is docs/RECOVER.md 9.7. A class
//            body is always strict code, and `Scope::AllocateVariablesRecursively`
//            forces a context for any non-function scope whose language mode is
//            stricter than its outer scope's -- so a class in SLOPPY text gets a
//            `CreateBlockContext` the same class in STRICT text does not, and
//            every slot a member captures goes one PREVIOUS_INDEX hop deeper.
//            The original states its own language mode in every ScopeInfo; this
//            mode counts how often we emit a different one, and how many class
//            members pay for it.
//
//   node tools/probes/probe_class.mjs shape   --corpus extracted_jsc --stride 37
//   node tools/probes/probe_class.mjs members --corpus extracted_jsc --stride 37
//   node tools/probes/probe_class.mjs emit    --corpus extracted_jsc --stride 37
//   node tools/probes/probe_class.mjs context --corpus extracted_jsc --stride 37
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

// ============================================================ context
//
// THE COST OF THE CLASS BODY, and whose property it is.
//
// `VisitClassLiteral:3836` pushes a block context for the class iff
// `expr->scope()->NeedsContext()` (:3838 -> `BuildNewLocalBlockContext` :3852).
// A ClassScope's language mode is always strict, and
// `Scope::AllocateVariablesRecursively` forces a context on any scope that is
// stricter than its outer scope -- so the answer depends on the language mode
// of the code the class SITS IN, not on anything about the class.
//
// We emit every function as sloppy. The original says what it was, in
// `ScopeInfo::flags.language_mode` (`src/heap/objects.mjs:197`), per scope. So
// the question this mode answers is: how many class members are emitted into a
// class body that our text puts in sloppy code and the original put in strict?
// Each one of those reads every captured slot one hop too deep.

function contexts(files) {
  const R = {
    mode: 'context', profile: PROFILE, files: 0, units: 0, compiled: 0, pipelineFailed: 0,
    unitsByMode: {}, unitsByModeAndKind: {},
    strictnessBegins: 0, strictnessBeginsWithARestParameter: 0,
    sloppyUnitInsideAStrictOne: 0, sloppyInsideStrictSamples: [],
    unitHasNoScopeInfo: 0,
    classesWithMembers: 0, classesWithMembersByHolderMode: {},
    members: 0, membersByHolderMode: {},
    membersReadingAnEnclosingSlot: 0, membersReadingAnEnclosingSlotByHolderMode: {},
    membersWithNoUnit: 0, samples: [],
  };

  const modeOf = (u) => u?.scope?.languageMode ?? 'noScopeInfo';

  for (const file of files) {
    let L;
    try { L = loadUnits(file, PROFILE); } catch { continue; }
    R.files++;
    const { units, profile, scopeInfoById } = L;
    const bySfi = new Map(units.map((u) => [u.sfiId, u]));

    // ---- 1. the census, and the invariant the fix depends on: strictness is
    //         INHERITED in the original, so a sloppy unit never sits inside a
    //         strict one. If that holds, one directive at the outermost strict
    //         unit reproduces the original's language mode for its whole
    //         subtree; if it does not, the directive would make a descendant
    //         strict that the original compiled sloppy.
    for (const u of units) {
      R.units++;
      if (u.bytecode) R.compiled++;
      const m = modeOf(u);
      if (m === 'noScopeInfo') R.unitHasNoScopeInfo++;
      bump(R.unitsByMode, m);
      bump(R.unitsByModeAndKind, `${m} / ${u.isTopLevel ? 'script' : (u.kind ?? 'function')}`);
      const p = bySfi.get(u.parentSfiId);
      if (m === 'kStrict' && p && modeOf(p) !== 'kStrict') R.strictnessBegins++;
      if (m === 'kSloppy' && p && modeOf(p) === 'kStrict') {
        R.sloppyUnitInsideAStrictOne++;
        if (R.sloppyInsideStrictSamples.length < 12) {
          R.sloppyInsideStrictSamples.push({
            file: path.basename(file), sfi: u.sfiId, name: u.name ?? null,
            kind: u.kind ?? null, parent: u.parentSfiId ?? null,
          });
        }
      }
    }

    // ---- 2. the pipeline, once per unit
    const byId = new Map();
    for (const u of units) {
      if (!u.bytecode) continue;
      try {
        const ir = buildIR(u, { profile, scopeInfoById });
        const rec = recover(ir, { verify: false });
        byId.set(u.sfiId, { u, ir, rec });
      } catch { R.pipelineFailed++; }
    }

    /** Does this unit read a slot of a context some ENCLOSING scope owns? */
    const readsAnEnclosingSlot = (e) => {
      const frames = e.ir.contextChain?.frames ?? [];
      for (const id of e.ir.contextSlotValues?.values() ?? []) {
        const loc = e.ir.values[id];
        if (!loc || loc.kind !== 'ContextSlot') continue;
        const f = frames[loc.frame];
        if (f && f.kind !== 'created') return true;
      }
      return false;
    };
    const hasRest = (e) => (e.rec.names.declarations ?? []).some((d) => d.rest);

    for (const u of units) {
      const m = modeOf(u);
      const e = byId.get(u.sfiId);
      const p = bySfi.get(u.parentSfiId);
      if (m === 'kStrict' && p && modeOf(p) !== 'kStrict' && e && hasRest(e)) {
        R.strictnessBeginsWithARestParameter++;
      }
    }

    // ---- 3. the classes, and the members that pay
    for (const [, e] of byId) {
      const holderMode = modeOf(e.u);
      const seen = new Set();
      const walk = (x) => {
        if (!x || typeof x !== 'object' || seen.has(x)) return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        seen.add(x);
        if (x.e === 'class' && (x.members ?? []).length) {
          R.classesWithMembers++;
          bump(R.classesWithMembersByHolderMode, holderMode);
          for (const mem of x.members) {
            R.members++;
            bump(R.membersByHolderMode, holderMode);
            const me = mem.value?.sfiId === undefined ? null : byId.get(mem.value.sfiId);
            if (!me) { R.membersWithNoUnit++; continue; }
            if (!readsAnEnclosingSlot(me)) continue;
            R.membersReadingAnEnclosingSlot++;
            bump(R.membersReadingAnEnclosingSlotByHolderMode, holderMode);
            if (R.samples.length < 12) {
              R.samples.push({
                file: path.basename(file), holder: e.u.sfiId, holderName: e.u.name ?? null,
                holderMode, member: `${mem.static ? 'static ' : ''}${mem.kind} ${mem.computed ? '[computed]' : mem.key}`,
                memberSfi: mem.value.sfiId,
              });
            }
          }
        }
        for (const k of Object.keys(x)) { if (k !== 'pos' && k !== 'values' && k !== 'ref') walk(x[k]); }
      };
      for (const l of e.rec.stmts.values()) walk(l);
      for (const x of e.rec.exprs.values()) walk(x);
    }
  }

  const out = [`profile ${PROFILE}`, `files ${R.files}, units ${R.units}, compiled ${R.compiled}, `
    + `pipeline failures ${R.pipelineFailed}`, ''];
  out.push('units by the language mode their OWN ScopeInfo states:', ...rows(R.unitsByMode), '');
  out.push('by mode and kind:', ...rows(R.unitsByModeAndKind, 14), '');
  out.push(`strict units whose parent is not strict (where a directive would go) ${R.strictnessBegins}`);
  out.push(`  ... of those, with a rest parameter, where a directive is a SyntaxError ${R.strictnessBeginsWithARestParameter}`);
  out.push(`sloppy units inside a strict one (must be 0 for inheritance to hold)   ${R.sloppyUnitInsideAStrictOne}`);
  for (const s of R.sloppyInsideStrictSamples) out.push(`    ${s.file} sfi ${s.sfi} ${s.name ?? '?'} (${s.kind}) parent ${s.parent}`);
  out.push(`units with no ScopeInfo at all ${R.unitHasNoScopeInfo}`, '');
  out.push(`classes with at least one member ${R.classesWithMembers}`, ...rows(R.classesWithMembersByHolderMode), '');
  out.push(`members placed in a class body ${R.members}`, ...rows(R.membersByHolderMode), '');
  out.push(`members that read a slot of an ENCLOSING context ${R.membersReadingAnEnclosingSlot}`,
    ...rows(R.membersReadingAnEnclosingSlotByHolderMode), '');
  out.push(`members whose unit is not in this file ${R.membersWithNoUnit}`, '');
  out.push('samples:');
  for (const s of R.samples) {
    out.push(`  ${s.file} holder sfi ${s.holder} ${s.holderName ?? '?'} [${s.holderMode}] -> ${s.member} (sfi ${s.memberSfi})`);
  }
  say(out);
  return R;
}

const files = corpusFiles();
const result = mode === 'members' ? members(files)
  : (mode === 'emit' ? emitted(files)
    : (mode === 'context' ? contexts(files) : shape(files)));
process.stdout.write(JSON.stringify(result, null, 1));
