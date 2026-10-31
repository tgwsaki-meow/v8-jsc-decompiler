// src/emit/scopes.mjs
//
// WHERE A CLOSURE VARIABLE IS DECLARED.
//
// A context slot is not "a name". It is STORAGE belonging to a particular
// scope, shared by every function nested inside that scope. Treating it as a
// name is what broke closures: `names.mjs` declared the slot's spelling
// locally in whichever function mentioned it, so an inner function read its
// own fresh `undefined` binding instead of the captured variable. Measured on
// `r_commonKitComponentXkitXDialog.jsc` (docs/O1.md 6.5): the original has
// 4 CreateFunctionContext, 10 PushContext, 64 StaCurrentContextSlotNoCell and
// 299 immutable slot loads; our output had ZERO context operations and 594
// LdaUndefined against the original's 38.
//
// The rule this module implements, and the whole of it:
//
//   A context slot is declared EXACTLY ONCE, in the emitted function that owns
//   the context frame it lives in, and every other function that reads or
//   writes it resolves to that one binding through lexical scope.
//
// WHY THE OLD RULE MISSED IT, which is the part worth writing down.
//
// `names.mjs` rule 3 asked `depth > 0`, where `depth` is the bytecode
// operand. That is the wrong question. The operand counts PREVIOUS_INDEX hops
// from whatever the frame's context register holds, and a function that
// allocates no context of its own never pushes one -- so for such a function
// `LdaImmutableCurrentContextSlot [8]` at depth **0** is already a read of the
// ENCLOSING function's variable (ARCHITECTURE.md 10.3 states exactly this, and
// src/ir/context.mjs measured it on a real listing). The ordinary capture is
// therefore depth 0, rule 3 never fired for it, and `outerSlotDeclaredLocally`
// counted only the rare deep reads. Measured over 61 corpus files, 8 882
// units and 27 891 slot references: 13 556 `incoming` + 2 592 `outerScope`
// references belong to an enclosing function, against 11 249 the referencing
// function really owns. Rule 3's own counter saw 367 over 465 files.
//
// THE QUESTION THAT IS ACTUALLY ASKED: does THIS function's prologue create
// the frame?
//
// `ir.contextChain.frames` gives every frame a kind (src/ir/context.mjs):
//
//   created      this function built it -- Create{Function,Block,Catch,Eval,
//                With,FunctionWithCells}Context -- so this function OWNS it
//   incoming     the context the closure was entered with, `unit.scope.outer`
//   outerScope   one or more PREVIOUS_INDEX hops above that
//
// `incoming` and `outerScope` are frames of an ENCLOSING scope by
// construction, so their owner is another function: the one whose `created`
// frame carries the same `scopeInfoId`. A ScopeInfo is a heap object, and
// `src/heap` gives it one id per cache graph, so that id is the file-wide
// identity of the frame -- the same number on the creating side (a
// constant-pool operand of the Create*Context) and on the reading side
// (`unit.scope.outer.scopeInfoId`). Measured: 16 148 of 16 148 enclosing-frame
// references resolve to an emitted ancestor this way, and 0 of 1 805 created
// frames lacked a scopeInfoId.
//
// REFUSAL, NOT A GUESS.
//
// The owner's standing instruction for this project: compiler engineering is
// deterministic, every heuristic implementation is to be removed, and an error
// must be thrown explicitly rather than papered over. So this module does not
// fall back to a local declaration when it cannot place a binding. It refuses
// the function, per function, with the slot, the frame, the depth and the
// reason named -- see SCOPE_REFUSAL_WHY. Measured cost on the same 61 files:
// 494 of 27 891 references (1.77%) and 51 of 8 882 functions (0.57%), all of
// them T7's frameless `ctx[d][i]` placeholder, where no single context object
// reaches the instruction and there is therefore no storage location to place.
//
// NAMES.
//
// A binding's spelling is allocated ONCE, by its owner, and read by every
// other function from this table. It has to be: T7 names every slot
// per-function off its own `taken` set, so two functions can spell one slot
// differently -- measured, 9 bindings over the 61 files -- and a closure that
// resolves `x` in one function and `x$2` in another is not a closure. The
// allocation avoids, file-wide, every parameter name, every global any
// function reads, every emitted function name and this layer's own internal
// names, and on the current path every binding an ancestor already declared.
// None of that is visible to O1: a context slot is an index in the bytecode,
// so renaming a binding cannot change one instruction.

import { sanitise } from './names.mjs';

/** Two functions created a context with the same ScopeInfo. */
const AMBIGUOUS = Symbol('ambiguousFrameOwner');

/** How deep a parent chain is followed before it is called a cycle. */
const MAX_TREE_DEPTH = 64;

/** This layer's own identifiers, which a binding must not be spelled as. */
const EMIT_INTERNAL = /^(__hole|__super|__t\$\d+|__pc\d+|__region\d+|e\$\d+)$/;

/**
 * Why a function is refused. Each one is "I cannot place this binding", with
 * the specific thing that is missing.
 */
export const SCOPE_REFUSAL_WHY = Object.freeze({
  contextFrameNotStaticallyKnown:
    'T7 produced the `ctx[d][i]` placeholder: the context register holds different '
    + 'context objects on different paths into the instruction (docs/IR.md 11), so there '
    + 'is no single frame and therefore no storage location to declare',
  contextSlotLocalIndexUnknown:
    'the frame is known but ScopeInfo::ContextHeaderLength could not be applied to the '
    + 'slot operand, so the slot has no local index and cannot be identified across functions',
  contextFrameHasNoScopeInfoId:
    'the slot lives in an enclosing frame whose ScopeInfo has no object id, so the frame '
    + 'has no file-wide identity and the function that created it cannot be found',
  contextFrameHasNoCreatorInThisFile:
    'no function in this file has a Create*Context for that ScopeInfo: the context was '
    + 'built outside this file, or the function that builds it was not recovered',
  contextFrameOwnerAmbiguous:
    'two functions in this file create a context with the same ScopeInfo, so which one '
    + 'owns the binding is not determined',
  contextFrameOwnerIsNotAnAncestor:
    'the function that creates the frame is not an ancestor of this one in the emitted '
    + 'nesting, so its declaration is not in this function\'s lexical scope',
  contextSlotWithoutABinding:
    'an emitted `{e:name}` names a context slot that is not in `ir.contextSlotValues`, '
    + 'so this layer has no binding for it',
});

/**
 * One context-slot binding: storage shared by the owner and its descendants.
 *
 * @typedef {object} Binding
 * @property {string} key          file-wide identity, `s<scopeInfoId>:<localIndex>`
 * @property {number|null} scopeInfoId
 * @property {number} localIndex
 * @property {number} ownerSfiId   the function whose prologue creates the frame
 * @property {string} name         the one spelling every function uses
 * @property {string|null} rawName the ScopeInfo name, when there is one
 * @property {string} declKind     `var` / `let` / `const`, from T7's slotKind
 * @property {string|null} comment the 4.5 marker, when the name is unknown
 */

/**
 * Plan every context-slot binding of one file.
 *
 * @param {object} args
 * @param {object[]} args.order        the unit records, in emit order
 * @param {Map<number, object[]>} args.childrenOf
 * @param {object[]} args.roots
 * @param {Iterable<string>} args.reserved  names a binding must not take
 * @returns {object} the file-wide scope plan
 */
export function planScopes({ order, childrenOf, roots, reserved = [] }) {
  const stats = {
    createdFrames: 0,
    createdFramesWithoutAScopeInfoId: 0,
    frameOwnerConflicts: 0,
    bindings: 0,
    bindingsNamedFromScopeInfo: 0,
    bindingsWithoutAName: 0,
    bindingsRenamedForACollision: 0,
    slotLocations: 0,
    slotLocationsOwnedHere: 0,
    slotLocationsOwnedByAnAncestor: 0,
    slotLocationsUnplaceable: 0,
    unitsRefused: 0,
    refusalsByWhy: {},
  };

  // ------------------------------------------------------------- the tree
  const parentOf = new Map();
  for (const [sfiId, kids] of childrenOf) for (const k of kids) parentOf.set(k.sfiId, sfiId);
  const isAncestorOf = (maybe, of) => {
    let p = parentOf.get(of);
    for (let n = 0; p !== undefined && n < MAX_TREE_DEPTH; n++) {
      if (p === maybe) return true;
      p = parentOf.get(p);
    }
    return false;
  };

  // ------------------------------------------------------ 1. who owns what
  //
  // A frame belongs to the function whose prologue created it. That is the
  // only statement of ownership in the input, and it is a fact rather than an
  // inference: `kind: 'created'` is set in src/ir/context.mjs for exactly the
  // Create*Context instructions of this function's own bytecode.
  const ownerOfScopeInfo = new Map();
  for (const r of order) {
    for (const f of r.rec?.ir?.contextChain?.frames ?? []) {
      if (f.kind !== 'created') continue;
      stats.createdFrames++;
      if (!Number.isInteger(f.scopeInfoId)) { stats.createdFramesWithoutAScopeInfoId++; continue; }
      const prev = ownerOfScopeInfo.get(f.scopeInfoId);
      if (prev === undefined) ownerOfScopeInfo.set(f.scopeInfoId, r.sfiId);
      else if (prev !== r.sfiId) {
        ownerOfScopeInfo.set(f.scopeInfoId, AMBIGUOUS);
        stats.frameOwnerConflicts++;
      }
    }
  }

  // --------------------------------------- 2. every slot location, classified
  const bindings = new Map();                 // key -> Binding
  const perUnit = new Map();                  // sfiId -> unit plan
  for (const r of order) {
    perUnit.set(r.sfiId, {
      sfiId: r.sfiId, owns: [], ownNames: new Set(),
      slotName: new Map(), slotBinding: new Map(), unplaceable: [],
      inheritedCount: 0,
    });
  }

  const refuse = (plan, why, detail) => {
    plan.unplaceable.push({ why, detail });
    stats.slotLocationsUnplaceable++;
    stats.refusalsByWhy[why] = (stats.refusalsByWhy[why] ?? 0) + 1;
  };

  for (const r of order) {
    const plan = perUnit.get(r.sfiId);
    const rec = r.rec;
    if (!rec) continue;

    // T7's frameless placeholders (docs/RECOVER.md 4.2). One per (depth,
    // index) pair, allocated when `v.contextSlot.slotValue` is null because no
    // single context object reaches the instruction. There is no location, so
    // there is nothing to place.
    for (const [, ph] of rec.names.placeholders ?? []) {
      refuse(plan, 'contextFrameNotStaticallyKnown',
        `${ph.comment ?? 'ctx[?][?]'}${ph.why ? ` (${ph.why})` : ''}`);
    }

    const frames = rec.ir.contextChain?.frames ?? [];
    const slotIds = [...(rec.ir.contextSlotValues?.values() ?? [])].sort((a, b) => a - b);
    for (const id of slotIds) {
      const loc = rec.ir.values[id];
      if (!loc || loc.kind !== 'ContextSlot') continue;
      stats.slotLocations++;
      const frame = frames[loc.frame];
      const where = `slot ${loc.slot} (local ${loc.localIndex}) frame ${loc.frame}`
        + `${frame ? `/${frame.kind}` : ''} depth ${loc.depthFromUse}`;
      if (!frame) { refuse(plan, 'contextFrameHasNoScopeInfoId', where); continue; }
      if (!Number.isInteger(loc.localIndex)) {
        refuse(plan, 'contextSlotLocalIndexUnknown', `${where}: ${loc.why ?? 'no reason given'}`);
        continue;
      }

      let ownerSfiId;
      if (frame.kind === 'created') {
        ownerSfiId = r.sfiId;
        stats.slotLocationsOwnedHere++;
      } else {
        if (!Number.isInteger(frame.scopeInfoId)) {
          refuse(plan, 'contextFrameHasNoScopeInfoId', where);
          continue;
        }
        const owner = ownerOfScopeInfo.get(frame.scopeInfoId);
        if (owner === undefined) {
          refuse(plan, 'contextFrameHasNoCreatorInThisFile',
            `${where} scopeInfo #${frame.scopeInfoId} ${loc.scopeType ?? ''}`);
          continue;
        }
        if (owner === AMBIGUOUS) {
          refuse(plan, 'contextFrameOwnerAmbiguous', `${where} scopeInfo #${frame.scopeInfoId}`);
          continue;
        }
        if (owner !== r.sfiId && !isAncestorOf(owner, r.sfiId)) {
          refuse(plan, 'contextFrameOwnerIsNotAnAncestor', `${where} owner sfi ${owner}`);
          continue;
        }
        ownerSfiId = owner;
        if (owner === r.sfiId) stats.slotLocationsOwnedHere++;
        else { stats.slotLocationsOwnedByAnAncestor++; plan.inheritedCount++; }
      }

      const key = Number.isInteger(frame.scopeInfoId)
        ? `s${frame.scopeInfoId}:${loc.localIndex}`
        : `u${r.sfiId}f${loc.frame}:${loc.localIndex}`;
      let b = bindings.get(key);
      if (b === undefined) {
        b = {
          key, scopeInfoId: Number.isInteger(frame.scopeInfoId) ? frame.scopeInfoId : null,
          localIndex: loc.localIndex, slot: loc.slot, ownerSfiId,
          name: null, rawName: loc.resolved && loc.name ? loc.name : null,
          declKind: declarationKind(loc), comment: null,
          scopeType: loc.scopeType ?? null, frameKind: frame.kind,
          readers: new Set(),
        };
        bindings.set(key, b);
        stats.bindings++;
        if (b.rawName) stats.bindingsNamedFromScopeInfo++; else stats.bindingsWithoutAName++;
        const ownerPlan = perUnit.get(ownerSfiId);
        if (ownerPlan) ownerPlan.owns.push(b);
      } else if (!b.rawName && loc.resolved && loc.name) {
        // One side of the chain decoded the ScopeInfo and another did not. The
        // name is a property of the scope, so take it wherever it is found.
        b.rawName = loc.name;
        stats.bindingsNamedFromScopeInfo++;
        stats.bindingsWithoutAName--;
      }
      b.readers.add(r.sfiId);
      plan.slotBinding.set(id, b);
    }
  }

  // ------------------------------------------------------- 3. the spellings
  //
  // Allocated by the owner, top-down over the nesting, so a binding never
  // takes a name an enclosing function already bound.
  const reservedNames = new Set();
  for (const n of reserved) if (n) reservedNames.add(sanitise(n));

  const visible = new Set();            // binding names bound on the current path
  const allocate = (b) => {
    const base = b.rawName
      ? sanitise(b.rawName)
      : sanitise(`__ctx_i${b.localIndex}`);
    let candidate = base;
    let n = 2;
    while (visible.has(candidate) || reservedNames.has(candidate) || EMIT_INTERNAL.test(candidate)) {
      candidate = `${base}$s${n++}`;
      stats.bindingsRenamedForACollision++;
    }
    b.name = candidate;
    if (!b.rawName) {
      // ARCHITECTURE.md 4.5 requires the `ctx[d][i]` marker plus a declared
      // placeholder when a slot's NAME cannot be recovered. The frame is known
      // here -- only the name is missing -- so the binding is real and shared;
      // the marker says which slot it is.
      b.comment = `ctx[*][${b.slot}] name not in the ScopeInfo`
        + `${b.scopeType ? ` (${b.scopeType})` : ''}`;
    }
    return candidate;
  };

  const byKey = (a, c) => (a.localIndex - c.localIndex) || (a.slot - c.slot) || (a.key < c.key ? -1 : 1);
  const visited = new Set();
  const descend = (r, depth) => {
    if (depth > MAX_TREE_DEPTH || visited.has(r.sfiId)) return;
    visited.add(r.sfiId);
    const plan = perUnit.get(r.sfiId);
    const mine = [];
    if (plan) {
      plan.owns.sort(byKey);
      for (const b of plan.owns) {
        // added to `visible` as it is allocated, so two bindings of the same
        // owner -- a function context and a block context both holding `x` --
        // cannot both be spelled `x` in one declaration list
        const n = allocate(b);
        plan.ownNames.add(n);
        visible.add(n);
        mine.push(n);
      }
    }
    for (const c of childrenOf.get(r.sfiId) ?? []) descend(c, depth + 1);
    for (const n of mine) visible.delete(n);
  };
  const orderedRoots = [...roots].sort((a, b) => (Number(!!b.unit.isTopLevel) - Number(!!a.unit.isTopLevel))
    || ((a.unit.startPosition ?? 0) - (b.unit.startPosition ?? 0)) || (a.sfiId - b.sfiId));
  for (const r of orderedRoots) descend(r, 0);
  // A unit the tree never reached (a broken parent link; index.mjs emits it at
  // the top level with an ORPHAN marker) still has to have its own bindings
  // spelled, or its prologue would carry `null`.
  for (const r of order) {
    const plan = perUnit.get(r.sfiId);
    if (!plan || visited.has(r.sfiId)) continue;
    plan.owns.sort(byKey);
    for (const b of plan.owns) {
      if (b.name !== null) continue;
      const n = allocate(b);
      plan.ownNames.add(n);
    }
  }

  // ------------------------------------- 4. the per-unit view emit consumes
  for (const [, plan] of perUnit) {
    for (const [slotId, b] of plan.slotBinding) plan.slotName.set(slotId, b.name);
    if (plan.unplaceable.length) stats.unitsRefused++;
  }

  const inheritedNamesFor = (sfiId) => {
    const out = new Set();
    let p = parentOf.get(sfiId);
    for (let n = 0; p !== undefined && n < MAX_TREE_DEPTH; n++) {
      for (const name of perUnit.get(p)?.ownNames ?? []) out.add(name);
      p = parentOf.get(p);
    }
    return out;
  };

  return {
    bindings, stats, ownerOfScopeInfo, parentOf,
    /** Everything one function needs: what it declares and how it spells slots. */
    forUnit(sfiId) {
      const plan = perUnit.get(sfiId);
      if (!plan) return emptyUnitScope();
      const inherited = inheritedNamesFor(sfiId);
      const visibleNames = new Set(inherited);
      for (const n of plan.ownNames) visibleNames.add(n);
      return {
        sfiId, owns: plan.owns, ownNames: plan.ownNames,
        inheritedNames: inherited, visibleNames,
        slotName: plan.slotName, slotBinding: plan.slotBinding,
        unplaceable: plan.unplaceable,
        inheritedCount: plan.inheritedCount,
      };
    },
  };
}

/** A unit with no scope plan at all: emit() can still run over it. */
export function emptyUnitScope() {
  return {
    sfiId: null, owns: [], ownNames: new Set(),
    inheritedNames: new Set(), visibleNames: new Set(),
    slotName: new Map(), slotBinding: new Map(), unplaceable: [], inheritedCount: 0,
  };
}

/**
 * The declaration keyword for a binding, read off the ScopeInfo rather than
 * chosen.
 *
 * `src/recover/names.mjs::slotKind` already maps `VariableMode` to a keyword;
 * the ContextSlot value carries the mode. Honouring it matters because a
 * context-allocated `let` needs initialisation and a `var` does not: V8 emits
 * `LdaTheHole; StaCurrentContextSlot` at scope entry plus `LdaUndefined;
 * StaCurrentContextSlot` for the declaration of `let x;`, and nothing at all
 * for `var x;`. Rule 1 declares with no initialiser and assigns separately, so
 * `const` is not expressible -- `const x;` is a SyntaxError -- and a const
 * slot is emitted as `let` and counted, because that is a real residual
 * (V8 then reads it with `LdaCurrentContextSlot`, not the immutable form)
 * rather than something to hide.
 */
function declarationKind(loc) {
  switch (loc.mode) {
    case 'kVar': case 'kDynamic': case 'kDynamicGlobal': case 'kDynamicLocal': return 'var';
    case 'kConst': return 'const';
    default: return 'let';
  }
}

export default { planScopes, emptyUnitScope, SCOPE_REFUSAL_WHY };
