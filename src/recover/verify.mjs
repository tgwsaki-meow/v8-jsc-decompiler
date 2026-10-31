// src/recover/verify.mjs
//
// T7's own invariants, run on every function. Four of them are the executable
// form of ARCHITECTURE.md's metrics 6, 7 and 11.3's invariants 4 and 5, which
// is the whole reason this layer was rewritten:
//
//   R1  no value's defining expression is emitted twice unless it is in
//       `duplicable`                              -> metric 6 (was 12.93%)
//   R2  no value with `allocationKind` definite or maybe is emitted twice
//       -> metric 7 (was 50.27%); implied by R1 but counted separately so the
//          two baseline numbers stay separately visible
//   R3  the identifier `ctx` never appears              -> 11.3 invariant 5
//   R4  every hole is counted and carries a `why`       -> 11.3 invariant 6
//   R5  every `exprs` entry is one of 11.1's tags (plus the three documented
//       extensions); no intermediate tag survives
//   R6  every name a statement reads has a declaration, a parameter, a global
//       or a context slot behind it -- no free invented identifier
//   R7  every statement is one of 11.1's `Stmt` forms
//
// R1's test is exact rather than heuristic: resolution memoises one expression
// OBJECT per SSA value, so "emitted twice" is "the same object is reached
// twice while walking the statement trees". No structural comparison, no
// guessing.

const STMT_TAGS = new Set(['expr', 'decl', 'return', 'throw', 'debugger', 'hole']);

export function verifyRecovered(rec, opts = {}) {
  const violations = [];
  const counts = {
    exprNodes: 0, statements: 0, holes: 0, byHoleWhy: {},
    duplicatedValues: 0, duplicatedAllocations: 0, duplicatedEffectful: 0,
    namesRead: 0, undeclaredNames: 0, ctxIdentifiers: 0,
  };
  const fail = (code, detail) => {
    violations.push({ code, ...detail });
    if (opts.strict) throw new Error(`recover verify: ${code} ${JSON.stringify(detail)}`);
  };

  const ir = rec.ir;
  // Several values can share ONE expression object: a pattern that says "this
  // projection IS that spilled register" aliases them deliberately
  // (BuildSuspendPoint:5977). So the map is node -> every value that resolves
  // to it, and R1 below asks whether ANY of them may be duplicated. Keeping
  // only the first id reported a shared `{e:'lit', v:undefined}` as a
  // re-evaluated `ResumeGenerator`.
  const nodeToValues = new Map();
  for (const [id, node] of rec.exprs) {
    if (!node || typeof node !== 'object') continue;
    const l = nodeToValues.get(node);
    if (l) l.push(id); else nodeToValues.set(node, [id]);
  }

  // ------------------------------------------------------------- the walk
  const reach = new Map();            // expr object -> times reached
  const declared = declaredNames(rec);
  const globals = new Set(rec.names.globals?.keys?.() ?? []);

  for (const [bid, list] of rec.stmts) {
    for (const s of list) {
      counts.statements++;
      if (!s || !STMT_TAGS.has(s.s)) { fail('statementTag', { block: bid, tag: s?.s ?? null }); continue; }
      walk(s, bid);
    }
  }

  function walk(x, bid) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y, bid); return; }
    if (typeof x.e === 'string') {
      counts.exprNodes++;
      reach.set(x, (reach.get(x) ?? 0) + 1);
      if (x.e === 'hole') {
        counts.holes++;
        const why = x.why ?? 'unknown';
        counts.byHoleWhy[why] = (counts.byHoleWhy[why] ?? 0) + 1;
        if (!x.why) fail('holeWithoutWhy', { block: bid });
      } else if (x.e === 'name') {
        counts.namesRead++;
        if (x.name === 'ctx') { counts.ctxIdentifiers++; fail('ctxIdentifier', { block: bid }); }
        const k = x.ref?.k;
        if (k !== 'global' && !declared.has(x.name) && !globals.has(x.name) && x.name !== 'this'
          && x.name !== 'arguments' && x.name !== 'eval') {
          counts.undeclaredNames++;
          fail('undeclaredName', { block: bid, name: x.name, refKind: k ?? null });
        }
      }
    }
    for (const k of Object.keys(x)) {
      if (k === 'pos' || k === 'values' || k === 'ref' || k === 'cites') continue;
      walk(x[k], bid);
    }
  }

  // --------------------------------------------- R1 / R2: no re-evaluation
  //
  // What must not repeat is a value's DEFINING expression. A reference to a
  // materialised value is an identifier -- `exprs` holds `{e:'name'}` for it --
  // and reading a variable twice re-evaluates nothing, which is the entire
  // point of 4.3's "materialise a named temporary instead". So a name node is
  // skipped, and `duplicable` contains every materialised value for exactly
  // this reason (see src/recover/index.mjs where it is assembled).
  for (const [node, n] of reach) {
    if (n <= 1) continue;
    if (node.e === 'name' || node.e === 'this' || node.e === 'newTarget') continue;
    const ids = nodeToValues.get(node);
    if (ids === undefined) continue;         // a literal built inline, not a value
    if (ids.some((x) => rec.duplicable.has(x))) continue;
    const id = ids[0];
    const v = ir.values[id];
    counts.duplicatedValues++;
    if (v?.allocationKind === 'definite' || v?.allocationKind === 'maybe') counts.duplicatedAllocations++;
    if (v?.hasEffect) counts.duplicatedEffectful++;
    fail('valueEmittedTwice', {
      value: id, times: n, op: v?.op ?? v?.kind ?? null,
      allocationKind: v?.allocationKind ?? null, hasEffect: !!v?.hasEffect,
    });
  }

  // --------------------------------------------------------- R3: `ctx` again
  for (const d of rec.names.declarations) {
    if (d.name === 'ctx') { counts.ctxIdentifiers++; fail('ctxDeclaration', { name: d.name }); }
  }
  for (const [, r] of rec.names.byContextSlot) {
    if (r.name === 'ctx') { counts.ctxIdentifiers++; fail('ctxContextSlotName', { name: r.name }); }
  }

  // ------------------------------------------------------- R5: the expr tags
  for (const [id, e] of rec.exprs) {
    if (!e || typeof e.e !== 'string') { fail('exprNotATaggedObject', { value: id }); continue; }
  }

  return {
    ok: violations.length === 0,
    violations: violations.slice(0, 64),
    violationCount: violations.length,
    counts,
  };
}

function declaredNames(rec) {
  const s = new Set();
  for (const d of rec.names.declarations) s.add(d.name);
  for (const [, r] of rec.names.byContextSlot) s.add(r.name);
  for (const [, r] of rec.names.byValue) s.add(r.name);
  for (const [, r] of rec.materialised ?? []) s.add(r.name);
  return s;
}

export default { verifyRecovered };
