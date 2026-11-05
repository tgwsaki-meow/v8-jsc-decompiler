// src/recover/index.mjs
//
// Stage C of ARCHITECTURE.md 4.3: SSA IR -> recovered expressions, straight-line
// statements and names. Output: the `RecoveredFunction` of 11.1.
//
//   recover(ir, opts) -> RecoveredFunction
//
// The order is fixed, and each step is a separate module so it can be tested
// and counted on its own:
//
//   1  names.mjs      the naming table (4.5). Context-slot names are READ off
//                     T6's resolution, never recomputed (10.3).
//   2  patterns/      the idiom engine. Runs first among the value passes
//                     because a pattern decides which instructions have no
//                     source form at all, and dce/inlining must see that.
//   3  expr.mjs       the per-opcode transcription, resolved lazily so a
//                     pattern's rewrite wins over the default.
//   4  dce.mjs        pure-and-unused definitions dropped (4.3 step 1).
//   5  inline.mjs     the constrained inlining and the `duplicable` class
//                     (4.3 step 2 / 4.3.2).
//   6  statements      one pass per block in instruction order, which is the
//                     effect order inside a block.
//   7  verify.mjs      T7's own invariants, including the two the baseline
//                     failed: no re-evaluated effect, no duplicated identity.
//
// Layering (11.0): this module imports src/ir, src/profile (through the IR) and
// nothing else. No src/verify, no tools/, no engine, no version literal.
//
// ---------------------------------------------------------------------------
// One design decision worth stating, because it is a reading of the contract
// rather than of the bytecode.
//
// A phi is destructed the classic way: it gets a name and each predecessor
// gets a copy. For a phi that an idiom recognises as `a || b` or `c ? t : e`
// the expression form is ALSO produced -- but as `patterns[].expr`, not as
// `exprs[phi]`. The reason is 11.1 vs 11.3: 11.1 says `consumed` is "not T8's
// input", and 11.3 invariant 1 makes T8 place every reachable block. So if T7
// put `a || b` in `exprs` and T8 independently structured the same diamond,
// whichever of the two T9 dropped, the other would have to be dropped
// consistently -- and if it were not, `b` would be evaluated twice, which is
// exactly metric 6. Keeping the destructed form canonical makes T7's output
// correct on its own and leaves the collapse to T9, which can see both trees.
// The claim, its citation and its count are all still reported.

import { registry } from './opnames.mjs';
import { buildNames, sanitiseIdentifier } from './names.mjs';
import { transcribe, inputMap, hole } from './expr.mjs';
import { RUNTIME } from './runtime.mjs';
import { runPatterns } from './patterns/index.mjs';
import { deadValues } from './dce.mjs';
import { planInlining } from './inline.mjs';
import { verifyRecovered } from './verify.mjs';

export class RecoverError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

/** Expr tags 11.1 declares, plus the extensions this layer documents. */
export const EXPR_TAGS = Object.freeze(new Set([
  // 11.1's closed set
  'lit', 'regexp', 'name', 'this', 'newTarget', 'importMeta', 'array', 'object',
  'fn', 'class', 'unary', 'update', 'bin', 'logical', 'assign', 'cond',
  'member', 'call', 'new', 'template', 'tagged', 'seq', 'await', 'yield', 'hole',
  // extensions, documented in docs/RECOVER.md: 11.1's set has no way to spell
  // these and T9 needs them to reach @babel/types.
  'super',          // Babel's Super, for `super.x` / `super[k]`
  'importCall',     // Babel's Import, for `import(x)`
  'templateObject', // the raw/cooked pair a tagged template's tag receives
]));

/** Tags that are intermediate: a pattern is expected to consume them. */
const INTERMEDIATE_TAGS = Object.freeze(new Set([
  'forInEnumerate', 'forInCache', 'forInNext', 'forInKey', 'getIterator',
  'iterableOf', 'forOfNext', 'resumeValue', 'superConstructor', 'restParameter',
  'restParameterOf', 'generatorObject', 'awaitOperand', 'yieldOperand',
  'iterResult', 'asyncResolve', 'asyncReject', 'resumeMode', 'asyncIterator',
  'copyDataProperties', 'defineClass', 'accessor', 'privateName',
  'privateBrand', 'privateAccessors', 'moduleNamespace', 'newError',
  'disposableStack', 'addDisposable', 'directEval', 'pending',
]));

/**
 * The reasons a function literal may reach no statement and still be COUNTED
 * rather than refused (step 7d, docs/RECOVER.md 9.3). Each one is a gap this
 * layer declares somewhere else and marks with its own hole, so the output
 * already says "I don't know" where the function went. Anything outside this
 * set is an inconsistency in this layer's own analysis and throws: a function
 * must not leave the output silently.
 */
const UNPLACED_LITERAL_DECLARED_GAPS = Object.freeze(new Set([
  // a pattern owns the instruction that holds the literal and placed no
  // member for it -- 8.1's undecoded `ClassBoilerplate`, marked
  // `classMembersNotDecoded`
  'claimedByAPattern', 'claimedByAPatternThroughItsUser',
  // the literal's only reader transcribes to a hole, so no statement can
  // carry it -- `ownPropertyDefinitionNotFoldedIntoItsLiteral` and the other
  // 6 reasons
  'readByAValueWithNoStatement',
]));

/**
 * @param {object} ir an IRFunction from src/ir/index.mjs
 * @param {{maxExprDepth?:number, strict?:boolean}} opts
 */
export function recover(ir, opts = {}) {
  if (!ir || !ir.values || !ir.blocks) throw new RecoverError('recover() needs an IRFunction from src/ir');
  const t0 = process.hrtime.bigint();
  const reg = registry(ir.profile);
  const maxDepth = opts.maxExprDepth ?? 64;
  const warnings = [];
  const warn = (code, detail) => { warnings.push({ code, ...detail }); };

  const values = ir.values;
  const unit = ir.unit;

  // Coarse phase timings, reported in `stats.phases`. Cheap (one hrtime read
  // per phase) and the only way the corpus scan can say where the time went
  // without a profiler attached to a 4 GB host.
  const phases = {};
  let phaseAt = process.hrtime.bigint();
  const phase = (name) => {
    const now = process.hrtime.bigint();
    phases[name] = (phases[name] ?? 0) + Number(now - phaseAt) / 1e6;
    phaseAt = now;
  };

  // ------------------------------------------------------------- 0. helpers
  const isMove = (v) => !!v && v.kind === 'Op' && reg.MOVES.has(v.op);

  // Canonicalisation: Ldar / Star / Mov are exact copies, so a chain of them
  // is one value. Everything downstream -- use counts, inlining, naming --
  // works on canonical ids, which is what makes "Star r; ...; Ldar r" a single
  // definition rather than three.
  const canonMemo = new Int32Array(values.length).fill(-1);
  function canon(id) {
    if (id === null || id === undefined || id < 0 || id >= values.length) return id;
    if (canonMemo[id] >= 0) return canonMemo[id];
    let cur = id;
    const path = [];
    for (let guard = 0; guard < values.length + 2; guard++) {
      if (canonMemo[cur] >= 0) { cur = canonMemo[cur]; break; }
      const v = values[cur];
      if (!isMove(v)) break;
      const src = moveSource(v);
      if (src === null || src === undefined || src < 0 || src === cur) break;
      path.push(cur);
      cur = src;
    }
    canonMemo[id] = cur;
    for (const p of path) canonMemo[p] = cur;
    return cur;
  }
  function moveSource(v) {
    // Ldar <reg> / Mov <from> <to>: the source is the register operand.
    // Star <reg>: the source is the accumulator.
    const m = inputMap(ir, v);
    if (v.op === 'Star') return m.acc;
    for (const group of m.per) if (group && group.length) return group[0];
    return m.acc;
  }
  const sameValue = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && canon(a) === canon(b);

  // real uses of a canonical value: every user that is not itself a move,
  // reached through any number of moves.
  const useMemo = new Map();
  function usesOf(id) {
    const c = canon(id);
    let got = useMemo.get(c);
    if (got) return got;
    const out = [];
    const outSet = new Set();
    const seen = new Set([c]);
    const stack = [c];
    while (stack.length) {
      const cur = stack.pop();
      for (const u of ir.defUse.get(cur) ?? []) {
        const uv = values[u];
        if (!uv) continue;
        if (isMove(uv)) { if (!seen.has(u)) { seen.add(u); stack.push(u); } continue; }
        if (!outSet.has(u)) { outSet.add(u); out.push(u); }
      }
    }
    useMemo.set(c, out);
    got = out;
    return got;
  }

  /**
   * How many times a canonical value is used, counting OCCURRENCES and not
   * distinct users: `f(); r + r` uses the call twice through one instruction.
   * `inputsOf` is the canonicalised input list, so a value that reaches an
   * instruction through two different registers counts twice.
   */
  const inputsMemo = new Map();
  function canonicalInputsOf(v) {
    if (!v || v.kind !== 'Op') {
      if (v?.kind === 'Phi') return (v.operands ?? []).filter((x) => x !== null).map(canon);
      if (v?.kind === 'Proj') return [canon(v.of)];
      return [];
    }
    let got = inputsMemo.get(v.id);
    if (got) return got;
    const m = inputMap(ir, v);
    const out = [];
    if (m.acc !== null && m.acc !== undefined) out.push(canon(m.acc));
    for (const g of m.per) if (g) for (const x of g) out.push(canon(x));
    inputsMemo.set(v.id, out);
    return out;
  }

  const valueAt = (insIdx) => {
    if (insIdx < 0 || insIdx >= ir.instructions.length) return null;
    const id = ir.instructionValue[insIdx];
    return id >= 0 ? values[id] : null;
  };
  const terminatorOf = (b) => (b ? valueAt(b.last) : null);
  const accInputOf = (v) => (v && v.kind === 'Op' ? inputMap(ir, v).acc : null);
  const flatRegInputs = (v) => {
    if (!v || v.kind !== 'Op') return [];
    const m = inputMap(ir, v);
    const out = [];
    for (const g of m.per) if (g) out.push(...g);
    return out;
  };
  const firstRegInput = (v) => { const a = flatRegInputs(v); return a.length ? a[0] : null; };
  const nameOperandOf = (v) => {
    if (!v || v.kind !== 'Op') return null;
    const ins = ir.instructions[v.instruction];
    const c = ins?.operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
    return c?.t === 'string' ? c.v : null;
  };
  const runtimeNameOf = (v) => {
    if (!v || v.kind !== 'Op') return null;
    const ins = ir.instructions[v.instruction];
    if (!ins) return null;
    for (const o of ins.operands) {
      if (o.type === 'kIntrinsicId') return o.name ?? null;
      if (o.type === 'kRuntimeId') return o.name ?? null;
    }
    return null;
  };
  const isCall = (v) => !!v && v.kind === 'Op' && reg.CALLS.has(v.op);
  const stringOf = (id) => {
    const v = values[canon(id)];
    if (!v || v.kind !== 'Op') return null;
    const e = shallowExpr(v.id);
    return e?.e === 'lit' && typeof e.v === 'string' ? e.v : null;
  };

  // ------------------------------------------------------- 1. the name table
  const names = buildNames(ir, {
    helpers: {
      closureName: (ins) => {
        const c = ins.operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
        if (c?.t !== 'sfi') return null;
        return closureMeta(c.sfiId)?.name ?? null;
      },
      calleeName: (v) => {
        const calleeId = firstRegInput(v);
        if (calleeId === null) return null;
        const cv = values[canon(calleeId)];
        if (!cv || cv.kind !== 'Op') return null;
        if (cv.op === 'GetNamedProperty' || cv.op === 'LdaGlobal') return nameOperandOf(cv);
        if (cv.contextSlot?.resolved) return cv.contextSlot.name;
        return null;
      },
    },
  });

  const closureCache = new Map();
  function closureMeta(sfiId) {
    if (closureCache.has(sfiId)) return closureCache.get(sfiId);
    const m = (opts.unitsBySfi instanceof Map ? opts.unitsBySfi.get(sfiId) : null) ?? null;
    const meta = m
      ? { name: m.name ?? null, parameterCount: m.parameterCount ?? null, isAsync: !!m.isAsync, isGenerator: !!m.isGenerator, kind: m.kind ?? null }
      : null;
    closureCache.set(sfiId, meta);
    return meta;
  }

  function contextSlotName(v) {
    const slotId = v?.contextSlot?.slotValue;
    if (slotId === null || slotId === undefined) {
      // 4.5's placeholder: no single context frame reaches this instruction
      // (docs/IR.md 11, `contextValueNotStaticallyKnown`), so there is nothing
      // to look a name up in. Emit the declared `/* ctx[d][i] */` stand-in
      // rather than a hole -- the slot is real, only its name is unknown.
      const cs = v?.contextSlot ?? {};
      const rec = names.placeholderFor(cs.depth ?? 0, cs.index ?? 0, cs.why ?? null);
      return {
        e: 'name', name: rec.name, comment: rec.comment,
        ref: { k: 'contextSlot', slotValue: null, depth: cs.depth ?? null, index: cs.index ?? null, resolved: false, why: cs.why ?? null },
      };
    }
    const rec = names.byContextSlot.get(slotId);
    if (!rec) return hole('contextSlotUnnamed', String(slotId), null);
    return {
      e: 'name', name: rec.name,
      ref: {
        k: 'contextSlot', slotValue: slotId,
        depth: v.contextSlot.depth, index: v.contextSlot.index,
        resolved: !!v.contextSlot.resolved,
      },
      ...(rec.comment ? { comment: rec.comment } : {}),
    };
  }

  // ------------------------------------------------- 2. the shallow resolver
  // Used only while patterns run: it answers "what shape is this op" without
  // recursing into operands, so a pattern can inspect a value cheaply and a
  // later pattern's rewrite cannot be invalidated by a stale memo.
  const PENDING = Object.freeze({ e: 'pending' });
  const shallowMemo = new Map();
  function shallowExpr(id) {
    const v = values[id];
    if (!v || v.kind !== 'Op') return null;
    // Memoised: this is the RAW transcription of one opcode, which no pattern
    // can change -- a pattern's rewrite lives in `exprOverride` and is read
    // through `pc.E`, never through here. Without the memo every
    // `pc.exprOf(...)` in a pattern and every `isDuplicable` call in the plan
    // re-ran `transcribe`, which builds a dozen closures per call.
    const got = shallowMemo.get(id);
    if (got !== undefined) return got;
    const r = runTranscribe(v, () => PENDING);
    const out = r?.expr ?? null;
    shallowMemo.set(id, out);
    return out;
  }

  // ------------------------------------------------------ 3. pattern context
  const exprOverride = new Map();     // ssaId -> thunk
  const altExpr = new Map();          // ssaId -> thunk (an alternative form)
  const stmtOverride = new Map();     // ssaId -> thunk
  const objectProps = new Map();      // objValueId -> [{order, thunk}]
  const arrayElements = new Map();    // arrValueId -> [{index, thunk}]
  const consumedIns = new Set();
  const consumedBlocks = new Set();
  const consumedEdges = new Set();
  const consumedHandlerRanges = new Set();
  const forceMaterial = new Set();
  // Why each forced value was forced. A pattern is the usual answer; step 5b
  // adds the other one, and the two must not be reported as each other.
  const forceMaterialWhy = new Map();    // ssaId -> reason
  const patternValues = new Set();
  const patterns = [];
  const tdzNames = new Map();
  const restParams = [];
  const patternStats = { byKind: {}, byFamily: {}, byConfidence: { exact: 0, shape: 0 } };

  const pc = {
    ir, reg, values, names, patterns, stats: patternStats,
    canon, sameValue, usesOf, valueAt, terminatorOf, accInputOf,
    flatRegInputs, firstRegInput, nameOperandOf, runtimeNameOf, isMove, isCall,
    stringOf, contextSlotName,
    exprOf: shallowExpr,
    transcribeFresh: (id) => shallowExpr(id),
    hasExpr: (id) => exprOverride.has(id) || altExpr.has(id),
    E: (id) => resolve(id, 0),
    isConsumed: (i) => consumedIns.has(i),
    consume(i) { if (i !== undefined && i !== null && i >= 0) consumedIns.add(i); },
    consumeBlock(id) { if (id !== undefined && id !== null) consumedBlocks.add(id); },
    consumeEdge(id) { if (id !== undefined && id !== null) consumedEdges.add(id); },
    consumeHandlerRange(i) { if (i !== undefined && i !== null) consumedHandlerRanges.add(i); },
    consumeMovesFeeding(v) {
      // the Mov/Star sequence that filled a runtime call's argument list. They
      // produce no statement anyway (they are moves); marking them consumed is
      // what makes `consumed.instructions` an honest account.
      if (!v || v.kind !== 'Op') return;
      for (const g of inputMap(ir, v).per) {
        if (!g) continue;
        for (const id of g) {
          const src = values[id];
          if (src && isMove(src) && src.block === v.block) consumedIns.add(src.instruction);
        }
      }
    },
    suppressBlockTail(id) { consumedBlocks.add(id); },
    setExpr(id, thunk) {
      if (id === null || id === undefined) return;
      patternValues.add(id);
      // See the header: an idiom's rewrite of a PHI is an alternative
      // description, not the canonical one.
      if (values[id]?.kind === 'Phi') altExpr.set(id, thunk);
      else exprOverride.set(id, thunk);
    },
    setAltExpr(id, thunk) { if (id !== null && id !== undefined) { altExpr.set(id, thunk); patternValues.add(id); } },
    setStmt(id, thunk) { if (id !== null && id !== undefined) { stmtOverride.set(id, thunk); patternValues.add(id); } },
    addObjectProperty(objId, orderOrThunk, maybeThunk) {
      const thunk = maybeThunk ?? orderOrThunk;
      const order = maybeThunk ? orderOrThunk : Number.MAX_SAFE_INTEGER;
      if (!objectProps.has(objId)) objectProps.set(objId, []);
      objectProps.get(objId).push({ order, thunk });
      patternValues.add(objId);
    },
    addArrayElement(arrId, index, thunk) {
      if (!arrayElements.has(arrId)) arrayElements.set(arrId, []);
      arrayElements.get(arrId).push({ index, thunk });
      patternValues.add(arrId);
    },
    forceMaterialise(id) { if (id !== null && id !== undefined) forceMaterial.add(canon(id)); },
    declareRestParameter(id, from) { restParams.push({ value: id, from }); },
    noteTdz(name) { if (name) tdzNames.set(name, (tdzNames.get(name) ?? 0) + 1); },
    feedsOnly(id, pred) {
      // every terminal user of `id`, following non-move users, satisfies pred
      const seen = new Set();
      const stack = [canon(id)];
      let any = false;
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const us = usesOf(cur);
        if (!us.length) return false;
        for (const u of us) {
          const uv = values[u];
          if (!uv) return false;
          if (pred(uv)) { any = true; continue; }
          if (uv.kind === 'Op' || uv.kind === 'Proj') { stack.push(uv.id); continue; }
          return false;
        }
      }
      return any;
    },
    claim(rec) {
      const cites = rec.cites ?? [];
      const confidence = cites.length ? (rec.confidence ?? 'exact') : 'shape';
      const p = {
        kind: rec.kind,
        blocks: (rec.blocks ?? []).filter((x) => x !== null && x !== undefined),
        values: (rec.values ?? []).filter((x) => x !== null && x !== undefined),
        instructions: (rec.instructions ?? []).filter((x) => x !== null && x !== undefined),
        handlerRanges: rec.handlerRanges ?? [],
        confidence, detail: rec.detail ?? null, cites,
      };
      patterns.push(p);
      patternStats.byKind[p.kind] = (patternStats.byKind[p.kind] ?? 0) + 1;
      patternStats.byConfidence[confidence]++;
      for (const v of p.values) patternValues.add(v);
      return p;
    },
    warn,
  };

  phase('setup');
  runPatterns(pc);
  phase('patterns');

  // ------------------------------------ 3b. what a rewrite still references
  //
  // A pattern's rewrite is a thunk, so the values it mentions are NOT in the
  // IR's input lists, and the instruction that used to mention them is in
  // `consumed`. `{a: f()}` is the short example: the fold deletes the
  // `DefineNamedOwnProperty` and re-mentions its accumulator operand inside
  // the object literal. Inverted, `ResumeGenerator`'s register projections
  // re-mention the registers `SuspendGenerator` spilled and stop mentioning
  // the resume value itself.
  //
  // Occurrence counting has to see both directions. Counting IR inputs alone
  // undercounts (a value whose only IR user was consumed looks unused, gets
  // inlined, and is then printed once per fold -- metric 6 back through the
  // side door: measured, 7 values in 1940 functions, all of them `await`
  // inside two object literals on two paths) and overcounts (eight register
  // projections made every `await` look like a nine-use value and materialise).
  //
  // So the references are DISCOVERED, not declared per pattern: every
  // registered thunk is run once with `pc.E` replaced by a recorder. The
  // thunks are pure builders, the real resolver has not run yet, so nothing is
  // memoised and nothing is lost. A thunk that insists on a real expression
  // throws; its partial trace is kept and its owner falls back to also
  // counting the IR inputs, which is the safe direction.
  const TRACE_EXPR = Object.freeze({ e: 'lit', v: null, trace: true });
  const rewriteRefs = new Map();            // owner ssaId -> {refs:[id], failed}
  {
    const realE = pc.E;
    let sink = null;
    pc.E = (id) => {
      if (sink && id !== null && id !== undefined && id >= 0) sink.push(canon(id));
      return TRACE_EXPR;
    };
    const trace = (owner, thunk) => {
      const before = sink;
      sink = [];
      let failed = false;
      try { thunk(); } catch { failed = true; }
      const got = sink;
      sink = before;
      let rec = rewriteRefs.get(owner);
      if (!rec) { rec = { refs: [], failed: false }; rewriteRefs.set(owner, rec); }
      rec.refs.push(...got);
      if (failed) rec.failed = true;
    };
    for (const [id, t] of exprOverride) trace(id, t);
    for (const [id, t] of stmtOverride) trace(id, t);
    for (const [id, list] of objectProps) for (const x of list) trace(id, x.thunk);
    for (const [id, list] of arrayElements) for (const x of list) trace(id, x.thunk);
    pc.E = realE;
  }

  /**
   * The canonical values one value's emitted form mentions. A rewrite replaces
   * the IR inputs; a rewrite whose trace threw adds to them.
   */
  function refsOf(id) {
    const rw = rewriteRefs.get(id);
    const v = values[id];
    if (!rw) return canonicalInputsOf(v);
    if (!rw.failed) return rw.refs;
    return [...rw.refs, ...canonicalInputsOf(v)];
  }

  // -------------------------------------------- 4. the recursive transcriber
  const exprMemo = new Map();
  const resolving = new Set();

  function resolve(id, depth) {
    if (id === null || id === undefined || id < 0) {
      return hole('noDefinition', 'a use with no reaching definition', null);
    }
    const c = canon(id);
    if (exprMemo.has(c)) return exprMemo.get(c);
    if (depth > maxDepth) return hole('exprTooDeep', `depth ${depth}`, null);
    if (resolving.has(c)) return hole('exprCycle', `value ${c}`, null);
    resolving.add(c);
    let out;
    try {
      out = build(c, depth);
    } finally {
      resolving.delete(c);
    }
    exprMemo.set(c, out);
    return out;
  }

  function build(id, depth) {
    const v = values[id];
    if (!v) return hole('noValue', String(id), null);

    // a materialised value reads as its name wherever it is used
    if (materialisedNames.has(id)) {
      const rec = materialisedNames.get(id);
      return { e: 'name', name: rec.name, ref: { k: rec.kind, valueId: id } };
    }

    const ov = exprOverride.get(id);
    if (ov) return normalise(ov(), id);

    switch (v.kind) {
      case 'Param':
        return v.isReceiver
          ? { e: 'this' }
          : { e: 'name', name: names.byValue.get(v.id)?.name ?? ('p' + (v.index - 1)), ref: { k: 'param', index: v.index - 1 } };
      case 'FrameEntry':
        if (v.what === 'incomingNewTarget') return { e: 'newTarget' };
        if (v.what === 'accumulatorUndefinedOnEntry' || v.what === 'registerFileUndefinedOnEntry') {
          return { e: 'lit', v: undefined };
        }
        if (v.what === 'incomingGeneratorObject') {
          return { e: 'name', name: '__generator', ref: { k: 'temp', generatorObject: true } };
        }
        if (v.what === 'frameHeaderRegister' && v.reg?.k === 'closure') {
          // VisitThisFunctionVariable:8581 moves <closure> into the
          // `.this_function` variable, which is what a named function
          // expression refers to itself by. The function's own name is the
          // honest spelling; an anonymous one has none, so it stays a hole.
          const n = unit.name ? names.declareFunctionSelf(unit.name) : null;
          return n
            ? { e: 'name', name: n, ref: { k: 'local', thisFunction: true } }
            : hole('closureRegisterOfAnAnonymousFunction', 'read of <closure> with no SFI name', null);
        }
        if (v.what === 'incomingContext' || v.what === 'frameHeaderRegister') {
          return hole('frameHeaderRegisterReadAsValue', `${v.what}:${v.reg?.k ?? '?'}`, null);
        }
        return hole('frameEntry', String(v.what), null);
      case 'CaughtException': {
        const rec = names.byValue.get(v.id) ?? names.nameValue(v.id, 'let');
        return { e: 'name', name: rec.name, ref: { k: 'local', caughtException: true } };
      }
      case 'ContextSlot': {
        const rec = names.byContextSlot.get(v.id);
        return rec
          ? { e: 'name', name: rec.name, ref: { k: 'contextSlot', slotValue: v.id } }
          : hole('contextSlotUnnamed', String(v.id), null);
      }
      case 'Phi': {
        const rec = names.byValue.get(v.id);
        if (rec) return { e: 'name', name: rec.name, ref: { k: 'temp', phi: v.id } };
        return hole('phiWithoutName', `phi ${v.id} in block ${v.block}`, null);
      }
      case 'Proj':
        return hole('multiOutputProjection', `${v.op} output ${v.slot}`, `@${ir.instructions[v.instruction]?.offset}`);
      case 'EffectPhi':
      case 'EffectEntry':
        return hole('effectValueReadAsData', v.kind, null);
      case 'Op':
        break;
      default:
        return hole('valueKind', String(v.kind), null);
    }

    const r = runTranscribe(v, (inId) => resolve(inId, depth + 1));
    if (!r) return hole('opcodeNotTranscribed', v.op, null);
    if (r.kind === 'skip') return hole('valueOfASkippedInstruction', v.op, `@${ir.instructions[v.instruction]?.offset}`);
    if (r.expr) return normalise(withLiteralFolds(v, r.expr, depth), id);
    return hole('statementUsedAsValue', v.op, `@${ir.instructions[v.instruction]?.offset}`);
  }

  /** Fold the pattern-collected literal members into an object/array literal. */
  function withLiteralFolds(v, base, depth) {
    if (base?.e === 'object' && objectProps.has(v.id)) {
      const extra = objectProps.get(v.id).slice().sort((a, b) => a.order - b.order);
      return { ...base, props: [...(base.props ?? []), ...extra.map((x) => x.thunk())] };
    }
    if (base?.e === 'array' && arrayElements.has(v.id)) {
      const out = (base.elements ?? []).slice();
      for (const { index, thunk } of arrayElements.get(v.id).slice().sort((a, b) => a.index - b.index)) {
        while (out.length < index) out.push(null);
        out[index] = thunk();
      }
      return { ...base, elements: out };
    }
    return base;
  }

  /** An intermediate tag that survived becomes a counted hole (honesty rule). */
  function normalise(x, id) {
    if (!x || typeof x !== 'object' || typeof x.e !== 'string') {
      return hole('nonExpr', typeof x, null);
    }
    if (EXPR_TAGS.has(x.e)) return x;
    if (INTERMEDIATE_TAGS.has(x.e) || x.e === 'pending') {
      return hole('unconsumedIntermediate:' + x.e, `value ${id}`, null);
    }
    return hole('unknownExprTag:' + x.e, `value ${id}`, null);
  }

  function runTranscribe(v, E) {
    return transcribe({
      ir, names, reg, E,
      sameValue: (a, b) => sameValue(a, b),
      // The defining SSA value behind a use, with moves canonicalised away.
      // The transcription needs it where the SHAPE of a use depends on which
      // instruction produced the value and not only on its expression: a
      // property call has to know whether its callee register was loaded out
      // of its receiver register (expr.mjs, CallProperty*).
      defOf: (id) => (id === null || id === undefined ? null : (values[canon(id)] ?? null)),
      contextSlotName,
      closureMeta,
      runtimeCall: (op, env) => runtimeCall(op, env, E),
    }, v);
  }

  function runtimeCall(v, env, E) {
    const name = runtimeNameOf(v);
    const args = [];
    for (const g of env.per) if (g) args.push(...g);
    if (env.acc !== null && env.acc !== undefined) args.unshift(env.acc);
    if (!name) {
      return { kind: 'expr', expr: hole('runtimeIdNotNamedByProfile', `${v.op}`, `@${env.ins.offset}`) };
    }
    const row = RUNTIME[name];
    if (!row) {
      return {
        kind: 'expr',
        expr: hole('unmodelledRuntimeCall', name,
          `@${env.ins.offset} ${v.op} %${name}/${args.length}; not one of the 63 Runtime::k* `
          + 'names src/interpreter/bytecode-generator.cc can emit'),
      };
    }
    const cx2 = { stringOf };
    switch (row.role) {
      case 'skip': return { kind: 'skip', note: row.note };
      case 'stmt': {
        const s = row.make(args, E, cx2);
        return { kind: 'stmt', stmt: { ...s, pos: env.pos, values: [v.id] } };
      }
      case 'expr':
      case 'inter':
      default:
        return { kind: 'expr', expr: row.make ? row.make(args, E, cx2) : hole('runtimeNoShape', name, null) };
    }
  }

  phase('rewriteRefs');

  // ------------------------------------------ 4b. the function literals
  //
  // Every instruction that turns a `SharedFunctionInfo` into a function
  // object. Keyed on the CONSTANT and not on an opcode name, because
  // `{t:'sfi'}` in the constant pool is the thing that matters: it is this
  // function's only statement that the program contains that other function.
  // `DeclareGlobals` carries its SFIs inside a `{t:'array'}` pair list and so
  // is deliberately not matched -- V8 does not drop a top-level declaration.
  //
  // These are tracked as a set because losing one is not like losing any
  // other value. See dce.mjs's header for the V8 site and the measurement:
  // V8 emits no `CreateClosure` for a declaration nothing reads, so a
  // `CreateClosure` in the input proves the original had a reader, and a
  // `CreateClosure` that reaches no statement of ours deletes that whole
  // function -- and its own children -- from the recompiled output.
  const functionLiterals = [];
  for (let i = 0; i < ir.instructions.length; i++) {
    const ins = ir.instructions[i];
    let sfiId = null;
    for (const o of ins.operands) {
      if (o.type !== 'kConstantPoolIndex') continue;
      if (o.constant?.t === 'sfi') { sfiId = o.constant.sfiId; break; }
    }
    if (sfiId === null) continue;
    functionLiterals.push({ at: i, vid: ir.instructionValue[i], sfiId });
  }

  // ------------------------------------------------------------- 5. dce
  const dce = deadValues({
    ir, isMove, consumedIns, patternValues,
    extraRoots: functionLiterals.map((f) => f.vid),
  });
  phase('dce');

  // ------------------------------- 5b. a function literal nothing reads
  //
  // The statement pass has two branches for a value-producing instruction:
  // name it, or emit it for its effect. A `CreateClosure` whose value has no
  // live use fits neither -- `alloc()` leaves `hasEffect` false -- so it used
  // to fall through both and vanish with no statement, no hole and no
  // counter. Measured on 29 corpus files, 2 of 5 284
  // (`tools/probes/probe_closure.mjs fate`), so this is a rare shape and not
  // the corpus-wide defect it was suspected to be -- but each one costs a
  // function and all of its descendants, so it is repaired rather than
  // counted.
  //
  // The repair is to materialise it: `let fn = function ...`. That is not a
  // guess, it is the inverse of the bytecode -- the original is
  // `CreateClosure; Star rN` with `rN` never read again, and a `let` whose
  // initialiser is the closure compiles back to exactly that pair. Refusing
  // the function instead would be the other candidate, and it is the wrong
  // trade: a refusal replaces the body with a `throw`, which un-references
  // every closure the body created, and docs/O1.md 6.8 measured that cost --
  // 1 483 paired functions lost to 23 refusals. Repair what the bytecode
  // states; refuse only what it does not state.
  //
  // The repair is reported as its own reason and not as `forcedByPattern`,
  // which is the only other way a value is forced out of the inlining plan:
  // a duplication report has to be able to tell a pattern's decision from
  // this one.
  const literalStats = {
    functionLiterals: functionLiterals.length,
    functionLiteralsMaterialisedForNoLiveUse: 0,
    functionLiteralsInAStatement: 0,
    functionLiteralsNotInAnyStatement: 0,
    byUnplacedFunctionLiteral: {},
  };
  for (const f of functionLiterals) {
    if (f.vid === undefined || f.vid < 0) continue;
    if (consumedIns.has(f.at)) continue;
    const c = canon(f.vid);
    if (usesOf(c).some((u) => !dce.dead.has(u))) continue;
    forceMaterial.add(c);
    forceMaterialWhy.set(c, 'forcedByAFunctionLiteralWithNoLiveUse');
    literalStats.functionLiteralsMaterialisedForNoLiveUse++;
    warn('functionLiteralWithNoLiveUse', {
      at: ir.instructions[f.at]?.offset ?? f.at, sfiId: f.sfiId, value: c,
    });
  }
  phase('functionLiterals');

  // ------------------------------------------------- 6. the inlining plan
  const isConsumedUser = (userId) => {
    const uv = values[userId];
    return !!uv && uv.kind === 'Op' && consumedIns.has(uv.instruction);
  };
  // How many times each value's DEFINING expression can be reached from the
  // emitted program.
  //
  // Every value contributes its references EXACTLY ONCE, which is sound given
  // the rule the plan then enforces: a value reached more than once is
  // materialised, so it is emitted once either way. What each value mentions
  // is `refsOf` -- a rewrite's traced references when it has one, the IR
  // inputs otherwise. A phi counts its operands once per incoming edge, which
  // is what its copies emit.
  //
  // Two kinds of value contribute nothing. A move is a copy that
  // canonicalisation already erased. An instruction an idiom consumed emits no
  // statement -- the statement pass skips it before it looks at any override --
  // so it contributes only once something references its VALUE, which is the
  // worklist below. That distinction is load-bearing in both directions: a
  // folded `DefineNamedOwnProperty` is consumed and unreferenced, so counting
  // its object operand would materialise every object literal; a consumed
  // `ResumeGenerator` carrying `{e:'await', arg}` is referenced by whatever
  // reads the await, so NOT counting its operand let the awaited expression be
  // printed once per reader.
  const occTable = new Int32Array(values.length);
  {
    const counted = new Uint8Array(values.length);
    const emits = (v) => !!v && !dce.dead.has(v.id) && !isMove(v);
    const queue = [];
    for (const v of values) {
      if (!emits(v)) continue;
      if (v.kind === 'Op' && consumedIns.has(v.instruction)) continue;
      queue.push(v.id);
    }
    while (queue.length) {
      const id = queue.pop();
      if (counted[id]) continue;
      counted[id] = 1;
      for (const r of refsOf(id)) {
        if (r === null || r === undefined || r < 0 || r >= occTable.length) continue;
        if (!emits(values[r])) continue;
        occTable[r]++;
        if (!counted[r]) queue.push(r);
      }
    }
  }
  const occurrencesOf = (id) => {
    const c = canon(id);
    if (dce.dead.has(c)) return 0;
    return occTable[c];
  };
  const occurrencesIn = (id, userId) => {
    const c = canon(id);
    let n = 0;
    for (const r of refsOf(userId)) if (r === c) n++;
    return n;
  };
  const hasConsumedUser = (id) => usesOf(id).some(isConsumedUser);

  const materialisedNames = new Map();     // filled after the plan, read by build()
  const plan = planInlining({
    ir,
    canon,
    occurrencesOf,
    occurrencesIn,
    hasConsumedUser,
    exprOf: (id) => shallowExpr(id),
    consumedIns,
    isMove,
    canonicalInputs: (v) => refsOf(v.id),
  });
  for (const id of forceMaterial) {
    if (dce.dead.has(id)) continue;
    if (plan.duplicable.has(id)) continue;
    plan.inlined.delete(id);
    plan.materialised.add(id);
    plan.reasons.set(id, forceMaterialWhy.get(id) ?? 'forcedByPattern');
  }

  // Phis that survived and were not rewritten need a name and copies.
  const livePhis = [];
  for (const b of ir.blocks) {
    for (const pid of b.phis ?? []) {
      if (dce.dead.has(pid)) continue;
      livePhis.push(pid);
    }
  }
  // A caught exception is the `catch (e)` binding: a name, never an expression.
  const liveCaught = [];
  for (const v of values) {
    if (v?.kind === 'CaughtException' && !dce.dead.has(v.id)) liveCaught.push(v.id);
  }

  // Names are allocated in ONE pass in ascending SSA id, which is what makes
  // the synthetic rule reproducible across runs (docs/RECOVER.md).
  const needName = [...new Set([...plan.materialised, ...livePhis, ...liveCaught])]
    .filter((id) => !dce.dead.has(id))
    .sort((a, b) => a - b);
  for (const id of needName) {
    const v = values[id];
    const kind = v?.kind === 'Phi' ? 'temp' : (v?.kind === 'CaughtException' ? 'let' : 'temp');
    const rec = names.byValue.get(id) ?? names.nameValue(id, kind);
    materialisedNames.set(id, { name: rec.name, origin: rec.origin, kind: v?.kind === 'Phi' ? 'temp' : 'temp' });
  }
  phase('plan');

  // ------------------------------------------------------- 7. the statements
  const stmts = new Map();
  const exprs = new Map();
  const emitStats = {
    blocks: 0, statements: 0, holesInExprs: 0, holesInStmts: 0,
    holesInUnusedExprs: 0,
    materialisedStatements: 0, discardedResults: 0, phiCopies: 0,
    byHoleWhy: {}, byUnusedHoleWhy: {},
    // 4.3 drops a pure definition nothing reads. That is correct for the
    // register copies V8 leaves behind, and it is the one place in this
    // layer where something leaves without a statement, so it is counted by
    // opcode rather than left to be inferred from a value count.
    droppedPureValues: 0, byDroppedPureOpcode: {},
    ...literalStats,
  };
  const push = (bid, s) => {
    if (!s) return;
    let l = stmts.get(bid);
    if (!l) { l = []; stmts.set(bid, l); }
    l.push(s);
    emitStats.statements++;
  };

  for (const bid of ir.dominators.rpo) {
    const b = ir.blocks[bid];
    emitStats.blocks++;
    for (let i = b.first; i <= b.last; i++) {
      const vid = ir.instructionValue[i];
      if (vid < 0) continue;
      if (consumedIns.has(i)) continue;
      const v = values[vid];
      if (!v || v.kind !== 'Op') continue;
      if (isMove(v)) continue;
      const c = canon(vid);

      const so = stmtOverride.get(vid);
      if (so) {
        const s = so();
        push(bid, { ...s, pos: posOf(i), values: [vid] });
        continue;
      }

      if (dce.dead.has(vid) && !v.hasEffect) continue;

      const r = runTranscribe(v, (inId) => resolve(inId, 1));
      if (!r || r.kind === 'skip') continue;
      if (r.kind === 'stmt' || r.kind === 'both') {
        push(bid, { ...r.stmt, pos: r.stmt.pos ?? posOf(i), values: r.stmt.values ?? [vid] });
        if (r.kind === 'stmt') continue;
      }

      // a value-producing instruction
      const uses = usesOf(c).filter((u) => !dce.dead.has(u));
      if (materialisedNames.has(c) && c === vid) {
        const rec = materialisedNames.get(c);
        push(bid, {
          s: 'decl', kind: 'let',
          decls: [{ id: { e: 'name', name: rec.name, ref: { k: 'temp', valueId: vid } }, init: resolveForDefinition(vid) }],
          pos: posOf(i), values: [vid],
        });
        emitStats.materialisedStatements++;
      } else if (!uses.length) {
        if (v.hasEffect) {
          push(bid, { s: 'expr', expr: resolveForDefinition(vid), pos: posOf(i), values: [vid] });
          emitStats.discardedResults++;
        } else {
          // Pure, live (some root reaches it) and read by nothing: no
          // statement is emitted. Counted by opcode -- this is the only exit
          // from this pass that produces nothing.
          emitStats.droppedPureValues++;
          emitStats.byDroppedPureOpcode[v.op] = (emitStats.byDroppedPureOpcode[v.op] ?? 0) + 1;
        }
      }
    }

    // phi copies on the way out, one per outgoing edge's target phi
    for (const eid of b.outEdges ?? []) {
      const e = ir.edges[eid];
      if (!e) continue;
      const target = ir.blocks[e.to];
      if (!target) continue;
      const j = (target.inEdges ?? []).indexOf(eid);
      if (j < 0) continue;
      for (const pid of target.phis ?? []) {
        if (!materialisedNames.has(pid)) continue;
        const phi = values[pid];
        const operand = phi.operands[j];
        if (operand === null || operand === undefined) continue;
        const rec = materialisedNames.get(pid);
        const src = resolve(operand, 1);
        if (src?.e === 'name' && src.name === rec.name) continue;        // v = v
        push(bid, {
          s: 'expr',
          expr: {
            e: 'assign', op: '=',
            target: { e: 'name', name: rec.name, ref: { k: 'temp', phi: pid } },
            value: src,
          },
          pos: posOf(b.last), values: [pid, operand], phiCopy: { phi: pid, edge: eid },
        });
        emitStats.phiCopies++;
      }
    }
  }

  phase('stmts');

  function posOf(i) {
    const ins = ir.instructions[i];
    return { sourcePosition: ins?.sourcePosition ?? null, isStatement: !!ins?.isStatement };
  }

  /** The defining expression of a value, bypassing its own name. */
  function resolveForDefinition(id) {
    const c = canon(id);
    const saved = materialisedNames.get(c);
    if (saved) materialisedNames.delete(c);
    exprMemo.delete(c);
    let out;
    try { out = resolve(c, 0); } finally {
      exprMemo.delete(c);
      if (saved) materialisedNames.set(c, saved);
    }
    return out;
  }

  // ------------------------------------------------- 7b. the `exprs` table
  //
  // 11.3 invariant 2: every value T8 names in a `Test` or a `Target` must have
  // an `exprs` entry. T8 names terminator inputs and context-slot locations,
  // so those are the entries that MUST be there; a data-defining value gets
  // one too so T9 can resolve any `values[]` reference it finds.
  //
  // What deliberately does NOT get an entry: an instruction whose
  // transcription is a statement or has no source form at all (a store, a
  // context push, a jump). Those define no data -- src/ir leaves `var` at -1
  // for them -- so "the expression of this value" is not a question with an
  // answer, and inventing a hole for it would inflate the hole count with
  // entries nothing ever reads.
  const nonData = new Set();
  const definesData = (v) => {
    if (!v) return false;
    if (v.kind === 'EffectPhi' || v.kind === 'EffectEntry') return false;
    if (v.kind !== 'Op') return true;
    return v.var >= 0;
  };
  for (const v of values) {
    if (!v || dce.dead.has(v.id) || exprs.has(v.id)) continue;
    if (!definesData(v)) { nonData.add(v.id); continue; }
    const e = resolve(v.id, 0);
    if (e) exprs.set(v.id, e);
  }
  // T8's `Test.value` is "the SSA value this block's terminator reads", so
  // make sure every one of those resolves even when the terminator itself
  // defines nothing.
  const testValues = new Set();
  for (const b of ir.blocks) {
    const t = valueAt(b.last);
    if (!t || t.kind !== 'Op') continue;
    const a = accInputOf(t);
    if (a === null || a === undefined) continue;
    testValues.add(canon(a));
    if (!exprs.has(canon(a))) exprs.set(canon(a), resolve(a, 0));
  }

  phase('exprs');

  const mentionedSfis = new Set();
  countHoles();
  phase('holes');
  function countHoles() {
    const seen = new Set();
    const walk = (x, into) => {
      if (!x || typeof x !== 'object' || seen.has(x)) return;
      if (Array.isArray(x)) { for (const y of x) walk(y, into); return; }
      seen.add(x);
      // which function literals the EMITTED statements really mention (the
      // accounting below). An entry in `exprs` that no statement reaches
      // cannot put a function into the output, so only `into === 'stmt'`
      // counts.
      if (into === 'stmt' && (x.e === 'fn' || x.e === 'class') && x.sfiId !== null
        && x.sfiId !== undefined) mentionedSfis.add(x.sfiId);
      if (x.e === 'hole' || x.s === 'hole') {
        const why = x.why ?? 'unknown';
        if (into === 'unused') {
          emitStats.holesInUnusedExprs++;
          emitStats.byUnusedHoleWhy[why] = (emitStats.byUnusedHoleWhy[why] ?? 0) + 1;
        } else {
          emitStats.byHoleWhy[why] = (emitStats.byHoleWhy[why] ?? 0) + 1;
          if (into === 'stmt') emitStats.holesInStmts++; else emitStats.holesInExprs++;
        }
      }
      for (const k of Object.keys(x)) {
        if (k === 'ref' || k === 'pos' || k === 'values' || k === 'cites') continue;
        walk(x[k], into);
      }
    };
    // the emitted program first, so a hole that is both emitted and merely
    // tabulated counts as emitted
    for (const l of stmts.values()) for (const s of l) walk(s, 'stmt');
    for (const id of testValues) walk(exprs.get(id), 'expr');
    for (const [id, e] of exprs) if (!testValues.has(id)) walk(e, 'unused');
  }

  // ------------------------------- 7d. every function literal, accounted for
  //
  // 11.5 says every function enters the output. The place that can break it
  // silently is here, one layer earlier than it was ever looked for: a
  // function literal whose `{e:'fn'}` appears in NO statement cannot reach
  // T9, so T9 emits that function as a sibling declaration nothing
  // references, and V8 then does not serialise it at all
  // (`bytecode-generator.cc::VisitFunctionDeclaration:2181`, returning at
  // :2187). That is what docs/O1.md 6.3's A-side unpaired count measures, and
  // until this counter existed the loss was invisible in this layer's report.
  //
  // Every unplaced literal gets a named reason, and the reason decides
  // whether it is counted or refused -- they are not the same defect.
  // Measured on 29 corpus files, 747 of 5 284 literals reach no statement
  // (`tools/probes/probe_closure.mjs fate`):
  //
  //   648  claimedByAPatternThroughItsUser:class
  //    54  readByAValueWithNoStatement:DefineNamedOwnProperty
  //    45  readByAValueWithNoStatement:Call*
  //     0  everything else
  //
  // Both populated reasons are a gap this layer already declares somewhere
  // else, with its own hole, so counting them here is the honest answer and
  // refusing would delete correct output: the `class` row is §8.1's undecoded
  // `ClassBoilerplate` (the pattern owns the instruction and places no member
  // for it, `{e:'class'}` carries only the constructor), and the
  // `readByAValueWithNoStatement` rows are a literal whose only reader
  // transcribes to a hole -- `ownPropertyDefinitionNotFoldedIntoItsLiteral`
  // for the `Define*OwnProperty` row -- so the output already says "I don't
  // know" at that spot.
  //
  // Any other reason is an inconsistency in THIS layer's own analysis, not a
  // gap it declared, and it throws. `noLiveUse` is the one the drop site in
  // the statement pass used to produce silently; 5b repairs it, so reaching
  // here with it means the repair did not hold. Nothing in the sample reaches
  // these, which is the point: an assertion that costs nothing today and
  // fires the moment the analysis breaks, instead of a function quietly
  // leaving the output.
  for (const f of functionLiterals) {
    if (mentionedSfis.has(f.sfiId)) { emitStats.functionLiteralsInAStatement++; continue; }
    emitStats.functionLiteralsNotInAnyStatement++;
    const why = unplacedWhy(f);
    emitStats.byUnplacedFunctionLiteral[why] = (emitStats.byUnplacedFunctionLiteral[why] ?? 0) + 1;
    warn('functionLiteralNotInAnyStatement', {
      at: ir.instructions[f.at]?.offset ?? f.at, sfiId: f.sfiId, why,
    });
    if (!UNPLACED_LITERAL_DECLARED_GAPS.has(why.replace(/:.*$/, ''))) {
      throw new RecoverError(`a function literal reaches no statement: ${why}`, {
        sfiId: f.sfiId, at: ir.instructions[f.at]?.offset ?? f.at, unit: unit?.sfiId ?? null,
      });
    }
  }
  phase('functionLiteralAccounting');

  /** Why one function literal is in no statement. Named, never guessed. */
  function unplacedWhy(f) {
    const claimOf = (insIdx) => patterns.find((p) => p.instructions.includes(insIdx))?.kind ?? 'unknown';
    if (consumedIns.has(f.at)) return `claimedByAPattern:${claimOf(f.at)}`;
    if (f.vid === undefined || f.vid < 0) return 'instructionDefinesNoValue';
    const c = canon(f.vid);
    const live = usesOf(c).filter((u) => !dce.dead.has(u));
    if (!live.length) return materialisedNames.has(c) ? 'materialisedButItsStatementIsMissing' : 'noLiveUse';
    for (const u of live) {
      const uv = values[u];
      if (uv?.kind === 'Op' && consumedIns.has(uv.instruction)) {
        return `claimedByAPatternThroughItsUser:${claimOf(uv.instruction)}`;
      }
    }
    const uv = values[live[0]];
    return `readByAValueWithNoStatement:${uv?.op ?? uv?.kind ?? 'unknown'}`;
  }

  // ---------------------------------------------------------- 8. assemble
  //
  // `duplicable` is 11.3 invariant 4's right-hand side: the values whose
  // USE-SITE expression may legitimately appear more than once. Two disjoint
  // groups qualify, for the same underlying reason -- reading them costs
  // nothing and cannot produce a second object:
  //
  //   * the 4.3 class: a literal, a constant, an immutable context read, an
  //     identifier (inline.mjs::isDuplicable);
  //   * every value that was MATERIALISED, because `exprs` then holds
  //     `{e:'name'}` for it and the definition is emitted exactly once, at its
  //     definition point. This is 4.3's "物化成命名临时变量" -- the whole
  //     mechanism exists so that a call or an allocation with several uses is
  //     evaluated once and read by name afterwards.
  //
  // So "a value appears twice and is not duplicable" means a *defining
  // expression* was emitted twice, which is metrics 6 and 7. verify.mjs
  // measures exactly that.
  const duplicable = new Set([...plan.duplicable].filter((id) => !dce.dead.has(id)));
  for (const id of materialisedNames.keys()) duplicable.add(id);
  for (const { value, from } of restParams) {
    const rec = materialisedNames.get(canon(value));
    names.declarations.push({
      name: rec?.name ?? 'rest', kind: 'param', scope: 'function',
      origin: rec?.origin ?? 'synthetic', values: [value], rest: true, fromIndex: from,
    });
  }

  const recovered = {
    ir,
    names: {
      byValue: names.byValue,
      byContextSlot: names.byContextSlot,
      declarations: names.declarations,
      collisions: names.collisions,
      globals: names.globals,
    },
    exprs,
    duplicable,
    stmts,
    patterns,
    consumed: {
      blocks: consumedBlocks,
      edges: consumedEdges,
      instructions: consumedIns,
      handlerRanges: consumedHandlerRanges,
    },
    // additive, documented in docs/RECOVER.md: T9 needs to know which value a
    // name stands for to check invariant 11.3.4 mechanically.
    materialised: materialisedNames,
    altExprs: altExpr,
    alternatives: [...altExpr.keys()],
    tdzNames,
    warnings,
    stats: {
      values: values.length,
      dead: dce.stats.dead,
      live: dce.stats.live,
      movesDropped: dce.stats.movesDropped,
      inline: plan.stats,
      duplicable: duplicable.size,
      materialised: materialisedNames.size,
      patterns: patternStats,
      emit: emitStats,
      names: names.stats,
      consumedInstructions: consumedIns.size,
      consumedHandlerRanges: consumedHandlerRanges.size,
      blocks: ir.blocks.length,
      singleBlock: ir.dominators.rpo.length === 1,
      holes: emitStats.holesInExprs + emitStats.holesInStmts,
      phases,
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
    },
  };

  if (opts.verify !== false) {
    recovered.verification = verifyRecovered(recovered, { strict: !!opts.strict, exprMemo });
    recovered.stats.violations = recovered.verification.violations.length;
    phase('verify');
  }
  recovered.stats.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  // `opts.debug` only: the decision tables behind the plan, so a duplication
  // report can be traced to the use count that allowed it without a rebuild.
  // Off by default because it holds a Map per function and the corpus scan
  // runs 240 000 of them.
  if (opts.debug) {
    recovered.debug = {
      plan, dce, canon, usesOf, occurrencesOf, occurrencesIn, refsOf, rewriteRefs,
      canonicalInputs: canonicalInputsOf, isConsumedUser, exprOverride, stmtOverride,
    };
  }
  return recovered;
}

/** Recover every unit of a module, collecting per-unit failures. */
export function recoverAll(irs, opts = {}) {
  const results = [];
  const failures = [];
  for (const ir of irs) {
    try { results.push(recover(ir, opts)); }
    catch (e) {
      failures.push({
        unit: ir?.unit?.bytecodeId ?? ir?.unit?.sfiId ?? null,
        name: ir?.unit?.name ?? null, error: e.message, stack: e.stack,
      });
    }
  }
  return { results, failures };
}

export { sanitiseIdentifier };
export default { recover, recoverAll, RecoverError, EXPR_TAGS };
