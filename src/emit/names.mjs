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
// THREE RULES, each forced by something measured on T7's output.
//
// 1. EVERY local name is declared ONCE, at the top of the function body.
//
//    T7's `declarations[]` carries `scope: blockId|'function'`, where a block
//    id is the block the value is defined in. Declaring there is wrong for a
//    phi: `loop-while.jsc` #15 `f` gives phi 8 `scope: 1` (the loop header)
//    while its predecessor copies are emitted in blocks 0 and 2, so a
//    declaration in block 1 is both after the first write and inside a
//    narrower block than the reads. One `let` list at the top of the body is
//    the only placement that dominates every copy, which is exactly what SSA
//    destruction needs. `{s:'decl'}` statements therefore become plain
//    assignments (stmt.mjs) -- the declaration moves, the initialiser does
//    not.
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
// 3. A context slot at depth > 0 is NOT declared locally when an ancestor
//    declares it.
//
//    `LdaContextSlot depth 1` is a read of the ENCLOSING function's variable.
//    Declaring it in the inner function would shadow the closure and break
//    it. Because functions are emitted nested (index.mjs), the ancestor's
//    declaration is in scope, so the inner function declares nothing. A depth
//    > 0 name no ancestor declares is still declared locally -- nothing may be
//    free (11.3 invariant 5) -- and counted as `outerSlotDeclaredLocally`.
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

/**
 * Plan the names of one function.
 *
 * @param {object} rec    the RecoveredFunction
 * @param {object} ir
 * @param {object} unit
 * @param {object[]} extraExprs  Exprs reached outside `stmts` (Tests, Targets)
 * @param {Set<string>} inherited names an enclosing emitted function declares
 */
export function planNames(rec, ir, unit, extraExprs, inherited = new Set()) {
  const { params, restName } = parameterNames(ir, rec, unit);
  const paramNames = new Set(params.map((p) => p.name));
  if (restName) paramNames.add(restName);

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
  const outerSlotNames = new Set();
  for (const u of uses) {
    const k = u.ref?.k;
    if (k === 'global') add(u.name, 'global');
    else if (k === 'param') add(u.name, 'param');
    else if (k === 'contextSlot') {
      add(u.name, 'ctx');
      if ((u.ref.depth ?? 0) > 0) outerSlotNames.add(sanitise(u.name));
    } else add(u.name, 'temp');
  }
  for (const p of params) add(p.name, 'param');
  if (restName) add(restName, 'param');
  for (const d of rec.names.declarations ?? []) add(d.name, declClass(d));

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
  let outerSlotDeclaredLocally = 0;
  for (const d of rec.names.declarations ?? []) {
    if (d.kind === 'param') continue;
    note(d.name, { kind: d.kind, origin: d.origin, why: 'declaration', comment: d.comment ?? null });
  }
  // Over-declare rather than leave a name free: every non-global, non-param
  // spelling a statement mentions gets a declaration, even when T7's
  // `declarations[]` has no row for it. An unused `let` is ugly; an undeclared
  // read is 11.3 invariant 5.
  for (const u of uses) {
    const k = u.ref?.k;
    if (k === 'global' || k === 'param') continue;
    const spelling = sanitise(u.name);
    if (k === 'contextSlot' && (u.ref.depth ?? 0) > 0) {
      if (inherited.has(spelling)) continue;            // rule 3: the closure owns it
      outerSlotDeclaredLocally++;
    }
    note(u.name, {
      kind: 'let', origin: k === 'contextSlot' ? 'scopeInfo' : 'synthetic',
      why: 'referenced', comment: u.ref?.comment ?? null,
    });
  }

  const declaredNames = new Set(declared.keys());
  const globalNames = new Set([...classesOf.entries()].filter(([, c]) => c.has('global')).map(([n]) => n));
  return {
    params, restName, paramNames,
    declared, declaredNames, rename, globalNames,
    stats: {
      params: params.length,
      declarations: declared.size,
      localsRenamed: renamed,
      outerSlotNames: outerSlotNames.size,
      outerSlotDeclaredLocally,
    },
    /** Everything in scope inside this function, for the nested ones. */
    exported: new Set([...inherited, ...declaredNames, ...paramNames]),
  };
}

/**
 * The declaration prologue: one `let` list, in a deterministic order, with the
 * `ctx[d][i]` comment on the placeholders that carry one.
 */
export function declarationPrologue(plan, extraNames = []) {
  const names = [...plan.declaredNames, ...extraNames.map((n) => sanitise(n))];
  const seen = new Set();
  const decls = [];
  for (const n of names) {
    if (seen.has(n) || plan.paramNames.has(n)) continue;
    seen.add(n);
    const info = plan.declared.get(n);
    const id = t.identifier(n);
    const d = t.variableDeclarator(id, null);
    if (info?.comment) t.addComment(d, 'leading', ` ${String(info.comment).replace(/\*\//g, '* /')} `, false);
    decls.push(d);
  }
  if (!decls.length) return [];
  return [t.variableDeclaration('let', decls)];
}

export default { planNames, declarationPrologue, sanitise, walkExprsOfStmt, BANNED_IDENTIFIER };
