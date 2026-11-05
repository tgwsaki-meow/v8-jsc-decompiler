// src/emit/index.mjs
//
// Stage E of ARCHITECTURE.md 4.5, and the join of 11.3: T7's values and T8's
// graph shape become one JavaScript file.
//
//   emit(recovered, structured, opts) -> { code, map, ast, perFunction, report }
//
// `recovered` / `structured` are the arrays T7 and T8 produce for one .jsc, in
// the same unit order (a single pair is accepted too). `decompile.mjs` is the
// 11.4 entry point that runs the whole pipeline to get them.
//
// Layering (11.0): this directory imports src/ir, src/structure and src/load
// and nothing from src/verify/ or tools/. It holds no version literal --
// everything version-specific was resolved upstream, which is what makes the
// emitter version-independent rather than accidentally compatible.
//
// ---------------------------------------------------------------------------
// FUNCTIONS ARE EMITTED NESTED, AND THAT IS A CORRECTNESS DECISION
//
// Each unit becomes one function, placed inside the unit its SFI names as its
// parent, with `{e:'fn', sfiId}` emitting a reference to that nested
// declaration's name. The flat alternative -- every unit a top-level function
// -- is simpler and WRONG: `LdaContextSlot depth 1` is a read of the
// ENCLOSING function's variable, and T7 resolves it to that variable's real
// ScopeInfo name (docs/RECOVER.md 4). Emitted flat, that name is free, so
// every closure variable becomes an undeclared global; emitted nested, the
// enclosing function's declaration is in scope and the closure is intact.
// names.mjs rule 3 is the other half of the same decision.
//
// The top-level unit is the exception: its body is the FILE's top level, not a
// function. A `.jsc` top-level unit IS the script, so wrapping it in a
// function would add a frame V8 never compiled -- and the oracles compare our
// text's script function against the original's.
//
// Three consequences, all measured rather than assumed:
//   * a unit whose parent is missing, or whose parent failed, is emitted at
//     the top level with an `ORPHAN` marker, so 11.5's "every function enters
//     the output" cannot be lost to a broken parent link;
//   * a class constructor referenced by `{e:'class'}` and an object literal's
//     accessor are emitted INLINE (a `super` inside them is only legal there)
//     and `claimed` keeps them from also being emitted as a sibling;
//   * names are allocated once for the whole file, so a reference by name can
//     never resolve to the wrong function.

import * as t from '@babel/types';
import generatorModule from '@babel/generator';
import { structureFacts } from '../structure/facts.mjs';
import { terminatorInputs } from '../structure/conditions.mjs';
import { planNames, declarationPrologue, sanitise } from './names.mjs';
import { planScopes } from './scopes.mjs';
import { planDeclarationSites } from './declsite.mjs';
import { expr, nameOf } from './expr.mjs';
import { regionStatements } from './region.mjs';
import { holeExpr, holeStmt, noteStmt, mark, HOLE_IDENTIFIER } from './holes.mjs';
import { joinPoints, verifyEmitted, walkAst, variableIdentifiers } from './verify.mjs';
import { applyPositions, monotonicity, finishMap } from './sourcemap.mjs';

const generate = generatorModule.default ?? generatorModule;

export class EmitError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

const toArray = (x) => (x === null || x === undefined ? [] : (Array.isArray(x) ? x : [x]));

/** How much of a failure message, and of its top frame, is kept. */
const MAX_ERROR = 300;
const MAX_FRAME = 200;
/** How many per-file samples a report keeps. */
const MAX_SAMPLES = 6;

function newReport() {
  return {
    holes: { total: 0, byWhy: {}, byKind: { expr: 0, stmt: 0, region: 0 } },
    blocksWithoutStatements: 0,
    declarationsWithoutAnInitialiser: 0,
    unresolvedNames: 0, globalReads: 0,
    loops: 0, loopForms: {}, loopIdioms: {}, loopsWithoutAnInit: 0, endlessLoops: 0,
    tries: 0, triesByPrediction: {}, triesWithoutAFinalizer: 0,
    finallyShapes: 0, finallyShapeKinds: {},
    switches: 0, switchForms: {}, switchGuardBlocks: 0,
    ifs: 0, breaks: 0, continues: 0, labels: 0,
    unstructuredRegions: 0, unstructuredBlocks: 0,
    regionKindsNot112: {}, unknownRegionKinds: {},
    catchWithoutAParam: 0, sharedExprWithNoValue: 0,
    forcedAsync: 0, forcedGenerator: 0,
    loopTestChainsMaterialised: 0, loopTestChainStatements: 0,
    namesReadTwice: 0,
    forInRebuilt: 0, forInNotRebuilt: 0,
    catchContextBindings: 0, catchContextBindingsAmbiguous: 0,
    declarationSitesWithADifferentSpelling: 0, declarationSitesEmittedTwice: 0,
  };
}

/** The per-function emit context every other module in this directory takes. */
function makeContext({ rec, sf, unit, facts, plan, file, resolveFn, resolveClass, opts, sites }) {
  const report = newReport();
  const ctx = {
    rec, sf, ir: sf.ir, unit, facts, plan, file, report, opts,
    declarationSites: sites ?? { byStmt: new Map(), byBinding: new Map() },
    declaredAtStore: [],
    depth: 0, regionCount: 0,
    isAsync: !!unit.isAsync, isGenerator: !!unit.isGenerator,
    allowSuper: false,
    positions: [],
    extraDeclNames: new Set(),
    blockEmitCounts: new Map(),
    blockStatementCounts: new Map(),
    visitCounts: new Map(),
    exprOwners: new Map(),
    scratchSeq: 0,

    countHole(why, kind) {
      report.holes.total++;
      report.holes.byWhy[why] = (report.holes.byWhy[why] ?? 0) + 1;
      report.holes.byKind[kind] = (report.holes.byKind[kind] ?? 0) + 1;
    },
    visit(e) { ctx.visitCounts.set(e, (ctx.visitCounts.get(e) ?? 0) + 1); },
    needHoleIdentifier() { ctx.extraDeclNames.add(HOLE_IDENTIFIER); },
    needSuperPlaceholder() { ctx.extraDeclNames.add('__super'); },
    needDispatchVar(name) { ctx.extraDeclNames.add(name); },
    scratchName(base = '__t') {
      const n = `${base}$${ctx.scratchSeq++}`;
      ctx.extraDeclNames.add(n);
      return n;
    },
    nameOfExpr(e) { return nameOf(ctx, e); },
    /** stmt.mjs emitted a binding's declaration at its store (docs/EMIT.md 9.11). */
    noteDeclarationAtStore(site, node, target, value) {
      ctx.declaredAtStore.push({ site, node, target, value });
    },
    forceAsync() { ctx.isAsync = true; report.forcedAsync++; },
    forceGenerator() { ctx.isGenerator = true; report.forcedGenerator++; },

    /** 11.3 invariant 2, at the point of use: resolve an SSA value. */
    exprOfValue(id, why) {
      if (id === null || id === undefined) return holeExpr(ctx, 'joinUnresolved', why);
      const e = rec.exprs.get(id);
      if (!e) return holeExpr(ctx, 'joinUnresolved', `${why}: value ${id} has no exprs entry`);
      return expr(ctx, e);
    },
    /** The SSA value a block's terminator reads, as an expression. */
    terminatorValueExpr(blockId, why) {
      const { value } = terminatorInputs(ctx.ir, blockId);
      return ctx.exprOfValue(value, why);
    },
    /** The successor of a two-way terminator taken when its predicate holds. */
    takenSuccessor(blockId) {
      for (const eid of ctx.ir.blocks[blockId].outEdges) {
        const e = ctx.ir.edges[eid];
        if (e.kind === 'true') return e.to;
      }
      return null;
    },
    noteBlockEmitted(id) { ctx.blockEmitCounts.set(id, (ctx.blockEmitCounts.get(id) ?? 0) + 1); },
    noteStatementsEmitted(id, n) { ctx.blockStatementCounts.set(id, (ctx.blockStatementCounts.get(id) ?? 0) + n); },

    functionLike(e, role) { return resolveFn(ctx, e, role); },
    classLike(e) { return resolveClass(ctx, e); },
  };
  // 11.3 invariant 4's index: one T7 Expr object -> every value resolving to it
  for (const [id, e] of rec.exprs) {
    if (!e || typeof e !== 'object') continue;
    const list = ctx.exprOwners.get(e);
    if (list) list.push(id); else ctx.exprOwners.set(e, [id]);
  }
  return ctx;
}

/** The Exprs a region tree reaches outside `stmts`, for names.mjs. */
function joinExprs(rec, sf) {
  const out = [];
  const { tests, targets } = joinPoints(sf);
  for (const { test } of tests) {
    if (!test) continue;
    const ids = test.valueless ? (test.values ?? []) : [test.value];
    for (const id of ids) { const e = rec.exprs.get(id); if (e) out.push(e); }
  }
  for (const { target } of targets) {
    if (!target) continue;
    const e = rec.exprs.get(target.value ?? target.slotValue);
    if (e) out.push(e);
  }
  return out;
}

/** The function keyword flavour for a unit. */
function flavour(unit, ctx) {
  return { isAsync: ctx ? ctx.isAsync : !!unit.isAsync, isGenerator: ctx ? ctx.isGenerator : !!unit.isGenerator };
}

/**
 * @param {object|object[]} recovered  T7's output, one per unit
 * @param {object|object[]} structured T8's output, same order
 * @param {object} opts  { file, units, failures, perFunctionCode, verify }
 */
export function emit(recovered, structured, opts = {}) {
  const t0 = process.hrtime.bigint();
  const recs = toArray(recovered);
  const sfs = toArray(structured);
  if (recs.length !== sfs.length) {
    throw new EmitError(`emit() needs one StructuredFunction per RecoveredFunction (${recs.length} vs ${sfs.length})`);
  }
  const file = opts.file ?? null;
  const sourceName = opts.sourceName ?? (file ? String(file).replace(/\\/g, '/').split('/').pop() : 'unknown.jsc');

  // ------------------------------------------------- the unit table
  const byId = new Map();                       // sfiId -> record
  const order = [];
  const addRecord = (rec0) => {
    if (byId.has(rec0.sfiId)) return;
    byId.set(rec0.sfiId, rec0);
    order.push(rec0);
  };
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const sf = sfs[i];
    const unit = rec?.ir?.unit ?? sf?.ir?.unit;
    if (!unit) throw new EmitError(`pair ${i} carries no unit`);
    addRecord({ sfiId: unit.sfiId, unit, rec, sf, failure: null });
  }
  for (const u of opts.units ?? []) {
    if (byId.has(u.sfiId)) continue;
    const f = (opts.failures ?? []).find((x) => x.sfiId === u.sfiId || x.unit === u.bytecodeId);
    addRecord({ sfiId: u.sfiId, unit: u, rec: null, sf: null, failure: f ?? (u.bytecode ? { error: 'no recovered/structured pair for this unit' } : null) });
  }

  // ------------------------------------------------- one name per unit, file-wide
  const taken = new Set([HOLE_IDENTIFIER, '__super']);
  const emitName = new Map();
  const nameUnits = [...order].sort((a, b) => a.sfiId - b.sfiId);
  for (const r of nameUnits) {
    if (r.unit.isTopLevel) { emitName.set(r.sfiId, null); continue; }
    const base = sanitise(r.unit.name || inferredBase(r.unit));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}$${n}`;
    taken.add(name);
    emitName.set(r.sfiId, name);
  }

  // ------------------------------------------------- the tree
  const { childrenOf, roots, treeSource } = buildUnitTree(order, byId);

  // ------------------------------------ where every closure variable is bound
  //
  // One pass over the whole file, before any body is built, because a context
  // slot belongs to a SCOPE and not to a function: the function that owns the
  // frame has to declare every binding its descendants read, including the
  // ones its own body never mentions. See scopes.mjs.
  const scopes = planScopes({
    order, childrenOf, roots, reserved: reservedSpellings(order, emitName, taken),
  });

  // ------------------------------ and WHERE in that function it is declared
  //
  // Also one pass over the whole file, and after `planScopes` because it is a
  // statement about a BINDING: whether the binding is stored exactly once, in
  // the function that owns it, at a position that encloses every read -- in
  // which case the declaration moves to that store and carries the
  // initialiser, which is the only shape that gets `LdaImmutableContextSlot`
  // back at the reads. See declsite.mjs and docs/EMIT.md 9.11.
  const declSites = planDeclarationSites({ order, scopes });

  const state = {
    emitted: new Set(), claimed: new Set(), inProgress: new Set(),
    perFunction: [], report: fileReport(), byId, childrenOf, emitName, scopes,
    declSites, positions: [], opts, file, sourceName,
  };

  // ------------------------------------------------- emit, roots first
  const programBody = [];
  const scriptRoot = roots.find((r) => r.unit.isTopLevel) ?? null;
  if (scriptRoot) programBody.push(...emitUnit(state, scriptRoot, { role: 'script', inherited: new Set(), topLevel: true }));
  for (const r of roots) {
    if (r === scriptRoot) continue;
    programBody.push(...asStatements(emitUnit(state, r, { role: 'declaration', inherited: new Set(), topLevel: true })));
  }
  // Nothing may be lost to a broken parent link (11.5: every function enters
  // the output). Anything still unemitted goes to the top level, marked.
  for (const r of order) {
    if (state.emitted.has(r.sfiId) || state.claimed.has(r.sfiId)) continue;
    const stmts = asStatements(emitUnit(state, r, { role: 'declaration', inherited: new Set(), topLevel: true }));
    if (stmts.length) {
      mark(stmts[0], `ORPHAN: parent sfi ${r.unit.parentSfiId ?? 'none'} is not in this file`);
      state.report.orphans++;
    }
    programBody.push(...stmts);
  }

  const program = t.program(programBody, [], 'script');
  const ast = t.file(program, [], []);

  // ------------------------------------------------- text, map, checks
  const withPosition = applyPositions(state.positions);
  const gen = generate(ast, {
    comments: true, compact: false, concise: false, retainLines: false,
    sourceMaps: opts.sourceMaps !== false, sourceFileName: sourceName,
    jsescOption: { minimal: true },
  });
  const code = gen.code ?? '';
  const map = finishMap(gen.map, sourceName, { file: opts.outFile ?? null });

  // 11.3 invariant 5, file-wide, counted the same way verify.mjs counts it per
  // function: an Identifier in a VARIABLE position. A property called `ctx`
  // (`o.ctx`, `{ctx: 1}`) is recovered source, not the invented context object
  // the baseline's 1 710 336 occurrences were, and names.mjs::sanitise makes
  // it impossible for a variable to be spelled that way.
  const ctxIdentifiers = variableIdentifiers(ast).filter((n) => n.name === 'ctx').length;
  let holeIdentifiers = 0;
  let ctxProperties = 0;
  walkAst(ast, (n) => {
    if (n.type !== 'Identifier') return;
    if (n.name === HOLE_IDENTIFIER) holeIdentifiers++;
    else if (n.name === 'ctx') ctxProperties++;
  });
  ctxProperties -= ctxIdentifiers;

  const r = state.report;
  r.file = sourceName;
  r.units = order.length;
  r.compiledUnits = order.filter((x) => x.unit.bytecode).length;
  r.functionsEmitted = state.perFunction.length;
  r.functionsClaimedInline = state.claimed.size;
  r.codeBytes = Buffer.byteLength(code, 'utf8');
  r.sourcePositionsApplied = withPosition;
  r.ctxIdentifiersInTheOutput = ctxIdentifiers;
  r.ctxPropertyNamesInTheOutput = ctxProperties;
  r.holeIdentifiersInTheOutput = holeIdentifiers;
  r.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  r.invariants = summariseInvariants(state.perFunction);
  r.unitTree = treeSource;
  r.scopePlan = scopes.stats;
  r.declarationSitePlan = declSites.stats;
  r.metrics = fileMetrics(state, r);

  return { code, map, ast, perFunction: state.perFunction, report: r };
}

/**
 * Spellings a context binding may not take, file-wide.
 *
 * A binding's name is ours to choose and is invisible to O1 -- a context slot
 * is an index in the bytecode -- so the cheap, certain thing is to keep it off
 * every name this file binds some other way: the parameters (T7 spells them
 * `p0..pN`), every global any function reads (a global cannot be renamed, and
 * a binding that shadowed one would silently capture its reads), every
 * emitted function name, and every SFI name, which is what
 * `declareFunctionSelf` binds inside a named function expression.
 */
function reservedSpellings(order, emitName, functionNames) {
  const out = new Set([HOLE_IDENTIFIER, '__super', ...functionNames]);
  for (const [, n] of emitName) if (n) out.add(n);
  for (const r of order) {
    if (r.unit?.name) out.add(sanitise(r.unit.name));
    const names = r.rec?.names;
    if (!names) continue;
    for (const n of names.paramNames ?? []) if (n) out.add(sanitise(n));
    for (const g of names.globals?.keys() ?? []) out.add(sanitise(g));
  }
  return out;
}

/**
 * Which unit encloses which.
 *
 * `src/heap` fills in `parentSfiId` from the CONSTANT POOL: a `{t:'sfi'}`
 * entry is a `CreateClosure` target, so the pool gives the tree for every
 * closure a function creates. Measured: it does NOT give it for a top-level
 * function DECLARATION. `loop-while.jsc`'s script unit has constants
 * `[array, string, string, string, string]` and no `sfi` entry at all, because
 * V8 hoists declarations through `DeclareGlobals`, whose operand is a
 * FixedArray of (name, slot, SFI) triples that `src/heap` renders as one
 * `{t:'array'}`. So all three units of that file arrive with
 * `parentSfiId: null` and `children: []`.
 *
 * The source range is the other, independent statement of the same fact: a
 * function literal's `[startPosition, endPosition)` is strictly inside its
 * enclosing literal's, because both come from the parser. So the tree is built
 * by containment and `parentSfiId` is used to confirm it. A unit with no
 * usable range (an assembled test unit has 0..0) stays a root rather than
 * being guessed into someone's body.
 */
export function buildUnitTree(order, byId) {
  const childrenOf = new Map();
  for (const r of order) childrenOf.set(r.sfiId, []);
  const roots = [];
  const usable = (u) => Number.isInteger(u.startPosition) && Number.isInteger(u.endPosition)
    && u.endPosition > u.startPosition;
  const ranged = order.filter((r) => usable(r.unit));
  const unranged = order.filter((r) => !usable(r.unit));
  const treeSource = { byRange: 0, byParentSfiId: 0, disagreed: 0, rootsWithoutARange: unranged.length };

  ranged.sort((a, b) => (a.unit.startPosition - b.unit.startPosition)
    || (b.unit.endPosition - a.unit.endPosition) || (a.sfiId - b.sfiId));
  const stack = [];
  for (const r of ranged) {
    while (stack.length) {
      const top = stack[stack.length - 1].unit;
      if (r.unit.startPosition >= top.startPosition && r.unit.endPosition <= top.endPosition) break;
      stack.pop();
    }
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) {
      childrenOf.get(parent.sfiId).push(r);
      treeSource.byRange++;
      const declared = r.unit.parentSfiId;
      if (declared !== null && declared !== undefined && declared !== parent.sfiId) treeSource.disagreed++;
      else if (declared === parent.sfiId) treeSource.byParentSfiId++;
    } else roots.push(r);
    stack.push(r);
  }
  for (const r of unranged) {
    const p = r.unit.parentSfiId;
    if (p !== null && p !== undefined && byId.has(p) && p !== r.sfiId) {
      childrenOf.get(p).push(r);
      treeSource.byParentSfiId++;
    } else roots.push(r);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.unit.startPosition ?? 0) - (b.unit.startPosition ?? 0) || a.sfiId - b.sfiId);
  }
  return { childrenOf, roots, treeSource };
}

function inferredBase(unit) {
  if (unit.kind === 'arrow') return 'arrow';
  if (unit.kind === 'classCtor') return 'ctor';
  if (unit.kind === 'getter') return 'get';
  if (unit.kind === 'setter') return 'set';
  return 'anonymous';
}

function fileReport() {
  return {
    file: null, units: 0, compiledUnits: 0, functionsEmitted: 0, orphans: 0,
    functionsFailed: 0, functionsClaimedInline: 0, topLevelReturns: 0, emitFailures: [],
    unreferencedClosures: 0, unreferencedClosuresRebound: 0,
    unreferencedClosuresAlreadyBound: 0, unreferencedClosuresAtTheTopLevel: 0,
    unreferencedClosuresNotInTheInput: 0,
    // A class member placed INSIDE its class body, and the dynamic arguments
    // of a %DefineClass that no template describes -- which, since
    // ClassBoilerplate::New puts no FIELD in a template, is the measure of the
    // class fields this decode cannot reach (docs/RECOVER.md 8.1).
    classMembersPlaced: 0, classArgumentsNoTemplateDescribes: 0,
    holes: { total: 0, byWhy: {}, byKind: { expr: 0, stmt: 0, region: 0 } },
    loops: 0, loopForms: {}, loopIdioms: {}, tries: 0, triesByPrediction: {},
    finallyShapes: 0, finallyShapeKinds: {}, switches: 0, switchForms: {},
    ifs: 0, breaks: 0, continues: 0, labels: 0,
    unstructuredRegions: 0, unstructuredBlocks: 0,
    droppedStatementsOnRemovedBlocks: 0, droppedStatementBlocks: 0,
    droppedByRemovedKind: {}, droppedByStatementTag: {},
    namesReadButNeverWritten: 0, namesDeclared: 0, unwrittenSamples: [],
    duplicatedValues: 0, unresolvedJoins: 0, unresolvedNames: 0, globalReads: 0,
    localsRenamed: 0, paramsRenamedForABinding: 0, declarations: 0,
    contextBindingsOwned: 0, contextBindingsInherited: 0,
    contextBindingsUnplaceable: 0, constBindingsEmittedAsLet: 0,
    functionsRefusedForAnUnplaceableBinding: 0, refusalsByWhy: {}, refusalSamples: [],
    scopePlan: {}, declarationSitePlan: {},
    contextBindingsDeclaredAtTheStoreSite: 0,
    declarationSitesByKeyword: { const: 0, let: 0, var: 0 },
    declarationSitesRevertedAfterEmission: 0, declarationSiteRevertsByWhy: {},
    declarationSitesWithADifferentSpelling: 0, declarationSitesEmittedTwice: 0,
    forcedAsync: 0, forcedGenerator: 0,
    blocksWithoutStatements: 0, regionKindsNot112: {}, unknownRegionKinds: {},
    monotonicity: { functions: 0, monotone: 0, inversions: 0 },
    bytecode: { backEdges: 0, handlerRanges: 0, handlerRangesByPrediction: {}, switchDispatchOpcodes: 0, blocks: 0 },
  };
}

function bump(dst, src) {
  for (const [k, v] of Object.entries(src ?? {})) dst[k] = (dst[k] ?? 0) + v;
}

/** Fold one function's counters into the file report. */
function foldReport(file, fn) {
  file.holes.total += fn.holes.total;
  bump(file.holes.byWhy, fn.holes.byWhy);
  bump(file.holes.byKind, fn.holes.byKind);
  for (const k of ['loops', 'tries', 'finallyShapes', 'switches', 'ifs', 'breaks',
    'continues', 'labels', 'unstructuredRegions', 'unstructuredBlocks',
    'unresolvedNames', 'globalReads', 'forcedAsync', 'forcedGenerator',
    'blocksWithoutStatements', 'loopTestChainsMaterialised', 'loopTestChainStatements',
    'forInRebuilt', 'forInNotRebuilt', 'catchContextBindings', 'catchContextBindingsAmbiguous',
    'namesReadTwice', 'declarationSitesWithADifferentSpelling', 'declarationSitesEmittedTwice',
    'declarationsWithoutAnInitialiser', 'catchWithoutAParam', 'sharedExprWithNoValue',
    'loopsWithoutAnInit', 'endlessLoops', 'triesWithoutAFinalizer', 'switchGuardBlocks']) {
    file[k] = (file[k] ?? 0) + (fn[k] ?? 0);
  }
  bump(file.loopForms, fn.loopForms);
  bump(file.loopIdioms, fn.loopIdioms);
  bump(file.triesByPrediction, fn.triesByPrediction);
  bump(file.finallyShapeKinds, fn.finallyShapeKinds);
  bump(file.switchForms, fn.switchForms);
  bump(file.regionKindsNot112, fn.regionKindsNot112);
  bump(file.unknownRegionKinds, fn.unknownRegionKinds);
}

/**
 * `violations` counts the SIX invariants of 11.3 only. Check 3c -- a local
 * name read without ever being written -- is a MEASUREMENT this layer added:
 * it is how a definition lost upstream becomes visible, and it is reported
 * separately rather than folded into a number 11.5 says must be zero.
 */
function summariseInvariants(perFunction) {
  const out = {
    functionsChecked: 0, violations: 0, measurements: 0,
    byInvariant: {}, byMeasurement: {}, samples: [],
  };
  const isMeasurement = (id) => String(id) === '3c';
  for (const f of perFunction) {
    if (!f.verification) continue;
    out.functionsChecked++;
    for (const c of f.verification.checks) {
      const key = `${c.id}. ${c.name}`;
      if (isMeasurement(c.id)) {
        out.byMeasurement[key] = (out.byMeasurement[key] ?? 0) + c.violations;
        out.measurements += c.violations;
        continue;
      }
      out.byInvariant[key] = (out.byInvariant[key] ?? 0) + c.violations;
      out.violations += c.violations;
      if (c.violations && out.samples.length < 8) {
        out.samples.push({ sfiId: f.sfiId, name: f.name, invariant: c.id, samples: c.samples });
      }
    }
  }
  return out;
}

function fileMetrics(state, r) {
  const b = r.bytecode;
  return {
    m1_loopsPerBackEdge: { numerator: r.loops, denominator: b.backEdges },
    m2_tryPerHandlerRange: {
      numerator: r.tries, denominator: b.handlerRanges,
      byPrediction: r.triesByPrediction, rangesByPrediction: b.handlerRangesByPrediction,
    },
    m3_switchPerDispatchOpcode: { numerator: r.switches, denominator: b.switchDispatchOpcodes },
    m5_freeIdentifiers: { globalReads: r.globalReads, unresolvedNames: r.unresolvedNames },
    m6_functionsEmittedPerDeserialized: { numerator: r.functionsEmitted, denominator: r.compiledUnits },
    m7_duplicatedValues: { value: r.duplicatedValues },
    m9_unresolvedConstants: {
      value: Object.entries(r.holes.byWhy)
        .filter(([k]) => k.startsWith('unresolvedConstant'))
        .reduce((a, [, v]) => a + v, 0),
    },
    m10_unstructuredRegions: { value: r.unstructuredRegions },
  };
}

const asStatements = (x) => (Array.isArray(x) ? x : (x ? [x] : []));

/**
 * Emit one unit.
 *
 * @param {object} state
 * @param {object} rec0 the unit record
 * @param {{role:string, inherited:Set<string>, topLevel?:boolean, classCtor?:boolean}} how
 * @returns {object[]|object} statements (role 'script') or one node
 */
function emitUnit(state, rec0, how) {
  const { unit } = rec0;
  if (state.inProgress.has(rec0.sfiId)) {
    state.report.functionsFailed++;
    return [noteStmt(`CYCLE: sfi ${rec0.sfiId} is its own ancestor`)];
  }
  state.inProgress.add(rec0.sfiId);
  try {
    return emitUnitInner(state, rec0, how);
  } finally {
    state.inProgress.delete(rec0.sfiId);
  }
}

/**
 * The body of a function this layer refuses because a context binding it reads
 * cannot be placed (scopes.mjs::SCOPE_REFUSAL_WHY).
 *
 * The alternative that was there before is the defect: `names.mjs` declared
 * the slot's spelling locally, which shadowed the closure, so the function
 * read its own fresh `undefined` instead of the captured variable and nothing
 * said so. A throw is loud, is counted, and keeps 11.3 invariant 5 -- and
 * because this layer still declares the bindings this function OWNS, a
 * refusal costs this function and not its descendants.
 */
function refusedBody(unit, unplaceable) {
  const text = (u) => `${u.why}${u.detail ? `: ${u.detail}` : ''}`.replace(/\*\//g, '* /');
  const s = t.throwStatement(t.newExpression(t.identifier('Error'), [
    t.stringLiteral(`NOT DECOMPILED: ${unit.name || '<anonymous>'} sfi ${unit.sfiId}`
      + `: ${unplaceable.length} context binding(s) could not be placed`),
  ]));
  mark(s, `HOLE contextBindingUnplaceable ${text(unplaceable[0]).slice(0, MAX_ERROR)}`);
  const note = noteStmt(`REFUSED: this layer cannot place ${unplaceable.length} context slot(s) of `
    + `${unit.name || '<anonymous>'}; ` + unplaceable.slice(0, MAX_SAMPLES).map(text).join(' | ').slice(0, MAX_ERROR));
  return [note, s];
}

function failedBody(unit, failure) {
  const why = String(failure?.error ?? 'no recovered/structured pair').replace(/\*\//g, '* /').slice(0, MAX_ERROR);
  const s = t.throwStatement(t.newExpression(t.identifier('Error'), [
    t.stringLiteral(`NOT DECOMPILED: ${unit.name || '<anonymous>'} sfi ${unit.sfiId}`),
  ]));
  mark(s, `HOLE unitNotRecovered ${why}`);
  const note = noteStmt(`NOT IN CACHE OR NOT RECOVERED: source [${unit.startPosition ?? '?'},${unit.endPosition ?? '?'})`);
  return [note, s];
}

function emitUnitInner(state, rec0, how) {
  const { unit, rec, sf, failure } = rec0;
  state.emitted.add(rec0.sfiId);
  const name = state.emitName.get(rec0.sfiId);

  // ---- a unit with no usable pair still has to appear (11.5). Its children
  //      do too: a function is not lost because its parent could not be
  //      recovered, so they are emitted inside the stub body.
  //
  //      Every one of them is unreferenced BY CONSTRUCTION -- the stub body is
  //      a `throw` and references nothing -- so each goes through
  //      `unreferenced()` for its binding form, exactly like the children of a
  //      refusal below. This was the one path that did not, and it is the one
  //      path with no measured effect: `probe_closure.mjs cause` finds 0 units
  //      of its 25-file sample reaching here, because all 23 of that sample's
  //      failures are refusals. Closed anyway -- a child must not depend on
  //      which kind of body its parent ended up with.
  if (!rec || !sf) {
    state.report.functionsFailed++;
    state.report.holes.total++;
    state.report.holes.byWhy.unitNotRecovered = (state.report.holes.byWhy.unitNotRecovered ?? 0) + 1;
    state.report.holes.byKind.stmt++;
    const stubChildren = [];
    for (const c of state.childrenOf.get(rec0.sfiId) ?? []) {
      if (state.claimed.has(c.sfiId) || state.emitted.has(c.sfiId)) continue;
      for (const s of asStatements(emitUnit(state, c, { role: 'declaration', inherited: how.inherited ?? new Set() }))) {
        stubChildren.push(unreferenced(state, c, s, how));
      }
    }
    const body = t.blockStatement([...stubChildren, ...failedBody(unit, failure)]);
    state.perFunction.push(perFunctionEntry(unit, null, null, null, { failed: true, error: failure?.error ?? null }));
    if (how.role === 'script') return body.body;
    return t.functionDeclaration(t.identifier(name ?? sanitise(unit.name || 'anonymous')),
      paramsOfUnit(unit), body, !!unit.isGenerator, !!unit.isAsync);
  }

  const facts = structureFacts(rec.ir.profile ?? sf.ir.profile);
  const sites = state.declSites.forUnit(rec0.sfiId);
  const plan = planNames(rec, rec.ir, unit, joinExprs(rec, sf), how.inherited ?? new Set(),
    state.scopes.forUnit(rec0.sfiId), sites);

  // ---- names for the children, before the body is built: `{e:'fn'}` emits a
  //      reference to one of them, so the spelling has to exist first. A child
  //      may not be spelled like a context binding in scope here either: the
  //      declaration would shadow the closure for the rest of the body.
  const children = state.childrenOf.get(rec0.sfiId) ?? [];
  const localTaken = new Set([...plan.declaredNames, ...plan.paramNames, ...plan.visibleBindingNames]);
  if (!how.topLevel) for (const g of plan.globalNames ?? []) localTaken.add(g);
  const childName = new Map();
  for (const c of children) {
    let n = state.emitName.get(c.sfiId) ?? sanitise(c.unit.name || 'anonymous');
    for (let k = 2; localTaken.has(n); k++) n = `${n}$${k}`;
    localTaken.add(n);
    childName.set(c.sfiId, n);
    state.emitName.set(c.sfiId, n);
  }

  const inlineClaims = [];          // children emitted inline, not as siblings
  const referenced = new Set();

  const resolveFn = (ctx, e, role) => {
    const child = state.byId.get(e.sfiId);
    if (!child) return null;
    if (role === 'expression') {
      referenced.add(e.sfiId);
      const n = childName.get(e.sfiId) ?? state.emitName.get(e.sfiId);
      if (!n) return null;
      return t.identifier(n);
    }
    // an object literal's method / accessor: inline, so `super` is legal
    if (state.emitted.has(e.sfiId) || state.claimed.has(e.sfiId)) return null;
    state.claimed.add(e.sfiId);
    inlineClaims.push(e.sfiId);
    const node = emitUnit(state, child, {
      role: 'expression-inline', inherited: plan.exported, allowSuper: true,
    });
    return node;
  };

  const resolveClass = (ctx, e) => {
    const child = e.sfiId === null || e.sfiId === undefined ? null : state.byId.get(e.sfiId);
    const id = e.name ? t.identifier(sanitise(e.name)) : null;
    const superClass = e.superClass ? expr(ctx, e.superClass) : null;
    const members = [];
    if (child && !state.emitted.has(e.sfiId) && !state.claimed.has(e.sfiId)) {
      state.claimed.add(e.sfiId);
      inlineClaims.push(e.sfiId);
      const fn = emitUnit(state, child, { role: 'expression-inline', inherited: plan.exported, allowSuper: true });
      if (fn && fn.type === 'FunctionExpression') {
        members.push(t.classMethod('constructor', t.identifier('constructor'), fn.params, fn.body));
      }
    }
    // Every member T7 placed, plus every one it could not: a refusal is a
    // counted hole with the reason T7 or src/heap gave it, never a member
    // guessed into a shape that happens to parse.
    const refused = [...(e.membersNotPlaced ?? [])];
    for (const m of e.members ?? []) {
      const mm = classMember(ctx, m, state);
      if (mm.node) members.push(mm.node);
      else refused.push({ why: mm.why, detail: mm.detail ?? null, key: typeof m.key === 'string' ? m.key : null });
    }
    const node = t.classExpression(id, superClass, t.classBody(members), []);
    if (!e.membersDecoded) {
      // docs/RECOVER.md 8.1: args[0] was not a decoded ClassBoilerplate, so
      // there is no member list at all and that has to be visible, not implied.
      ctx.countHole('classMembersNotDecoded', 'expr');
      mark(node, `HOLE classMembersNotDecoded ${e.dynamicArguments ?? 0} dynamic argument(s)`);
    }
    for (const r of refused) {
      ctx.countHole(CLASS_MEMBER_HOLES.has(r.why) ? r.why : 'classMemberNotPlaced', 'expr');
      mark(node, `HOLE ${r.why}${r.key ? ` ${r.key}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
    }
    if (e.boilerplateArgumentsUnclaimed) {
      // ClassBoilerplate::New describes no FIELD at all, and a computed-name
      // field still costs one argument, so this is the measure of what the
      // decode cannot reach rather than of anything going wrong here.
      state.report.classArgumentsNoTemplateDescribes += e.boilerplateArgumentsUnclaimed;
    }
    state.report.classMembersPlaced += members.length;
    return node;
  };

  const ctx = makeContext({
    rec, sf, unit, facts, plan, file: state.file, resolveFn, resolveClass, opts: state.opts, sites,
  });
  ctx.allowSuper = !!how.allowSuper;

  // ---- the body: T8's tree, T7's statements
  //
  // Unless a context binding this function reads cannot be placed. Then the
  // body is NOT emitted: declaring the slot locally would shadow the closure
  // (docs/O1.md 6.5) and leaving it free would break 11.3 invariant 5, so the
  // honest answer is "I cannot place this binding", per function, with the
  // slot, the frame and the depth named. The declaration prologue below still
  // carries the bindings this function OWNS, so its descendants stay
  // placeable: one unplaceable binding costs this function and not the file.
  let body;
  let refused = null;
  if (plan.unplaceable.length) {
    refused = plan.unplaceable;
    body = refusedBody(unit, refused);
    ctx.countHole('contextBindingUnplaceable', 'stmt');
    state.report.functionsFailed++;
    state.report.functionsRefusedForAnUnplaceableBinding++;
    for (const u of refused) {
      state.report.refusalsByWhy[u.why] = (state.report.refusalsByWhy[u.why] ?? 0) + 1;
    }
    if (state.report.refusalSamples.length < MAX_SAMPLES) {
      state.report.refusalSamples.push({
        sfiId: unit.sfiId, name: unit.name ?? null,
        why: refused[0].why, detail: refused[0].detail ?? null, slots: refused.length,
      });
    }
  } else try {
    body = regionStatements(ctx, sf.root);
  } catch (e) {
    if (state.opts.rethrow) throw e;
    body = failedBody(unit, { error: `${e.constructor.name}: ${e.message}` });
    // The marker `failedBody` writes has to be counted on THIS function, not
    // only on the file: invariant 6 compares the markers in the AST against
    // the function's own total, and a stub counted file-wide but not here
    // reported "0 counted, 1 marker" -- the check catching this layer again.
    ctx.countHole('unitNotRecovered', 'stmt');
    state.report.functionsFailed++;
    state.report.emitFailures.push({
      sfiId: unit.sfiId, name: unit.name ?? null,
      error: `${e.constructor.name}: ${e.message}`.slice(0, MAX_ERROR),
      at: String(e.stack ?? '').split('\n')[1]?.trim().slice(0, MAX_FRAME) ?? null,
    });
  }

  // ---- docs/STRUCTURE.md 9.5 / 11.3 invariant 3: a `removed` block for which
  //      T7 still produced statements. Those statements have no slot in the
  //      tree, so they are not emitted -- and saying so out loud is the whole
  //      difference between this and dropping them.
  const dropped = droppedOnRemoved(rec, sf, ctx);
  if (dropped.total) {
    state.report.droppedStatementsOnRemovedBlocks += dropped.total;
    state.report.droppedStatementBlocks += dropped.blocks.length;
    for (const b of dropped.blocks) {
      state.report.droppedByRemovedKind[b.kind] = (state.report.droppedByRemovedKind[b.kind] ?? 0) + b.statements;
      for (const tag of b.tags) {
        state.report.droppedByStatementTag[tag] = (state.report.droppedByStatementTag[tag] ?? 0) + 1;
      }
    }
    body.push(noteStmt(`DROPPED ${dropped.total} statement(s) of removed block(s) `
      + dropped.blocks.map((b) => `${b.block}:${b.kind}`).join(' ')));
  }

  // ---- docs/EMIT.md 9.11: which planned declaration sites really landed in
  //      the body's own statement list. Checked by node identity on the
  //      emitted array, so clause 7's region-tree model is verified rather
  //      than believed; a site that did not land is turned back into an
  //      assignment and keeps its prologue row.
  const declaredAtStore = verifyDeclarationSites(ctx, body, state);

  // ---- the prologue: the declaration lists, then the nested functions
  const prologue = declarationPrologue(plan, [...ctx.extraDeclNames],
    { topLevel: how.role === 'script', declaredAtStore });
  const nested = [];
  for (const c of children) {
    if (state.claimed.has(c.sfiId) || state.emitted.has(c.sfiId)) continue;
    const node = emitUnit(state, c, { role: 'declaration', inherited: plan.exported, childName });
    for (const s of asStatements(node)) {
      nested.push(referenced.has(c.sfiId) ? s : unreferenced(state, c, s, how));
    }
  }

  if (how.role === 'script') {
    // The top-level unit's body is the FILE's top level, and `return` is a
    // SyntaxError there. V8 compiles a script to a function that returns the
    // completion value, so T7's trailing `{s:'return', arg}` is exactly
    // "evaluate this last"; the closest legal text is the expression on its
    // own, which V8 then compiles back to the same `Return` of the completion
    // value. Counted, because it is a change this layer made.
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      if (!t.isReturnStatement(s)) continue;
      state.report.topLevelReturns++;
      body[i] = s.argument
        ? mark(t.expressionStatement(s.argument), 'script completion value (was `return`)')
        : mark(t.emptyStatement(), 'script completion value (was a bare `return`)');
    }
  }

  const statements = [...prologue, ...nested, ...body];
  const mono = monotonicity(ctx.positions);
  for (const p of ctx.positions) state.positions.push(p);

  let node;
  if (how.role === 'script') {
    node = null;
  } else if (unit.kind === 'arrow' && how.role === 'declaration') {
    const arrow = t.arrowFunctionExpression(paramsOf(plan), t.blockStatement(statements), ctx.isAsync);
    node = t.variableDeclaration('var', [t.variableDeclarator(t.identifier(name), arrow)]);
    mark(node, 'arrow function; hoisted to the top of its parent body');
  } else if (how.role === 'expression-inline') {
    node = t.functionExpression(null, paramsOf(plan), t.blockStatement(statements), ctx.isGenerator, ctx.isAsync);
  } else {
    node = t.functionDeclaration(t.identifier(name), paramsOf(plan), t.blockStatement(statements), ctx.isGenerator, ctx.isAsync);
  }

  // ---- 11.3, asserted on this function
  //
  // The target is this function's own STATEMENTS, not the node it was emitted
  // as. verify.mjs walks with `walkOwn`, which stops at a nested function so
  // that one hole in a closure is not counted again in every ancestor -- and
  // an arrow is emitted as `var f = () => {}`, so the arrow's own body sits
  // two levels inside its node and `walkOwn` stopped at it. Measured on
  // `b_357background.jsc`: 54 functions reported "1 hole counted, 0 markers"
  // while the marker was plainly in the text.
  const target = t.program(statements);
  ctx.boundNames = [...plan.paramNames, ...(name ? [name] : [])];
  const verification = state.opts.verify === false ? null : verifyEmitted({ rec, sf, ast: target, ctx });
  if (verification) {
    state.report.duplicatedValues += verification.duplicated.length;
    state.report.unresolvedJoins += verification.unresolved.length;
    state.report.namesReadButNeverWritten += verification.readButNeverWritten.length;
    state.report.namesDeclared += verification.readButNeverWritten.total ?? 0;
    if (verification.readButNeverWritten.length && state.report.unwrittenSamples.length < 6) {
      state.report.unwrittenSamples.push({
        sfiId: unit.sfiId, name: unit.name ?? null,
        names: verification.readButNeverWritten.slice(0, 6),
      });
    }
  }
  state.report.localsRenamed += plan.stats.localsRenamed;
  state.report.paramsRenamedForABinding += plan.stats.paramsRenamedForABinding;
  state.report.contextBindingsOwned += plan.stats.contextBindingsOwned;
  state.report.contextBindingsInherited += plan.stats.contextBindingsInherited;
  state.report.contextBindingsUnplaceable += plan.stats.contextBindingsUnplaceable;
  state.report.constBindingsEmittedAsLet += plan.stats.constBindingsEmittedAsLet;
  state.report.declarations += plan.stats.declarations;
  state.report.monotonicity.functions++;
  if (mono.monotone) state.report.monotonicity.monotone++;
  state.report.monotonicity.inversions += mono.inversions;
  foldReport(state.report, ctx.report);
  const ir = rec.ir;
  state.report.bytecode.backEdges += ir.loopInfo?.backEdges?.length ?? 0;
  state.report.bytecode.handlerRanges += ir.handlers?.length ?? 0;
  state.report.bytecode.blocks += ir.blocks.length;
  for (const h of ir.handlers ?? []) {
    const k = h.predictionName ?? String(h.prediction);
    state.report.bytecode.handlerRangesByPrediction[k] = (state.report.bytecode.handlerRangesByPrediction[k] ?? 0) + 1;
  }
  state.report.bytecode.switchDispatchOpcodes += countSwitchDispatch(ir, facts);

  state.perFunction.push(perFunctionEntry(unit, ctx, verification, mono, {
    name: name ?? '<script>', role: how.role, inlineClaims,
    code: null, statements: statements.length,
    patterns: patternSummary(rec),
    failed: !!refused,
    error: refused ? `${refused[0].why}: ${refused[0].detail ?? ''}`.slice(0, MAX_ERROR) : null,
    refused: refused ? refused.length : 0,
  }));
  return how.role === 'script' ? statements : node;
}

/**
 * Is `name` read anywhere in the statements before index `index`?
 *
 * The companion to declsite.mjs clause 4, asked on the emitted text instead
 * of on the CFG: dominance says the store runs before every read, and this
 * says the store's STATEMENT is written before every read, which is the thing
 * a TDZ actually depends on. Nested functions are included deliberately -- a
 * `function` declaration's body does not run where it is written, so including
 * it only ever costs a site, never admits a wrong one.
 *
 * Property positions are excluded for the same reason verify.mjs's
 * `variableIdentifiers` excludes them: `o.x` is not a read of `x`, and
 * treating it as one would refuse a site for an unrelated property of the
 * same name.
 */
function readsNameBefore(body, index, name) {
  const skip = new Set();
  for (let i = 0; i < index; i++) {
    let found = false;
    walkAst(body[i], (n) => {
      switch (n.type) {
        case 'MemberExpression': case 'OptionalMemberExpression':
          if (!n.computed) skip.add(n.property);
          break;
        case 'ObjectProperty': case 'ObjectMethod': case 'ClassMethod':
        case 'ClassProperty': case 'ClassPrivateMethod':
          if (!n.computed && n.key) skip.add(n.key);
          break;
        case 'MetaProperty': skip.add(n.meta); skip.add(n.property); break;
        case 'LabeledStatement': skip.add(n.label); break;
        case 'BreakStatement': case 'ContinueStatement': if (n.label) skip.add(n.label); break;
        default: break;
      }
      if (n.type === 'Identifier' && n.name === name && !skip.has(n)) found = true;
    });
    if (found) return true;
  }
  return false;
}

/**
 * `const x = <value>` -> `x = <value>`, in place.
 *
 * The node is mutated rather than spliced because it has already been handed
 * to `ctx.positions` (sourcemap.mjs) and may already carry the `ctx[*][i]`
 * marker; keeping the object identity keeps both. The comment travels from the
 * declarator to the statement, since the declarator is going away.
 */
function revertDeclarationToAssignment(node) {
  const d = node.declarations?.[0];
  const id = d?.id ?? t.identifier('__hole');
  const init = d?.init ?? t.identifier('undefined');
  node.type = 'ExpressionStatement';
  node.expression = t.assignmentExpression('=', id, init);
  if (d?.leadingComments?.length) {
    node.leadingComments = [...(node.leadingComments ?? []), ...d.leadingComments];
  }
  delete node.declarations;
  delete node.kind;
  return node;
}

/**
 * The names whose declaration really is in the body, so the prologue must not
 * declare them a second time.
 *
 * Two things are checked, both on the emitted array rather than on a model of
 * it: the declaration is an element of the body's own statement list (so its
 * lexical block is the one that encloses every read, including the reads in
 * every descendant function, which index.mjs emits nested inside that list),
 * and no read of the name is written before it. A site that fails either is
 * reverted to the assignment it was and counted under its reason -- the
 * residue stays attributable, and `declarationSitesRevertedAfterEmission`
 * reading zero is the evidence that declsite.mjs clause 7 models the emitter
 * correctly.
 */
function verifyDeclarationSites(ctx, body, state) {
  const kept = new Set();
  if (!ctx.declaredAtStore.length) return kept;
  const r = state.report;
  for (const row of ctx.declaredAtStore) {
    const at = Array.isArray(body) ? body.indexOf(row.node) : -1;
    const why = at < 0
      ? 'emittedDeclarationIsNotAnOutermostStatement'
      : (readsNameBefore(body, at, row.site.name) ? 'aReadIsEmittedBeforeTheDeclaration' : null);
    if (why === null) {
      kept.add(row.site.name);
      r.contextBindingsDeclaredAtTheStoreSite++;
      const k = row.site.keyword;
      r.declarationSitesByKeyword[k] = (r.declarationSitesByKeyword[k] ?? 0) + 1;
      continue;
    }
    revertDeclarationToAssignment(row.node);
    r.declarationSitesRevertedAfterEmission++;
    r.declarationSiteRevertsByWhy[why] = (r.declarationSiteRevertsByWhy[why] ?? 0) + 1;
    // The binding is back on the prologue's two-statement shape, so if it is a
    // `kConst` it is back to being emitted as `let` -- counted where every
    // other one is counted.
    if (row.site.declKind === 'const') r.constBindingsEmittedAsLet++;
  }
  return kept;
}

function countSwitchDispatch(ir, facts) {
  let n = 0;
  for (const b of ir.blocks) {
    const ins = b.instructions[b.instructions.length - 1];
    if (!ins) continue;
    if (facts.isSwitch(ins.opcodeValue)) n++;
  }
  return n;
}

/**
 * A child nothing in this body references, declared in a form V8 keeps.
 *
 * Measured consequence, counted because docs/O1.md 6.5 step 5 blamed it on the
 * context-slot defect and the measurement says otherwise: a function this file
 * declares but nothing REFERENCES is dropped by V8's scope analysis, so no
 * `CreateClosure` is emitted, the SFI is unreachable from the parent's
 * constant pool, and the function is absent from the recompiled cache. That --
 * not the scoping of its captured variables -- is what O1's A-side unpaired
 * count measures.
 *
 * The drop is in one statement of the bytecode generator:
 * `src/interpreter/bytecode-generator.cc::VisitFunctionDeclaration:2181`
 * returns at :2187 when `!variable->is_used()`, so the function literal is
 * never visited and nothing in the cache mentions it.
 * `VisitVariableDeclaration:2135` has the same early return at :2138, but it
 * guards only the TDZ hole store -- V8's parser turns `var f = e` into a
 * declaration plus an assignment statement, and `VisitAssignment` evaluates
 * the right-hand side whether or not anything reads `f`.
 *
 * So the FORM decides, and the form is this layer's choice. Measured with the
 * corpus's own V8, 100 unreferenced functions per script, one spelling per
 * row (`tools/probes/probe_closure.mjs form`):
 *
 *     IN A FUNCTION   function h(){}                     2 of 102 carried
 *     IN A FUNCTION   function* h(){}                    2 of 102
 *     IN A FUNCTION   var h = function h(){}           102 of 102
 *     IN A FUNCTION   let h = function h(){}           102 of 102
 *     IN A FUNCTION   var h = function* h(){}          102 of 102
 *     IN A FUNCTION   var h = async function h(){}     102 of 102
 *     IN A FUNCTION   var h = (a)=>a                   102 of 102
 *     IN A FUNCTION   function h(){} + one reference   102 of 102
 *     TOP LEVEL       function h(){}                   101 of 101
 *     TOP LEVEL       var h = function h(){}           101 of 101
 *
 * An arrow child was already emitted as `var f = () => {}` and so was never
 * really lost; this gives every other unreferenced child the same protection,
 * including a generator declaration, which the first two rows show is dropped
 * for the same reason. The body, the name and the position are untouched --
 * only the binding form changes -- so the parent gains the `CreateClosure` the
 * original has and nothing that was equivalent stops being equivalent.
 *
 * Two cases keep the declaration, each with its own count:
 *
 *   * a child of the SCRIPT unit. The last two rows measure it: a top-level
 *     declaration is carried either way, because it is UNALLOCATED and
 *     `VisitGlobalDeclarations:2281` records it into the `DeclareGlobals` pair
 *     array with no `is_used()` test at all -- it DCHECKs `var->is_used()` at
 *     :2285 instead, a global binding being observable whether or not the
 *     script reads it. Rebinding it would only move the script's own bytecode
 *     away from the original. (A MODULE top level is the one place that does
 *     skip them, `VisitModuleDeclarations:2258` at :2262; nothing here emits a
 *     module.)
 *   * a child with no bytecode in the input. Stream A does not contain it, so
 *     forcing V8 to compile it would manufacture a function with no partner --
 *     a B-side unpaired, which docs/O1.md 4 reads as a defect of its own.
 */
function unreferenced(state, child, s, how) {
  state.report.unreferencedClosures++;
  const keep = (why, counter) => {
    state.report[counter]++;
    mark(s, `unreferenced closure (sfi ${child.sfiId}); ${why}`);
    return s;
  };
  if (how.role === 'script') return keep('top level, so DeclareGlobals carries it anyway', 'unreferencedClosuresAtTheTopLevel');
  if (!child.unit.bytecode) return keep('not compiled in the input either', 'unreferencedClosuresNotInTheInput');
  if (!t.isFunctionDeclaration(s) || !s.id) {
    return keep('already declared with an initialiser', 'unreferencedClosuresAlreadyBound');
  }
  const fn = t.functionExpression(t.identifier(s.id.name), s.params, s.body, s.generator, s.async);
  const node = t.variableDeclaration('var', [t.variableDeclarator(t.identifier(s.id.name), fn)]);
  node.leadingComments = s.leadingComments ?? null;
  node.loc = s.loc ?? null;
  state.report.unreferencedClosuresRebound++;
  mark(node, `unreferenced closure (sfi ${child.sfiId}); declared with an initialiser `
    + 'because VisitFunctionDeclaration does not serialise a declaration nothing reads');
  return node;
}

function droppedOnRemoved(rec, sf, ctx) {
  const kinds = [
    ...(sf.removed.generatorDispatchers ?? []).filter((d) => d.blockRemoved).map((d) => ({ block: d.block, kind: 'generatorDispatchers' })),
    ...(sf.removed.asyncHandlerBlocks ?? []).map((b) => ({ block: b, kind: 'asyncHandlerBlocks' })),
    ...(sf.removed.loopTestBlocks ?? []).map((x) => ({ block: x.block, kind: 'loopTestBlocks' })),
  ];
  const blocks = [];
  let total = 0;
  for (const k of kinds) {
    const list = rec.stmts.get(k.block);
    if (!list || !list.length) continue;
    if (ctx && ctx.blockEmitCounts.has(k.block)) continue;    // emitted anyway
    // a declarator with no initialiser emits nothing, so nothing is lost
    const effective = list.filter((s) => s.s !== 'decl'
      || (s.decls ?? []).some((d) => d.init !== null && d.init !== undefined));
    if (!effective.length) continue;
    blocks.push({ ...k, statements: effective.length, tags: effective.map((s) => s.s) });
    total += effective.length;
  }
  return { total, blocks };
}

function paramsOf(plan) {
  const out = plan.params.map((p) => t.identifier(p.name));
  if (plan.restName) out.push(t.restElement(t.identifier(plan.restName)));
  return out;
}

function paramsOfUnit(unit) {
  const out = [];
  for (let i = 1; i < (unit.parameterCount ?? 1); i++) out.push(t.identifier(`p${i - 1}`));
  return out;
}

/**
 * The three member kinds this layer can spell, and nothing else.
 *
 * `method`, `get` and `set` are exactly what a `ClassBoilerplate` entry's
 * ValueKind can be once `kAutoAccessor` is excluded (src/heap's
 * `decodeClassBoilerplate`), and the mapping is total: there is no default
 * branch. A kind not in this table used to fall through to `method`, which
 * would emit `x(){}` for a getter -- a different program with no marker.
 */
const CLASS_MEMBER_KINDS = new Set(['method', 'get', 'set']);

/** The named refusals `resolveClass` counts under their own why. */
const CLASS_MEMBER_HOLES = new Set([
  'classMemberKindNotSpellable', 'classMemberKeyKindNotSpellable',
  'classMemberValueArgumentMissing', 'classMemberKeyArgumentMissing',
  'classMemberValueIsNotAClosure', 'classMemberAlreadyEmitted', 'classMemberWithoutAUnit',
  'classAccessorIsAsyncOrAGenerator',
]);

/**
 * One `{e:'class'}.members` entry as a class body element.
 *
 * @returns {{node: object}|{why: string, detail?: string}}
 */
/**
 * A non-computed member key, and the name V8 will give the member's function
 * when it recompiles our text.
 *
 * `sanitise` must NOT be used here. It is for variable spellings, and a
 * property key is not one: `class C { "a-b"(){} }` is legal and
 * `sanitise('a-b')` would rename the member. A key that is a valid identifier
 * is emitted as one; anything else is emitted as a string literal, which a
 * class body accepts and which keeps the key exactly as the boilerplate
 * spelled it.
 *
 * The name matters beyond the text. docs/O1.md §4's `sfi` pairing is identity
 * by construction only because `emitName` records what V8 will call the
 * function, and for a class member that is the property name, prefixed with
 * `get `/`set ` for an accessor (`ParseClassPropertyDefinition` ->
 * `SetFunctionNameFromPropertyName(result, name, prefix)` with
 * `ast_value_factory()->get_space_string()`).
 */
function classMemberKey(m) {
  const raw = String(m.key ?? 'member');
  const node = t.isValidIdentifier(raw, false) ? t.identifier(raw) : t.stringLiteral(raw);
  const v8Name = m.kind === 'get' || m.kind === 'set' ? `${m.kind} ${raw}` : raw;
  return { node, v8Name };
}

function classMember(ctx, m, state) {
  if (!m || !CLASS_MEMBER_KINDS.has(m.kind)) {
    return { why: 'classMemberKindNotSpellable', detail: String(m?.kind ?? 'absent') };
  }
  const computedKey = m.computed || (m.key && typeof m.key === 'object');
  const named = computedKey ? null : classMemberKey(m);
  const key = computedKey ? expr(ctx, m.key) : named.node;
  if (m.value?.e !== 'fn') {
    // The boilerplate puts only METHOD / GETTER / SETTER in a template
    // (ClassBoilerplate::New), and BuildClassLiteral fills their argument with
    // `VisitForRegisterValue(property->value(), value)` on a FunctionLiteral,
    // so the argument is a `CreateClosure`. Anything else means the closure was
    // lost on the way here, and a `classProperty` holding it would be a class
    // field -- a different program.
    return { why: 'classMemberValueIsNotAClosure', detail: m.value?.e ?? 'absent' };
  }
  // `resolveFn` answers null for both "no such unit in this file" and "already
  // emitted somewhere else", and they are different defects: the first is the
  // input's, the second is this layer's.
  if (!state.byId.has(m.value.sfiId)) {
    return { why: 'classMemberWithoutAUnit', detail: `sfi ${m.value.sfiId}` };
  }
  // Before `functionLike`, not after: `emitUnitInner` reads `emitName` on entry
  // to build this unit's `perFunction` row, which is what docs/O1.md §4's `sfi`
  // pairing keys on.
  //
  // `childName` gave the unit the spelling it would have had as a SIBLING
  // declaration, uniquified against the parent's bindings (`area$2`); as a
  // class member V8 will call it `area`. Leaving the sibling spelling there
  // takes the function out of `sfi` pairing and into the weaker `name` mode:
  // measured on the 1 039-file corpus, 15 863 functions moved `sfi` -> `name`
  // and the exact count FELL by 686, 33 463 -> 32 777, even though the emitted
  // shape was right.
  //
  // A computed key is deliberately left alone. V8 names such a function at run
  // time and its compile-time SFI name is empty, so recording `''` would pair
  // it against every anonymous function in the file. The stale spelling matches
  // nothing and the pair falls through to the fallback modes, which is the
  // honest outcome for a name we do not know.
  const previousName = state.emitName.get(m.value.sfiId);
  if (named) state.emitName.set(m.value.sfiId, named.v8Name);
  const fn = ctx.functionLike(m.value, 'method');
  // Every path that does not place the member puts the name back: the unit is
  // then emitted as a sibling declaration after all, under the spelling the
  // text will really use.
  const giveUp = (why, detail) => {
    if (named) state.emitName.set(m.value.sfiId, previousName);
    return { why, detail };
  };
  if (!fn) return giveUp('classMemberAlreadyEmitted', `sfi ${m.value.sfiId}`);
  if (fn.type !== 'FunctionExpression') {
    return giveUp('classMemberValueIsNotAClosure', fn.type);
  }
  // `async`/`*` travel with the member, and they are not decoration: dropping
  // them emits `await` inside a non-async method, which is a SyntaxError and
  // takes the WHOLE FILE with it. Measured on a 20-file sample: 4 files stopped
  // compiling, each one an `async` class method.
  //
  // An accessor cannot carry either -- `async get x(){}` and `get *x(){}` are
  // both SyntaxErrors, and function-kind.h gives an accessor its own kind, so
  // the combination means the flag came from somewhere other than the SFI
  // (`ctx.forceAsync`). Refused rather than emitted.
  if ((fn.async || fn.generator) && (m.kind === 'get' || m.kind === 'set')) {
    return giveUp('classAccessorIsAsyncOrAGenerator',
      `${m.kind} ${fn.async ? 'async' : ''}${fn.generator ? '*' : ''}`.trim());
  }
  return {
    node: t.classMethod(m.kind, key, fn.params, fn.body, !!m.computed, !!m.static,
      !!fn.generator, !!fn.async),
  };
}

/** T7's idiom claims, as 11.4's `perFunction[].patterns`. */
function patternSummary(rec) {
  const byKind = {};
  for (const p of rec.patterns ?? []) {
    const k = `${p.kind}:${p.confidence}`;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  return byKind;
}

function perFunctionEntry(unit, ctx, verification, mono, extra) {
  const rep = ctx?.report ?? null;
  return {
    sfiId: unit.sfiId,
    bytecodeId: unit.bytecodeId ?? null,
    name: extra.name ?? unit.name ?? null,
    sourceName: unit.name ?? null,
    kind: unit.kind ?? null,
    isAsync: !!unit.isAsync,
    isGenerator: !!unit.isGenerator,
    parentSfiId: unit.parentSfiId ?? null,
    startPosition: unit.startPosition ?? null,
    endPosition: unit.endPosition ?? null,
    code: extra.code ?? null,
    statements: extra.statements ?? 0,
    role: extra.role ?? null,
    failed: !!extra.failed,
    error: extra.error ?? null,
    refused: extra.refused ?? 0,
    holes: rep ? rep.holes.total : 0,
    holesByWhy: rep ? rep.holes.byWhy : {},
    unstructuredRegions: rep ? rep.unstructuredRegions : 0,
    duplicatedValues: verification ? verification.duplicated.length : 0,
    unresolvedNames: rep ? rep.unresolvedNames : 0,
    unresolvedJoins: verification ? verification.unresolved.length : 0,
    patterns: extra.patterns ?? null,
    monotonicity: mono ?? null,
    verification: verification ? { checks: verification.checks, violations: verification.violations } : null,
  };
}

export { regionStatements } from './region.mjs';
export default { emit, EmitError };
