// src/emit/declsite.mjs
//
// WHERE A CONTEXT BINDING IS DECLARED, PART TWO: at its store, with an
// initialiser, when that is provable.
//
// scopes.mjs decides WHICH function declares a binding. This file decides
// WHERE in that function, and it exists for one measured reason. names.mjs
// rule 1 declares every binding with NO initialiser and assigns at the store
// site separately, so the text is
//
//     let x;            // the prologue
//     ...
//     x = <value>;      // the store
//
// and V8's parser sees an assignment that is not a declaration's initialiser.
// `AstNodeFactory::NewAssignment` marks the target `is_assigned` for every op
// except `Token::kInit`, ScopeInfo carries that bit as `maybe_assigned_flag`,
// and `BytecodeGenerator::BuildVariableLoad`
// (src/interpreter/bytecode-generator.cc:4756 @ 14.4.258.16) reads it back:
//
//     BytecodeArrayBuilder::ContextSlotMutability immutable =
//         (variable->maybe_assigned() == kNotAssigned)
//             ? BytecodeArrayBuilder::kImmutableSlot
//             : BytecodeArrayBuilder::kMutableSlot;
//
// So the two-statement shape forces the MUTABLE opcode at every read of every
// binding we emit, and `const x;` is not expressible at all -- a `kConst`
// binding came out as `let` (`constBindingsEmittedAsLet`, 4 641 of them).
// docs/O1.md 6.8 measured the consequence after the rule-3 fix landed: family
// `load-form` 132 -> 12 383 functions, carrying the single largest shape in
// the whole comparison, `LdaImmutableCurrentContextSlot ->
// LdaCurrentContextSlotNoCell`, 8 983 functions / 11 633 hunks.
//
// The fix is to emit the store AS the declaration, `const x = <value>` /
// `let x = <value>`, so that the only assignment in the text is a
// `Token::kInit` one and `maybe_assigned()` comes back `kNotAssigned`. The
// rest of this file is the proof obligation that comes with it, because
// moving a declaration later in a function can (a) make a name invisible --
// `let`/`const` are block-scoped -- (b) turn a read of `undefined` into a TDZ
// `ReferenceError`, and (c) claim single assignment for a binding the original
// does NOT consider singly assigned, which would replace one diff with its
// mirror image.
//
// ---------------------------------------------------------------------------
// THE CONDITION, AS SEVEN CLAUSES OVER THE IR
//
// Each clause is checked against the IR, each failure is NAMED, and a binding
// that fails any of them keeps today's prologue shape and is counted under
// the clause that refused it (DECL_SITE_WHY). Nothing is guessed: there is no
// path through this file that declares at a store site "probably".
//
//  1. THE ORIGINAL SAYS SO. Every ContextSlot location of the binding carries
//     `maybeAssigned`, read out of the ScopeInfo's own
//     `maybe_assigned_flag` (src/heap/objects.mjs, VariableProperties), and
//     every one of them must say `false`. This clause is not a nicety: it is
//     the only thing that distinguishes `const x = f()` -- which the original
//     reads immutably -- from `let x; ... x = f()`, which the original reads
//     MUTABLY and which we already emit correctly. Measured (see
//     docs/EMIT.md 9.11): clauses 2-7 alone admit bindings whose ScopeInfo
//     says `kMaybeAssigned`, and declaring those at their store would emit
//     the immutable opcode where the original emits the mutable one, i.e.
//     move the diff rather than close it.
//
//  2. ONE PROGRAM STORE. The binding's stores, over EVERY function in the
//     file, are either V8's own TDZ initialisation or exactly one program
//     store. The TDZ store is not an assignment: `VisitVariableDeclaration`
//     (bytecode-generator.cc:2158) emits `LoadTheHole().StoreContextSlot(...)`
//     for a lexical binding that `binding_needs_init()`, and T7 already
//     recognises that pair -- `src/recover/patterns/misc.mjs` turns it into
//     `{s:'decl', tdzInitialisation:true}` with no initialiser. Every other
//     store counts. Two program stores means `maybe_assigned` would be true
//     in our text as well, so there is nothing to gain; zero means there is
//     no site to declare at (a catch context's slot, which is written by
//     `CreateCatchContext` itself -- docs/EMIT.md 9.6).
//
//  3. THE STORE IS IN THE OWNER. A nested function's `StaContextSlot` on an
//     inherited frame is an assignment to the owner's binding from another
//     closure scope, so the declaration cannot move there: the owner's
//     prologue is where the binding has to exist. Clause 2 already rejects
//     "the owner stores and a descendant also stores"; this clause rejects
//     "the only store is in a descendant".
//
//  4. THE STORE DOMINATES EVERY READ IN THE OWNER. `ir.dominators` is the
//     Cooper-Harvey-Kennedy dominator tree (src/ir/dominators.mjs) and
//     `dominates(storeBlock, readBlock)` is an O(1) Euler-interval query on
//     it. A read in the store's own block must come after the store's own
//     instruction. Reads in DESCENDANT functions need no dominance: a closure
//     body does not run at the point the closure is created, and the
//     original's answer for those reads is the TDZ check V8 emits for a
//     cross-closure read of a binding that needs initialisation -- which our
//     text reproduces, because it is the same shape.
//
//  5. THE STORE IS NOT IN A LOOP. `ir.blocks[b].loopDepth` is src/ir/loops.mjs's
//     own number. A `let`/`const` declaration inside a loop body is a FRESH
//     binding per iteration, which V8 implements with a per-iteration block
//     context -- a different program and a much bigger diff than the one
//     being fixed.
//
//  6. THE STORE DOES NOT READ THE BINDING. `const x = x + 1` is a TDZ error,
//     and a compound assignment (`x += 1`) lowers to exactly that shape.
//
//  7. THE STORE IS AN OUTERMOST STATEMENT. Dominance is necessary and NOT
//     sufficient: `let`/`const` are block-scoped, so a declaration inside an
//     `if` is invisible after the `if` even though the `if`'s block dominates
//     what follows. The emitted statement therefore has to sit in the
//     function body's own statement list, which is the one lexical block that
//     encloses every read -- including every read in a descendant function,
//     because index.mjs emits descendants nested INSIDE that list. The region
//     tree answers this before emission: the store's block must be a
//     `{r:'block'}` leaf reachable from `sf.root` through `{r:'seq'}` nodes
//     only. index.mjs then VERIFIES it on the emitted array by identity
//     (`body.indexOf(node)`) and reverts the statement if the model was
//     wrong, so the placement is checked rather than assumed.
//
// Clause 7's region-tree pre-filter and index.mjs's post-check answer the
// same question twice on purpose: the pre-filter attributes the residue (the
// store is inside an `if`, a `try`, a `switch`), and the post-check is the
// proof. `declarationSitesRevertedAfterEmission` is how often they disagree,
// and it is expected to read zero.

/** Why a binding keeps the prologue shape. One reason per clause. */
export const DECL_SITE_WHY = Object.freeze({
  scopeInfoSaysMaybeAssigned:
    'the ScopeInfo\'s own maybe_assigned_flag is kMaybeAssigned, so the original reads this '
    + 'binding with the MUTABLE opcode (BytecodeGenerator::BuildVariableLoad); declaring at '
    + 'the store would emit the immutable one and replace the diff with its mirror image',
  scopeInfoHasNoMaybeAssignedFlag:
    'no ContextSlot location of this binding carries a maybe_assigned flag -- the ScopeInfo\'s '
    + 'VariableProperties were not decoded -- so the original\'s own answer is unknown',
  noProgramStore:
    'the binding has no store that is not V8\'s TDZ initialisation, so there is no site to '
    + 'declare at (a catch context\'s slot is written by CreateCatchContext itself)',
  moreThanOneProgramStore:
    'the binding is stored more than once, so our text would be maybe_assigned as well and '
    + 'the immutable opcode would not come back',
  theOnlyStoreIsInADescendant:
    'the only store is in a function nested inside the owner, so the declaration cannot move '
    + 'to it: the binding has to exist in the owner for the descendant to assign it',
  storeHasNoAssignmentStatement:
    'T7 produced no `<slot> = <value>` statement for the store op -- an idiom consumed it '
    + '(an update, a destructuring target, a for-in key) -- so there is no statement to turn '
    + 'into a declaration',
  storeDoesNotDominateEveryReadInTheOwner:
    'a read in the owning function is not dominated by the store, so a declaration at the '
    + 'store would turn that read from `undefined` into a TDZ ReferenceError',
  storeIsInsideALoop:
    'the store is inside a loop, where a `let`/`const` declaration is a fresh binding per '
    + 'iteration and V8 allocates a per-iteration context',
  theStoreReadsTheBindingItStores:
    'the stored value reads the binding, so `const x = <value>` would be a TDZ self-reference '
    + '(this is what a compound assignment lowers to)',
  storeIsNotInAnOutermostBlock:
    'the store\'s block is not a `{r:block}` leaf of the body\'s own `{r:seq}` chain, so the '
    + 'declaration would sit inside an `if`/`try`/`switch`/loop body and `let`/`const` would '
    + 'not be visible to the reads after it',
  storeBlockIsNotPlaced:
    'the store\'s block is not placed in T8\'s region tree (a `removed` loop-test block, an '
    + 'unreachable block), so there is no emitted statement position for it',
  ownerWasNotEmitted:
    'the owning function has no recovered/structured pair, so its body -- and the store -- '
    + 'is not emitted at all',
});

/** The region keys region.mjs recurses through, so a leaf is never missed. */
const REGION_CHILD_KEYS = ['body', 'then', 'else', 'block', 'handler', 'finalizer', 'update', 'init'];

/**
 * Where every block of one function is emitted, as the two facts clause 7
 * needs: which outermost statement position it belongs to, and whether it IS
 * that position rather than something nested inside it.
 *
 * `{r:'seq'}` emits its children one after another into the enclosing
 * statement list (region.mjs::regionStatements), so a `{r:'block'}` reached
 * through `seq` nodes only is an outermost statement of the body. Every other
 * region kind opens a lexical block -- an `if` branch, a loop body, a `try`
 * block, a `catch`, a `switch` case, a labelled block -- and everything inside
 * it belongs to that one outermost position.
 *
 * @returns {Map<number, {slot: number, outermost: boolean}>}
 */
export function blockPositions(sf) {
  const pos = new Map();
  let slot = 0;
  const inner = (r, at) => {
    if (!r || typeof r !== 'object') return;
    if (Array.isArray(r)) { for (const x of r) inner(x, at); return; }
    if (r.r === 'block') {
      if (!pos.has(r.id)) pos.set(r.id, { slot: at, outermost: false });
      return;
    }
    if (r.r === 'unstructured') {
      for (const b of r.blocks ?? []) if (!pos.has(b)) pos.set(b, { slot: at, outermost: false });
      return;
    }
    for (const k of REGION_CHILD_KEYS) inner(r[k], at);
    for (const c of r.cases ?? []) inner(c.body, at);
  };
  const outermost = (r) => {
    if (!r) return;
    if (r.r === 'seq') { for (const x of r.body ?? []) outermost(x); return; }
    const at = slot++;
    if (r.r === 'block') { pos.set(r.id, { slot: at, outermost: true }); return; }
    inner(r, at);
  };
  outermost(sf?.root);
  return pos;
}

/**
 * T7's statements of one function, indexed by the SSA value each one was
 * produced FOR.
 *
 * `src/recover/index.mjs` pushes every statement with `values: [vid]`, where
 * `vid` is the instruction's own SSA value -- the same id `src/ir/index.mjs`
 * puts in `ContextSlot.stores`. Only `values[0]` is indexed: a phi copy
 * carries `[phi, operand]`, and the operand is somebody else's value.
 */
function statementsByValue(rec) {
  const out = new Map();
  for (const [bid, list] of rec.stmts) {
    for (const s of list) {
      const v = s.values?.[0];
      if (v === null || v === undefined) continue;
      if (!out.has(v)) out.set(v, { block: bid, stmt: s });
    }
  }
  return out;
}

/** Is this statement `<the slot of this binding> = <value>`? */
function assignsSlot(stmt, slotId) {
  if (!stmt || stmt.s !== 'expr') return false;
  const e = stmt.expr;
  if (!e || e.e !== 'assign' || (e.op ?? '=') !== '=') return false;
  const t0 = e.target;
  return !!t0 && t0.e === 'name' && t0.ref?.k === 'contextSlot' && t0.ref.slotValue === slotId;
}

/** Does this expression read the binding whose location is `slotId`? */
function readsSlot(e, slotId, depth = 0) {
  if (!e || typeof e !== 'object' || depth > 64) return false;
  if (Array.isArray(e)) return e.some((x) => readsSlot(x, slotId, depth + 1));
  if (e.e === 'name' && e.ref?.k === 'contextSlot' && e.ref.slotValue === slotId) return true;
  for (const k in e) {
    if (k === 'pos' || k === 'values' || k === 'ref' || k === 'dump') continue;
    const v = e[k];
    if (v && typeof v === 'object' && readsSlot(v, slotId, depth + 1)) return true;
  }
  return false;
}

/**
 * The accumulator input of a store op, which is the value being stored.
 *
 * `src/ir/index.mjs` documents the order: "inputs are in read order: the
 * accumulator first when read, then the operands". A `Sta*ContextSlot` reads
 * the accumulator, so input 0 is the stored value.
 */
function storedValue(ir, opId) {
  const v = ir.values[opId];
  if (!v || v.kind !== 'Op') return null;
  if (!v.sem?.accumulator?.read) return null;
  const id = v.inputs?.[0];
  return id === null || id === undefined ? null : (ir.values[id] ?? null);
}

/**
 * Plan the declaration site of every context binding of one file.
 *
 * @param {object} args
 * @param {object[]} args.order   the unit records, in emit order
 * @param {object} args.scopes    the scopes.mjs plan
 * @returns {object} the file-wide declaration-site plan
 */
export function planDeclarationSites({ order, scopes }) {
  const stats = {
    bindings: 0, atStore: 0, refused: 0, byWhy: {},
    atStoreByDeclKind: { const: 0, let: 0, var: 0 },
    refusedForMaybeAssignedOnly: 0,
  };

  // ---------------------------------------------------- 1. gather the facts
  //
  // One row per binding, over EVERY function that touches it: clause 2 is a
  // statement about the whole file, not about one body.
  const rows = new Map();                 // Binding -> row
  const rowOf = (b) => {
    let row = rows.get(b);
    if (row === undefined) {
      row = {
        binding: b, maybeAssigned: new Set(), locations: 0,
        programStores: [], holeInits: 0, unknownStores: 0,
        readsInOwner: [], readsElsewhere: 0, ownerSeen: false,
      };
      rows.set(b, row);
      stats.bindings++;
    }
    return row;
  };

  const unitOf = new Map();               // sfiId -> { rec, sf, byValue, positions }
  for (const r of order) {
    if (!r.rec || !r.sf) continue;
    unitOf.set(r.sfiId, {
      rec: r.rec, sf: r.sf, isTopLevel: !!r.unit?.isTopLevel,
      byValue: statementsByValue(r.rec),
      positions: blockPositions(r.sf),
    });
  }

  for (const r of order) {
    const u = unitOf.get(r.sfiId);
    if (!u) continue;
    const sc = scopes.forUnit(r.sfiId);
    if (!sc.slotBinding.size) continue;
    const ir = u.rec.ir;
    for (const [slotId, b] of sc.slotBinding) {
      const loc = ir.values[slotId];
      if (!loc || loc.kind !== 'ContextSlot') continue;
      const row = rowOf(b);
      const isOwner = b.ownerSfiId === r.sfiId;
      if (isOwner) row.ownerSeen = true;
      row.locations++;
      row.maybeAssigned.add(loc.maybeAssigned === null || loc.maybeAssigned === undefined
        ? null : !!loc.maybeAssigned);

      for (const opId of loc.stores ?? []) {
        const at = u.byValue.get(opId);
        const src = storedValue(ir, opId);
        const isHole = src?.kind === 'Op' && src.op === 'LdaTheHole';
        const isTdzDecl = at?.stmt?.s === 'decl' && at.stmt.tdzInitialisation === true;
        if (isHole || isTdzDecl) { row.holeInits++; continue; }
        if (at && assignsSlot(at.stmt, slotId)) {
          row.programStores.push({
            sfiId: r.sfiId, isOwner, slotId, opId, stmt: at.stmt, block: at.block,
            instruction: ir.values[opId]?.instruction ?? null,
          });
          continue;
        }
        row.unknownStores++;
        row.programStores.push({
          sfiId: r.sfiId, isOwner, slotId, opId, stmt: null,
          block: ir.values[opId]?.block ?? null,
          instruction: ir.values[opId]?.instruction ?? null,
        });
      }

      for (const opId of loc.loads ?? []) {
        const v = ir.values[opId];
        if (!v) continue;
        if (isOwner) row.readsInOwner.push({ block: v.block, instruction: v.instruction });
        else row.readsElsewhere++;
      }
    }
  }

  // ------------------------------------------------------ 2. decide, clause
  //                                                           by clause
  const sites = new Map();                // Binding -> site
  const refuse = (row, why) => {
    stats.refused++;
    stats.byWhy[why] = (stats.byWhy[why] ?? 0) + 1;
    row.why = why;
    return null;
  };

  for (const [b, row] of rows) {
    const program = row.programStores;
    // Clause 4, as a function, because clause 1 wants to know the answer too:
    // "how many bindings does the ScopeInfo bit alone refuse" is the number
    // that justifies clause 1 existing.
    const dominatesEveryRead = () => {
      if (program.length !== 1) return false;
      const s = program[0];
      const u0 = unitOf.get(s.sfiId);
      if (!u0 || s.block === null) return false;
      const dom = u0.rec.ir.dominators;
      for (const rd of row.readsInOwner) {
        if (rd.block === s.block) { if (rd.instruction <= s.instruction) return false; continue; }
        if (!dom.dominates(s.block, rd.block)) return false;
      }
      return true;
    };

    // clause 1: the original's own answer, out of the ScopeInfo. A location
    // whose VariableProperties were not decoded contributes `null`; another
    // location of the same binding -- same ScopeInfo, same local index -- that
    // WAS decoded is authoritative, the same way scopes.mjs takes a binding's
    // name wherever it is found.
    if (row.maybeAssigned.size === 1 && row.maybeAssigned.has(null)) {
      refuse(row, 'scopeInfoHasNoMaybeAssignedFlag');
      continue;
    }
    if (row.maybeAssigned.has(true)) {
      const shapeOk = program.length === 1 && program[0].isOwner && program[0].stmt !== null
        && row.unknownStores === 0;
      if (shapeOk && dominatesEveryRead()) stats.refusedForMaybeAssignedOnly++;
      refuse(row, 'scopeInfoSaysMaybeAssigned');
      continue;
    }

    if (!row.ownerSeen) { refuse(row, 'ownerWasNotEmitted'); continue; }
    if (program.length === 0) { refuse(row, 'noProgramStore'); continue; }
    if (program.length > 1) { refuse(row, 'moreThanOneProgramStore'); continue; }
    const store = program[0];
    if (!store.isOwner) { refuse(row, 'theOnlyStoreIsInADescendant'); continue; }
    if (store.stmt === null) { refuse(row, 'storeHasNoAssignmentStatement'); continue; }

    const u = unitOf.get(store.sfiId);
    const ir = u.rec.ir;

    // clause 4
    if (!dominatesEveryRead()) { refuse(row, 'storeDoesNotDominateEveryReadInTheOwner'); continue; }

    // clause 5
    if ((ir.blocks[store.block]?.loopDepth ?? 0) > 0) { refuse(row, 'storeIsInsideALoop'); continue; }

    // clause 6
    if (readsSlot(store.stmt.expr?.value, store.slotId)) {
      refuse(row, 'theStoreReadsTheBindingItStores');
      continue;
    }

    // clause 7, the region-tree half
    const at = u.positions.get(store.block);
    if (!at) { refuse(row, 'storeBlockIsNotPlaced'); continue; }
    if (!at.outermost) { refuse(row, 'storeIsNotInAnOutermostBlock'); continue; }

    sites.set(b, {
      binding: b, name: b.name, declKind: b.declKind, comment: b.comment ?? null,
      keyword: declarationKeyword(b.declKind, u.isTopLevel),
      sfiId: store.sfiId, slotId: store.slotId, stmt: store.stmt,
      block: store.block, opId: store.opId,
      holeInits: row.holeInits, readsInOwner: row.readsInOwner.length,
      readsElsewhere: row.readsElsewhere,
    });
    stats.atStore++;
    const k = b.declKind === 'const' || b.declKind === 'var' ? b.declKind : 'let';
    stats.atStoreByDeclKind[k]++;
  }

  // ---------------------------------------- 3. the per-unit view emit reads
  const perUnit = new Map();              // sfiId -> { byStmt, byBinding }
  for (const [b, site] of sites) {
    let v = perUnit.get(site.sfiId);
    if (!v) { v = { byStmt: new Map(), byBinding: new Map() }; perUnit.set(site.sfiId, v); }
    v.byStmt.set(site.stmt, site);
    v.byBinding.set(b, site);
  }

  const EMPTY = { byStmt: new Map(), byBinding: new Map() };
  return {
    sites, stats, rows,
    forUnit(sfiId) { return perUnit.get(sfiId) ?? EMPTY; },
  };
}

/**
 * The keyword a binding is declared with AT ITS STORE.
 *
 * The same mapping `names.mjs::declarationPrologue` uses, with one line of it
 * no longer forced: a `kConst` binding can be `const` here, because the
 * declaration and the initialiser are one statement. At the FILE's top level
 * `var` is not available -- a top-level `var` is a property of the global
 * object, not a context slot -- so the script unit gets `let`.
 */
export function declarationKeyword(declKind, topLevel) {
  if (declKind === 'const') return 'const';
  if (declKind === 'var') return topLevel ? 'let' : 'var';
  return 'let';
}

export default { planDeclarationSites, blockPositions, declarationKeyword, DECL_SITE_WHY };
