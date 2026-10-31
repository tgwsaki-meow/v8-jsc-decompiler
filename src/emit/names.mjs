// src/emit/names.mjs
//
// SSA destruction with naming (ARCHITECTURE.md 4.5), done on T7's name table
// rather than re-derived from it.
//
// T7 already decided every NAME (docs/RECOVER.md 4): one per context-slot
// location, one per materialised value, one per phi, parameters from the
// ScopeInfo, and the `__ctx_d<d>_i<i>` placeholder with its `ctx[d][i]`
// comment for a slot it could not resolve. What is left for this layer is
// where each name is DECLARED and which names have to be renamed so that two
// different storage locations do not end up spelled the same way in one
// function body. That is the "SSA version recycling" half of 4.5: the versions
// are already merged into names, and this file makes the merged names legal
// JavaScript.
//
// THREE RULES, each forced by something measured.
//
// 1. EVERY LOCAL is declared ONCE, at the top of the function body.
//
//    T7's `declarations[]` carries `scope: blockId|'function'`, where a block
//    id is the block the value is defined in. Declaring there is wrong for a
//    phi: `loop-while.jsc` #15 `f` gives phi 8 `scope: 1` (the loop header)
//    while its predecessor copies are emitted in blocks 0 and 2, so a
//    declaration in block 1 is both after the first write and inside a
//    narrower block than the reads. One declaration list at the top of the
//    body is the only placement that dominates every copy, which is exactly
//    what SSA destruction needs. `{s:'decl'}` statements therefore become
//    plain assignments (stmt.mjs) -- the declaration moves, the initialiser
//    does not.
//
//    "Local" here means a register-allocated value: a temp, a phi, a caught
//    exception, a hole or a scratch variable. A CONTEXT SLOT is not a local
//    and rule 3 owns it.
//
// 2. A temp whose name is ALSO a global, a parameter or a context slot in the
//    same function is RENAMED.
//
//    Measured on `loop-while.jsc` unit 0: T7's `inferBase` names the result of
//    `LdaGlobal 'T'` after the global it loaded (docs/RECOVER.md 4.1), and
//    the statement it emits is
//        {s:'decl', id: name T (temp), init: name T (global)}
//    which prints as `let T = T` -- a TDZ ReferenceError, and as `var T = T`
//    an assignment of undefined to itself. Nothing in T7 is wrong: its taken
//    set seeds ScopeInfo names and parameters, not the globals a function
//    reads. The two storage classes have to be told apart here, where both
//    `ref.k` values are visible on the same name. Priority is param >
//    contextSlot > global > temp, i.e. a real source name keeps its spelling
//    and the synthetic copy is suffixed. Counted as `localsRenamed`.
//
//    The one case where a PARAMETER is renamed instead: a parameter cannot
//    shadow a context binding an enclosing function declared, because the
//    body may read that binding. T7 spells parameters `p0..pN`, so this only
//    fires when a ScopeInfo variable is literally called `p0`; the parameter
//    is positional and its name is ours to choose, so it is the one that
//    moves. Counted as `paramsRenamedForABinding`.
//
// 3. A CONTEXT SLOT IS NOT A LOCAL. It is declared once, by the function that
//    owns its context frame, and nowhere else.
//
//    This is scopes.mjs, and it is the correctness decision the nesting in
//    index.mjs exists for. The old rule asked `depth > 0` and declared the
//    slot locally otherwise, which shadowed the closure on every ordinary
//    capture -- a function that allocates no context of its own reads its
//    enclosing variable at depth **0** (ARCHITECTURE.md 10.3). That is
//    docs/O1.md 6.5's defect, and `outerSlotDeclaredLocally` was a counter for
//    the rare case rather than a detector for the common one.
//
//    A binding this function neither owns nor inherits is NOT declared
//    locally and NOT left free: the function is refused, with the slot, the
//    frame and the depth named (scopes.mjs::SCOPE_REFUSAL_WHY).
//
// The identifier `ctx` is banned outright (11.3 invariant 5). T7 cannot emit
// it (docs/RECOVER.md 4.2 puts it in BANNED), and `sanitise()` below is the
// second line of defence: it is applied to every name that reaches an
// Identifier node, so the invariant holds on the AST and not on trust.

import * as t from '@babel/types';
import { HOLE_IDENTIFIER } from './holes.mjs';

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'await', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
]);

/** The one identifier 11.3 invariant 5 forbids. */
export const BANNED_IDENTIFIER = 'ctx';

/**
 * Make a string a legal, non-banned JS identifier. Deterministic: the same
 * input always gives the same output, which O2's round-trip fixpoint needs.
 */
export function sanitise(name) {
  let s = String(name ?? '');
  if (s === '') return '_';
  s = s.replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (s === BANNED_IDENTIFIER || RESERVED.has(s)) s = s + '_';
  return s;
}

/** Walk every Expr of a Stmt, calling fn on each. Shape-driven, tag-agnostic. */
export function walkExprsOfStmt(s, fn) {
  if (!s || typeof s !== 'object') return;
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    if (Array.isArray(e)) { for (const x of e) visit(x); return; }
    if (typeof e.e === 'string') fn(e);
    for (const k in e) {
      if (k === 'pos' || k === 'values' || k === 'ref' || k === 'dump') continue;
      const v = e[k];
      if (v && typeof v === 'object') visit(v);
    }
  };
  switch (s.s) {
    case 'expr': visit(s.expr); break;
    case 'return': case 'throw': visit(s.arg); break;
    case 'decl': for (const d of s.decls ?? []) { visit(d.id); visit(d.init); } break;
    default: break;
  }
}

/** Every `{e:'name'}` of every statement of every block, plus the Tests. */
function collectNameUses(rec, extraExprs) {
  const uses = [];
  const seenExpr = (e) => { if (e.e === 'name') uses.push(e); };
  for (const [, list] of rec.stmts) for (const s of list) walkExprsOfStmt(s, seenExpr);
  for (const e of extraExprs) {
    if (!e) continue;
    walkExprsOfStmt({ s: 'expr', expr: e }, seenExpr);
  }
  return uses;
}

/**
 * The parameter list, in order, from the IR's own Param values.
 * Index 0 is the receiver and is NOT a JavaScript parameter.
 */
function parameterNames(ir, rec, unit) {
  const byIndex = new Map();
  for (let id = 0; id < ir.values.length; id++) {
    const v = ir.values[id];
    if (!v || v.kind !== 'Param') continue;
    if (!byIndex.has(v.index)) byIndex.set(v.index, id);
  }
  const count = unit.parameterCount ?? (byIndex.size || 1);
  const rest = (rec.names.declarations ?? []).find((d) => d.rest);
  const params = [];
  for (let i = 1; i < count; i++) {
    const vid = byIndex.get(i);
    const rec0 = vid === undefined ? null : rec.names.byValue.get(vid);
    params.push({
      index: i, valueId: vid ?? null,
      name: sanitise(rec0?.name ?? `p${i - 1}`),
      origin: rec0?.origin ?? 'synthetic',
    });
  }
  return { params, restName: rest ? sanitise(rest.name) : null };
}

/** The empty scope plan, for a unit scopes.mjs produced nothing for. */
const NO_SCOPE = {
  owns: [], ownNames: new Set(), inheritedNames: new Set(), visibleNames: new Set(),
  slotName: new Map(), slotBinding: new Map(), unplaceable: [], inheritedCount: 0,
};

/**
 * Plan the names of one function.
 *
 * @param {object} rec    the RecoveredFunction
 * @param {object} ir
 * @param {object} unit
 * @param {object[]} extraExprs  Exprs reached outside `stmts` (Tests, Targets)
 * @param {Set<string>} inherited names an enclosing emitted function declares
 * @param {object} scope  this unit's view of the file-wide scope plan
 */
export function planNames(rec, ir, unit, extraExprs, inherited = new Set(), scope = null) {
  const sc = scope ?? NO_SCOPE;
  const { params, restName } = parameterNames(ir, rec, unit);

  // --- rule 2's parameter half: a parameter may not shadow a context binding
  const paramRename = new Map();
  let paramsRenamed = 0;
  const paramNames = new Set();
  const claimParam = (name) => {
    let candidate = name;
    for (let n = 2; sc.visibleNames.has(candidate) || paramNames.has(candidate); n++) {
      candidate = `${name}$p${n}`;
    }
    if (candidate !== name) { paramRename.set(name, candidate); paramsRenamed++; }
    paramNames.add(candidate);
    return candidate;
  };
  for (const p of params) p.name = claimParam(p.name);
  const finalRestName = restName === null ? null : claimParam(restName);

  // --- classify every spelling by the storage classes that use it
  const classesOf = new Map();          // name -> Set<'global'|'param'|'ctx'|'temp'>
  const add = (name, cls) => {
    const k = sanitise(name);
    if (!classesOf.has(k)) classesOf.set(k, new Set());
    classesOf.get(k).add(cls);
  };
  /**
   * A declaration's storage class. Classifying every row as a temp made the
   * `__ctx_d0_i2` placeholder look like a temp AND a context slot, so rule 2
   * renamed it against itself: `let __ctx_d0_i2$t`. T7 puts `contextSlot` on
   * the declaration of a slot, which is the authority.
   */
  const declClass = (d) => {
    if (d.kind === 'param') return 'param';
    if (d.contextSlot) return 'ctx';
    if (d.origin === 'scopeInfo') return 'ctx';
    return 'temp';
  };
  const uses = collectNameUses(rec, extraExprs);
  const slotUsesWithoutABinding = [];
  for (const u of uses) {
    const k = u.ref?.k;
    if (k === 'global') add(u.name, 'global');
    else if (k === 'param') add(u.name, 'param');
    else if (k === 'contextSlot') {
      const spelling = sc.slotName.get(u.ref.slotValue);
      if (spelling === undefined) slotUsesWithoutABinding.push(u);
      else add(spelling, 'ctx');
    } else add(u.name, 'temp');
  }
  for (const p of params) add(p.name, 'param');
  if (finalRestName) add(finalRestName, 'param');
  for (const d of rec.names.declarations ?? []) {
    if (d.contextSlot) continue;                  // rule 3 owns every slot
    add(d.name, declClass(d));
  }
  // Every binding in scope, whether this function owns it or inherits it, so
  // rule 2 can move a temp off its spelling.
  for (const n of sc.visibleNames) add(n, 'ctx');

  // --- rule 2: a temp spelling that another storage class also owns is renamed
  const rename = new Map();
  let renamed = 0;
  const taken = new Set([...classesOf.keys(), ...paramNames, HOLE_IDENTIFIER]);
  for (const name of [...classesOf.keys()].sort()) {
    const cls = classesOf.get(name);
    if (!cls.has('temp')) continue;
    if (cls.size === 1) continue;                       // only a temp: keep it
    let candidate = `${name}$t`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${name}$t${n}`;
    taken.add(candidate);
    rename.set(name, candidate);
    renamed++;
  }

  // --- rule 1 + 3: what this function declares at the top of its body
  const declared = new Map();           // emitted name -> {kind, origin, why, comment}
  const note = (name, info) => {
    const k = rename.get(sanitise(name)) ?? sanitise(name);
    if (paramNames.has(k)) return;                      // a parameter declares it
    if (!declared.has(k)) declared.set(k, info);
  };

  // rule 3 first: the context bindings this function OWNS. They come first
  // because they are the real source variables, and because the owner declares
  // every binding its descendants need even when its own body never mentions
  // one -- a catch context's slot is stored by the context-creating
  // instruction and so has no store op in the owner at all.
  let constAsLet = 0;
  for (const b of sc.owns) {
    const kind = b.declKind === 'const' ? 'let' : b.declKind;
    if (b.declKind === 'const') constAsLet++;
    declared.set(b.name, {
      kind, origin: b.rawName ? 'scopeInfo' : 'synthetic',
      why: 'contextBinding', comment: b.comment ?? null, binding: b,
    });
  }

  for (const d of rec.names.declarations ?? []) {
    if (d.kind === 'param') continue;
    if (d.contextSlot) continue;                        // rule 3 owns every slot
    note(d.name, { kind: d.kind, origin: d.origin, why: 'declaration', comment: d.comment ?? null });
  }
  // Over-declare rather than leave a LOCAL free: every non-global, non-param,
  // non-slot spelling a statement mentions gets a declaration, even when T7's
  // `declarations[]` has no row for it. An unused `let` is ugly; an undeclared
  // read is 11.3 invariant 5. A context slot is deliberately NOT in this loop:
  // declaring it here is exactly the defect of docs/O1.md 6.5.
  for (const u of uses) {
    const k = u.ref?.k;
    if (k === 'global' || k === 'param' || k === 'contextSlot') continue;
    note(u.name, { kind: 'let', origin: 'synthetic', why: 'referenced', comment: u.ref?.comment ?? null });
  }

  const declaredNames = new Set(declared.keys());
  const globalNames = new Set([...classesOf.entries()].filter(([, c]) => c.has('global')).map(([n]) => n));
  // A slot use with no binding. Measured over 130 corpus files, every one of
  // these is T7's frameless `ctx[d][i]` placeholder -- `ref.slotValue` is null
  // because no single context object reaches the instruction, so there is no
  // storage LOCATION, which is a different thing from a location whose owner
  // could not be found. The two are reported under their own reasons rather
  // than as one number.
  const unplaceable = [...sc.unplaceable];
  for (const u of slotUsesWithoutABinding) {
    const frameless = u.ref?.slotValue === null || u.ref?.slotValue === undefined;
    unplaceable.push({
      why: frameless ? 'contextFrameNotStaticallyKnown' : 'contextSlotWithoutABinding',
      detail: `${sanitise(u.name)} depth ${u.ref?.depth} index ${u.ref?.index}`
        + `${u.ref?.why ? ` (${u.ref.why})` : ''}`,
    });
  }
  return {
    params, restName: finalRestName, paramNames,
    declared, declaredNames, rename, paramRename, globalNames,
    slotName: sc.slotName, visibleBindingNames: sc.visibleNames, unplaceable,
    stats: {
      params: params.length,
      declarations: declared.size,
      localsRenamed: renamed,
      paramsRenamedForABinding: paramsRenamed,
      contextBindingsOwned: sc.owns.length,
      contextBindingsInherited: sc.inheritedCount,
      contextBindingsUnplaceable: unplaceable.length,
      constBindingsEmittedAsLet: constAsLet,
    },
    /** Everything in scope inside this function, for the nested ones. */
    exported: new Set([...inherited, ...declaredNames, ...paramNames]),
  };
}

/**
 * The declaration prologue, with the `ctx[*][i]` comment on the placeholders
 * that carry one.
 *
 * Two lists, not one, and the split is read off the data rather than chosen: a
 * context binding whose ScopeInfo mode is `kVar` is declared `var`, everything
 * else `let`. It matters because V8 initialises a context-allocated `let` and
 * does not initialise a `var` -- `let x;` costs `LdaTheHole;
 * StaCurrentContextSlot` at scope entry plus `LdaUndefined;
 * StaCurrentContextSlot` for the declaration, and `var x;` costs nothing. At
 * the FILE's top level `var` is not available: a top-level `var` is a property
 * of the global object, not a context slot, so the script unit declares
 * everything `let`.
 */
export function declarationPrologue(plan, extraNames = [], opts = {}) {
  const topLevel = opts.topLevel === true;
  const names = [...plan.declaredNames, ...extraNames.map((n) => sanitise(n))];
  const seen = new Set();
  const lists = new Map([['var', []], ['let', []]]);
  for (const n of names) {
    if (seen.has(n) || plan.paramNames.has(n)) continue;
    seen.add(n);
    const info = plan.declared.get(n);
    const id = t.identifier(n);
    const d = t.variableDeclarator(id, null);
    if (info?.comment) t.addComment(d, 'leading', ` ${String(info.comment).replace(/\*\//g, '* /')} `, false);
    const kind = !topLevel && info?.kind === 'var' && info?.why === 'contextBinding' ? 'var' : 'let';
    lists.get(kind).push(d);
  }
  const out = [];
  for (const kind of ['var', 'let']) {
    const decls = lists.get(kind);
    if (decls.length) out.push(t.variableDeclaration(kind, decls));
  }
  return out;
}

export default { planNames, declarationPrologue, sanitise, walkExprsOfStmt, BANNED_IDENTIFIER };
