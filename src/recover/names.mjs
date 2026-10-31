// src/recover/names.mjs
//
// ARCHITECTURE.md 4.5 + 11.1: every naming decision in one place, so it can be
// audited and so collisions are resolved once.
//
// What this does NOT do, deliberately: it does not walk the ScopeInfo
// outer_scope_info chain. ARCHITECTURE.md 10.3 corrected 8.1 on two counts
// (the subtrahend is ScopeInfo::ContextHeaderLength(), and depth 0 is
// `unit.scope.outer`), and T6 implemented and measured that walk --
// 968 489 of 980 989 slot operations (98.726%) resolve. So a context slot's
// name is READ off `v.contextSlot.name` / `ir.contextSlotValues`, never
// recomputed here.
//
// The deterministic synthetic-name rule, in full (docs/RECOVER.md repeats it
// because O2's round-trip fixpoint depends on it being stable):
//
//   1. Candidate names are allocated in ONE pass over the values that need a
//      name, in ascending SSA id order. SSA ids are assigned by src/ir in a
//      fixed order for a fixed input, so two runs agree.
//   2. Each value proposes a `base` from its defining instruction (the table
//      in `inferBase` below). A value with no proposal uses the base for its
//      kind: 'v' for a phi, 'e' for a caught exception, 't' for anything else.
//   3. `base` is sanitised to a JS identifier: every character outside
//      [A-Za-z0-9_$] becomes '_', a leading digit gets a '_' prefix, and the
//      reserved words plus the single banned identifier `ctx` are prefixed
//      with '_'.
//   4. The first value to claim a base gets it verbatim. The n-th gets
//      `base + '$' + n` (n counting from 2). Already-taken names -- ScopeInfo
//      names, parameter names, every global the function references -- are
//      seeded into the taken set before step 4, so a temp never shadows a real
//      name.
//
// `ctx` can never be produced: it is in BANNED, so a ScopeInfo variable
// actually called `ctx` comes out as `ctx_` and a synthetic one as `_ctx`.
// An unresolved context slot becomes `__ctx_d<d>_i<i>` with
// `comment: 'ctx[d][i]'`, which is 4.5's "/* ctx[d][i] */ + declared
// placeholder", and it is declared, so nothing is ever free.

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'implements',
  'interface', 'package', 'private', 'protected', 'public', 'arguments', 'eval',
]);

/** The one identifier ARCHITECTURE.md 11.3 invariant 5 forbids in the output. */
export const BANNED = new Set(['ctx']);

export const ORIGINS = Object.freeze(['scopeInfo', 'param', 'inferredFromUse', 'synthetic']);

/** V8's own internal variable names, which are not valid JS identifiers. */
const INTERNAL_PREFIX = /^[.*]/;

export function sanitiseIdentifier(raw) {
  let s = String(raw ?? '');
  // V8 internal names: '.generator_object', '.catch', '*ns*', 'this_function'
  const internal = INTERNAL_PREFIX.test(s);
  s = s.replace(/[^A-Za-z0-9_$]/g, '_');
  if (s === '') s = '_';
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (RESERVED.has(s)) s = s + '_';
  if (BANNED.has(s)) s = s + '_';
  if (internal) s = '__' + s.replace(/^_+/, '');
  return s;
}

/**
 * Propose a base name from the instruction that defines a value. This is 4.5's
 * "infer from the use site": the syntax around the value names it.
 *
 * Returns {base, origin} or null.
 */
function inferBase(v, ir, helpers) {
  if (!v) return null;
  if (v.kind === 'Param') {
    return v.isReceiver ? { base: 'this', origin: 'param' } : { base: 'p' + (v.index - 1), origin: 'param' };
  }
  if (v.kind === 'CaughtException') return { base: 'e', origin: 'synthetic' };
  if (v.kind === 'Phi') {
    const reg = v.reg;
    if (reg?.k === 'param') return { base: reg.i === 0 ? 'this' : 'p' + (reg.i - 1), origin: 'param' };
    return { base: 'v', origin: 'synthetic' };
  }
  if (v.kind === 'FrameEntry') {
    if (v.what === 'incomingGeneratorObject') return { base: '__generator', origin: 'synthetic' };
    if (v.what === 'incomingNewTarget') return { base: '__newTarget', origin: 'synthetic' };
    if (v.what === 'incomingContext') return { base: '__context', origin: 'synthetic' };
    return { base: 't', origin: 'synthetic' };
  }
  if (v.kind !== 'Op' && v.kind !== 'Proj') return null;
  const op = v.op;
  const ins = ir.instructions[v.instruction];

  // a context-slot load names the variable it loads
  if (v.contextSlot?.resolved && v.contextSlot.name) {
    return { base: v.contextSlot.name, origin: 'scopeInfo' };
  }

  const nameOperand = () => {
    for (const o of ins.operands) {
      if (o.type === 'kConstantPoolIndex' && o.constant?.t === 'string') return o.constant.v;
    }
    return null;
  };

  switch (op) {
    case 'GetNamedProperty':
    case 'GetNamedPropertyFromSuper':
    case 'DefineNamedOwnProperty':
    case 'SetNamedProperty': {
      const n = nameOperand();
      if (n) return { base: n, origin: 'inferredFromUse' };
      break;
    }
    case 'LdaGlobal':
    case 'LdaGlobalInsideTypeof': {
      const n = nameOperand();
      if (n) return { base: n, origin: 'inferredFromUse' };
      break;
    }
    case 'CreateObjectLiteral':
    case 'CreateEmptyObjectLiteral':
    case 'CloneObject':
      return { base: 'obj', origin: 'inferredFromUse' };
    case 'CreateArrayLiteral':
    case 'CreateEmptyArrayLiteral':
    case 'CreateArrayFromIterable':
      return { base: 'arr', origin: 'inferredFromUse' };
    case 'CreateRegExpLiteral':
      return { base: 're', origin: 'inferredFromUse' };
    case 'CreateRestParameter':
      return { base: 'rest', origin: 'inferredFromUse' };
    case 'CreateMappedArguments':
    case 'CreateUnmappedArguments':
      return { base: 'args', origin: 'inferredFromUse' };
    case 'CreateClosure': {
      const n = helpers?.closureName?.(ins);
      return { base: n || 'fn', origin: n ? 'inferredFromUse' : 'synthetic' };
    }
    case 'GetIterator':
      return { base: 'iter', origin: 'inferredFromUse' };
    case 'ForInPrepare':
    case 'ForInEnumerate':
      return { base: 'keys', origin: 'inferredFromUse' };
    case 'ForInNext':
    case 'GetEnumeratedKeyedProperty':
      return { base: 'key', origin: 'inferredFromUse' };
    case 'Construct':
    case 'ConstructWithSpread':
    case 'ConstructForwardAllArgs': {
      const n = helpers?.calleeName?.(v);
      if (n) return { base: n.charAt(0).toLowerCase() + n.slice(1), origin: 'inferredFromUse' };
      return { base: 'instance', origin: 'synthetic' };
    }
    case 'CallProperty':
    case 'CallProperty0':
    case 'CallProperty1':
    case 'CallProperty2':
    case 'CallAnyReceiver':
    case 'CallUndefinedReceiver':
    case 'CallUndefinedReceiver0':
    case 'CallUndefinedReceiver1':
    case 'CallUndefinedReceiver2':
    case 'CallWithSpread': {
      const n = helpers?.calleeName?.(v);
      if (n) {
        // getFoo() -> foo, foo() -> foo
        const m = /^(?:get|read|load|fetch|create|make|to)([A-Z]\w*)$/.exec(n);
        const b = m ? m[1].charAt(0).toLowerCase() + m[1].slice(1) : n;
        return { base: b, origin: 'inferredFromUse' };
      }
      return { base: 'r', origin: 'synthetic' };
    }
    case 'GetTemplateObject':
      return { base: 'tmpl', origin: 'inferredFromUse' };
    case 'LdaConstant': {
      const n = nameOperand();
      if (n && n.length <= 24 && /^[A-Za-z_$][\w$]*$/.test(n)) return { base: n, origin: 'inferredFromUse' };
      return { base: 'k', origin: 'synthetic' };
    }
    default:
      break;
  }
  if (v.kind === 'Proj') return { base: 't', origin: 'synthetic' };
  return null;
}

/**
 * The naming table of 11.1.
 *
 * @param {object} ir     an IRFunction
 * @param {object} opts   {helpers:{closureName, calleeName}}
 */
export function buildNames(ir, opts = {}) {
  const helpers = opts.helpers ?? {};
  const unit = ir.unit;

  const byValue = new Map();          // ssaId -> {name, origin}
  const byContextSlot = new Map();    // slotValueId -> {name, origin, declaredAt}
  const declarations = [];
  const collisions = [];
  const globals = new Map();          // free global identifier -> count
  const taken = new Map();            // name -> count of claims
  const stats = { byOrigin: {}, unresolvedSlots: 0, sanitised: 0, slotOps: 0, slotResolved: 0 };

  const claim = (base) => {
    const b = sanitiseIdentifier(base);
    const n = taken.get(b) ?? 0;
    taken.set(b, n + 1);
    return n === 0 ? b : `${b}$${n + 1}`;
  };
  const reserve = (name) => {
    const b = sanitiseIdentifier(name);
    if (!taken.has(b)) taken.set(b, 1);
    return b;
  };
  const note = (origin) => { stats.byOrigin[origin] = (stats.byOrigin[origin] ?? 0) + 1; };

  // ---------------------------------------------------------------- 1. seeds
  // Reserve every name that comes from real metadata first, so a synthetic
  // temp can never shadow one. Deterministic order: the scope chain outward,
  // then the parameters.
  for (let s = unit.scope, depth = 0; s; s = s.outer, depth++) {
    for (const n of s.contextLocalNames ?? []) if (n) reserve(n);
    if (depth > 32) break;             // defensive: the chain is a list, not a cycle
  }
  if (unit.name) reserve(unit.name);

  // ------------------------------------------------- 2. the context slots
  // One name per ContextSlot *location*, which is what makes a load and a
  // store of the same variable print the same identifier.
  const slotIds = [...(ir.contextSlotValues?.values() ?? [])].sort((a, b) => a - b);
  for (const id of slotIds) {
    const sv = ir.values[id];
    if (!sv) continue;
    let name, origin, comment = null;
    if (sv.resolved && sv.name) {
      const raw = sv.name;
      name = sanitiseIdentifier(raw);
      if (name !== raw) stats.sanitised++;
      // The slot owns this name: reserve() rather than claim() so that two
      // frames whose ScopeInfo says the same name do collide and get reported.
      const prior = taken.get(name) ?? 0;
      if (prior > 1) {
        name = claim(raw);
        collisions.push({ name: sanitiseIdentifier(raw), values: [id], resolvedTo: [name] });
      } else {
        taken.set(name, Math.max(prior, 1) + 1);
      }
      origin = 'scopeInfo';
    } else {
      // 4.5's placeholder: a declared variable plus the (depth, index) marker.
      name = claim(`__ctx_d${sv.depthFromUse ?? 0}_i${sv.slot ?? 0}`);
      comment = `ctx[${sv.depthFromUse ?? 0}][${sv.slot ?? 0}]`;
      origin = 'synthetic';
      stats.unresolvedSlots++;
    }
    note(origin);
    const kind = slotKind(sv);
    byContextSlot.set(id, { name, origin, declaredAt: 'function', comment, why: sv.why ?? null });
    declarations.push({
      name, kind, scope: 'function', origin,
      values: [...(sv.loads ?? []), ...(sv.stores ?? [])],
      contextSlot: { depth: sv.depthFromUse ?? null, index: sv.slot ?? null, frame: sv.frame ?? null },
      comment,
    });
  }

  // ----------------------------------------------------------- 3. the globals
  for (const v of ir.values) {
    if (v.kind !== 'Op') continue;
    if (v.op !== 'LdaGlobal' && v.op !== 'LdaGlobalInsideTypeof'
      && v.op !== 'StaGlobal' && v.op !== 'LdaLookupGlobalSlot'
      && v.op !== 'LdaLookupGlobalSlotInsideTypeof') continue;
    const ins = ir.instructions[v.instruction];
    const c = ins.operands.find((o) => o.type === 'kConstantPoolIndex')?.constant;
    if (c?.t === 'string') globals.set(c.v, (globals.get(c.v) ?? 0) + 1);
  }

  // -------------------------------------------------------- 4. the parameters
  const paramNames = [];
  for (const v of ir.values) {
    if (v.kind !== 'Param') continue;
    if (v.isReceiver) { byValue.set(v.id, { name: 'this', origin: 'param' }); note('param'); continue; }
    const name = reserve('p' + (v.index - 1));
    paramNames[v.index - 1] = name;
    byValue.set(v.id, { name, origin: 'param' });
    note('param');
    declarations.push({ name, kind: 'param', scope: 'function', origin: 'param', values: [v.id] });
  }

  stats.slotOps = ir.stats?.contextSlots?.ops ?? 0;
  stats.slotResolved = ir.stats?.contextSlots?.resolved ?? 0;

  // ------------------------------------------- 2b. the (depth, index) fallback
  //
  // docs/IR.md 11: on 12 119 of 980 989 slot operands (1.24%) the context
  // register holds different context objects on different paths into the
  // instruction, so there is no single frame and therefore no slot LOCATION to
  // name -- `v.contextSlot.slotValue` is null. ARCHITECTURE.md 4.5 says
  // exactly what to do: emit the `/* ctx[d][i] */` marker plus a declared
  // placeholder. One placeholder per (depth, index) pair, allocated on first
  // use, so the same slot reads as the same identifier throughout the function.
  const placeholders = new Map();
  const placeholderFor = (depth, index, why) => {
    const key = `${depth}:${index}`;
    let rec = placeholders.get(key);
    if (!rec) {
      const name = claim(`__ctx_d${depth}_i${index}`);
      rec = { name, origin: 'synthetic', declaredAt: 'function', comment: `ctx[${depth}][${index}]`, why: why ?? null };
      placeholders.set(key, rec);
      note('synthetic');
      stats.unresolvedSlots++;
      declarations.push({
        name, kind: 'let', scope: 'function', origin: 'synthetic', values: [],
        contextSlot: { depth, index, frame: null }, comment: rec.comment,
      });
    }
    return rec;
  };

  /**
   * Name a value that the recovery decided to materialise. Idempotent.
   * Call order decides the numbering, so index.mjs calls it in ascending id.
   */
  const nameValue = (id, kindHint = 'temp') => {
    const have = byValue.get(id);
    if (have) return have;
    const v = ir.values[id];
    const proposal = inferBase(v, ir, helpers) ?? { base: 't', origin: 'synthetic' };
    const name = claim(proposal.base);
    const rec = { name, origin: proposal.origin };
    byValue.set(id, rec);
    note(proposal.origin);
    declarations.push({
      name, kind: kindHint, scope: v?.block ?? 'function',
      origin: proposal.origin, values: [id],
    });
    return rec;
  };

  /**
   * A named function expression refers to itself by its own name:
   * VisitThisFunctionVariable:8581 copies `<closure>` into the
   * `.this_function` variable, and the binding is the function's own name,
   * which is in scope throughout its body. It is only a binding when the body
   * actually reads `<closure>`, so it is declared lazily -- otherwise every
   * one of the corpus's 239 979 functions would carry a declaration nothing
   * references. Idempotent.
   */
  const declaredSelf = new Set();
  const declareFunctionSelf = (raw) => {
    const name = sanitiseIdentifier(raw);
    if (declaredSelf.has(name)) return name;
    declaredSelf.add(name);
    note('scopeInfo');
    declarations.push({
      name, kind: 'const', scope: 'function', origin: 'scopeInfo',
      values: [], functionSelf: true,
    });
    return name;
  };

  return {
    byValue, byContextSlot, declarations, collisions, globals,
    nameValue, reserve, claim, taken, stats,
    paramNames, placeholderFor, placeholders, declareFunctionSelf,
  };
}

function slotKind(sv) {
  switch (sv.mode) {
    case 'kLet': case 'kUsing': case 'kAwaitUsing': return 'let';
    case 'kConst': return 'const';
    case 'kVar': case 'kDynamic': case 'kDynamicGlobal': case 'kDynamicLocal': return 'var';
    default: return 'let';
  }
}

export default { buildNames, sanitiseIdentifier, BANNED, ORIGINS };
