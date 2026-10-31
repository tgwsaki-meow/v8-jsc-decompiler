// tools/profilegen/torque.mjs
//
// A reader for V8's Torque (.tq) declarations: class/shape/struct/bitfield
// declarations, their annotations, their field lists, and -- the hard part --
// the order in which the Torque compiler creates ClassTypes.
//
// Every rule here is transcribed from the Torque compiler itself rather than
// inferred, because the two tables we need (TORQUE_DEFINED_MAP_ROOT_LIST and
// the generated object layouts) are build artifacts absent from the repository.
// Citations, all at refs/tags/<tag>:
//
//  * grammar -- src/torque/torque-parser.cc
//      `Symbol classField`:
//        annotations ('weak')? ('const')? name ('?')? ('[' expr ']')? ':' type ';'
//      `Symbol declaration` / MakeClassDeclaration:
//        annotations ('extern')? ('transient')? ('class'|'shape') NAME
//        'extends' TYPE ('generates' STRING)? ('{' body '}' | ';')
//      -- `extends` is mandatory; a missing body sets kUndefinedLayout.
//
//  * conditional fields -- src/torque/torque-parser.cc, MakeClassDeclaration:
//      fields are dropped at parse time when an @if(FLAG) flag is false or an
//      @ifnot(FLAG) flag is true. The flag table is `class BuildFlags`, same file.
//
//  * field offsets -- src/torque/type-visitor.cc,
//      TypeVisitor::VisitClassFieldsAndMethods:
//        class_offset = super_class->size();
//        for each field in declaration order: class_offset += field_size;
//      There is no automatic alignment; ValidateAlignment only *checks*.
//
//  * field sizes -- src/torque/types.cc, SizeOf(const Type*).
//
//  * which classes get a map root -- src/torque/instance-type-generator.cc:
//      for (const ClassType* type : TypeOracle::GetClasses())
//        if (type->ShouldGenerateUniqueMap())
//          emit "V(Map, <snakeify(Name)>_map, <Name>Map)"
//      src/torque/types.h ClassType::ShouldGenerateUniqueMap():
//        (flags & kGenerateUniqueMap) || (!IsExtern() && !IsAbstract())
//      src/torque/utils.cc SnakeifyString().
//
//  * the ORDER of TypeOracle::GetClasses() -- this is the subtle one.
//      src/torque/type-oracle.cc returns the ClassTypes of aggregate_types_ in
//      creation order; creation happens inside TypeVisitor::ComputeType, which
//      is driven by PredeclarationVisitor::ResolvePredeclarations() walking
//      every predeclared type alias in declaration order (files in BUILD.gn
//      torque_files order) and resolving it. Resolution is recursive, so a
//      declaration's eagerly-resolved type references are created *before* it:
//        ComputeType(ClassDeclaration*)      -> decl->super only (fields are lazy)
//        ComputeType(TypeAliasDeclaration*)  -> the whole right-hand type expr
//        ComputeType(AbstractTypeDeclaration*) -> its `extends` type
//        ComputeType(StructDeclaration*)     -> every field type, eagerly
//        ComputeType(BitFieldStructDeclaration*) -> parent + every field type
//      That is why FunctionTemplateInfoMap is the *first* Torque map root even
//      though templates.tq is near the end of torque_files: src/builtins/base.tq
//      line 1088 declares `type ... = Context|EmptyString|Symbol|
//      FunctionTemplateInfo|WasmFuncRef|WasmNull;`, and resolving that alias
//      creates FunctionTemplateInfo's ClassType right there.

import { stripComments } from './cpp.mjs';

/** src/torque/utils.cc SnakeifyString: insert '_' at lower->Upper, lowercase all. */
export function snakeify(camel) {
  let out = '';
  let previousWasLower = false;
  for (const ch of camel) {
    if (previousWasLower && ch >= 'A' && ch <= 'Z') out += '_';
    out += ch.toLowerCase();
    previousWasLower = ch >= 'a' && ch <= 'z';
  }
  return out;
}

/**
 * src/torque/torque-parser.cc `class BuildFlags`. The torque binary is built
 * with the same #ifdefs as V8 itself, so these mirror the C++ build config.
 */
export function buildFlags({ taggedSize = 4, intl = true, wasm = true, sandbox = true, debug = false } = {}) {
  return {
    V8_EXTERNAL_CODE_SPACE: false,              // V8_EXTERNAL_CODE_SPACE_BOOL: off on x64 since 12.x
    TAGGED_SIZE_8_BYTES: taggedSize === 8,
    V8_ENABLE_UNDEFINED_DOUBLE: true,           // V8_UNDEFINED_DOUBLE_BOOL
    V8_INTL_SUPPORT: intl,
    V8_ENABLE_SWISS_NAME_DICTIONARY: false,     // V8_ENABLE_SWISS_NAME_DICTIONARY_BOOL
    V8_ENABLE_JAVASCRIPT_PROMISE_HOOKS: false,
    V8_ENABLE_CONTINUATION_PRESERVED_EMBEDDER_DATA: true,
    TRUE_FOR_TESTING: true,
    FALSE_FOR_TESTING: false,
    V8_SCRIPTORMODULE_LEGACY_LIFETIME: false,
    V8_ENABLE_WEBASSEMBLY: wasm,
    WASM_CODE_POINTER_NEEDS_PADDING: wasm ? taggedSize === 8 : false,
    V8_ENABLE_SANDBOX: sandbox,
    DEBUG: debug,
    V8_ENABLE_DRUMBRAKE: false,
  };
}

// --------------------------------------------------------------------- scanning

/** Index of the matching closer for the opener at `open`, skipping literals. */
function matchBrace(s, open, oc = '{', cc = '}') {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length) { if (s[i] === '\\') { i += 2; continue; } if (s[i] === q) break; i++; }
      continue;
    }
    if (c === oc) depth++;
    else if (c === cc) { depth--; if (!depth) return i; }
  }
  return -1;
}

/** Pull the leading `@annotation` / `@annotation(arg)` run off a declaration. */
function takeAnnotations(s) {
  const annotations = [];
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '@') break;
    let j = i + 1;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
    const name = s.slice(i + 1, j);
    let arg = null;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === '(') {
      const close = matchBrace(s, j, '(', ')');
      arg = s.slice(j + 1, close < 0 ? s.length : close).trim();
      j = (close < 0 ? s.length : close) + 1;
    }
    annotations.push({ name, arg });
    i = j;
  }
  return { annotations, rest: s.slice(i) };
}

/**
 * Split a file or namespace body into top-level declarations.
 * Yields {head, body, hasBody} where `head` is everything before the body
 * brace (or before the terminating `;`).
 */
function* topLevelDeclarations(src, base = 0) {
  let i = 0;
  let acc = '';
  let start = 0;
  let depth = 0; // () and [] only
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch; const s0 = i; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      acc += src.slice(s0, i);
      continue;
    }
    if (ch === '(' || ch === '[') { depth++; acc += ch; i++; continue; }
    if (ch === ')' || ch === ']') { depth--; acc += ch; i++; continue; }
    if (ch === ';' && depth === 0) {
      if (acc.trim()) yield { head: acc, body: '', hasBody: false, start: base + start, bodyStart: base + i };
      acc = ''; i++; start = i; continue;
    }
    if (ch === '{' && depth === 0) {
      const close = matchBrace(src, i);
      const end = close < 0 ? src.length : close;
      const head = acc;
      const body = src.slice(i + 1, end);
      const ns = /(?:^|\s)namespace\s+([A-Za-z_]\w*)\s*$/.exec(head.trim());
      if (ns && !/\b(macro|builtin|struct|class|shape|enum)\b/.test(head)) {
        // flatten the namespace: its declarations keep their source order
        yield* topLevelDeclarations(body, base + i + 1);
      } else if (head.trim()) {
        yield { head, body, hasBody: true, start: base + start, bodyStart: base + i + 1 };
      }
      i = end + 1;
      // a `}` may be followed by a `;`
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ';') i++;
      acc = ''; start = i;
      continue;
    }
    acc += ch; i++;
  }
  if (acc.trim()) yield { head: acc, body: '', hasBody: false, start: base + start, bodyStart: base + i };
}

const TORQUE_KEYWORDS = new Set([
  'extern', 'transient', 'class', 'shape', 'struct', 'bitfield', 'type', 'enum', 'const',
  'extends', 'generates', 'constexpr', 'namespace', 'macro', 'builtin', 'runtime', 'intrinsic',
  'operator', 'javascript', 'transitioning', 'implicit', 'js', 'labels', 'weak', 'bit', 'void',
  'never', 'otherwise', 'export', 'import',
]);

/** Type names referenced by a type expression (union members, generic args). */
function typeRefs(typeExpr) {
  if (!typeExpr) return [];
  const out = [];
  for (const m of typeExpr.matchAll(/[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/g)) {
    const id = m[0].replace(/\s+/g, '');
    const last = id.includes('::') ? id.split('::').pop() : id;
    if (!TORQUE_KEYWORDS.has(last)) out.push(last);
  }
  return out;
}

/** Split a class/struct body into `;`-terminated statements, skipping methods. */
function bodyStatements(body) {
  const out = [];
  for (const d of topLevelDeclarations(body)) {
    if (d.hasBody) continue;            // a method with a body
    const lead = d.head.length - d.head.trimStart().length;
    out.push({ text: d.head.trim(), start: d.start + lead });
  }
  return out;
}

/**
 * Parse one class-body statement as a field.
 *
 * This follows the grammar instead of guessing, because guessing is what lost
 * three ScopeInfo fields: the previous reader rejected any statement
 * containing a '(' as "a method signature", and Torque index/condition
 * expressions routinely contain a cast call
 * (`Convert<intptr>(context_local_count)`,
 * `FromConstexpr<VariableAllocationInfo>(VariableAllocationInfo::NONE)`).
 * Those are interior fields, so dropping them shifted every later offset.
 *
 * src/torque/torque-parser.cc, `Symbol classField`:
 *   annotations ('weak')? ('const')? name ('?')? ('[' expression ']')? ':' type ';'
 *
 * @returns {{field: object}|{skip: string, fieldShaped: boolean}}
 */
function parseFieldStatement(stmt) {
  const { annotations, rest } = takeAnnotations(stmt);
  let s = rest.trim();
  let weak = false;
  let konst = false;
  for (;;) {
    const q = /^(weak|const)\s+/.exec(s);
    if (!q) break;
    if (q[1] === 'weak') weak = true; else konst = true;
    s = s.slice(q[0].length);
  }
  const nm = /^([A-Za-z_]\w*)/.exec(s);
  if (!nm) return { skip: 'does not begin with a field name', fieldShaped: false };
  const name = nm[1];
  let i = nm[0].length;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  skipWs();
  let optional = false;
  if (s[i] === '?') { optional = true; i++; skipWs(); }
  let indexExpr = null;
  if (s[i] === '[') {
    const close = matchBrace(s, i, '[', ']');
    if (close < 0) return { skip: 'unbalanced [ in the index expression', fieldShaped: true };
    indexExpr = s.slice(i + 1, close).trim().replace(/\s+/g, ' ');
    i = close + 1;
    skipWs();
  }
  // Only `name:`, `name?[...]:` and `name[...]:` are fields. Anything else at
  // this point is a macro / method / operator declaration.
  if (s[i] !== ':') {
    const shaped = optional || indexExpr !== null;
    return {
      skip: shaped ? `expected ':' after the field name, found ${JSON.stringify(s.slice(i, i + 12))}` : 'not a field declaration',
      fieldShaped: shaped,
    };
  }
  const type = s.slice(i + 1).trim().replace(/\s+/g, ' ');
  if (!type) return { skip: 'empty field type', fieldShaped: true };
  // `const kFoo: constexpr int32 generates 'kBar';` is a Torque constant, not
  // an object field: it occupies no space in the object.
  if (/^constexpr\b/.test(type)) return { skip: 'a Torque constexpr constant, not an object field', fieldShaped: false };
  return {
    field: {
      name,
      type,
      weak,
      const: konst,
      optional,
      indexExpr,
      annotations,
    },
  };
}

/** Split a Torque list on top-level commas (`Slot<Context, ScopeInfo>` is one item). */
function splitTopLevelCommas(body) {
  const out = [];
  let cur = '';
  let angle = 0, round = 0, square = 0, curly = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"') {
      const q = c; cur += c; i++;
      while (i < body.length) { cur += body[i]; if (body[i] === q) break; i++; }
      continue;
    }
    if (c === '<') angle++;
    else if (c === '>') { if (angle > 0) angle--; }
    else if (c === '(') round++;
    else if (c === ')') round--;
    else if (c === '[') square++;
    else if (c === ']') square--;
    else if (c === '{') curly++;
    else if (c === '}') curly--;
    else if (c === ',' && !angle && !round && !square && !curly) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Field/bitfield-level @if / @ifnot filter (MakeClassDeclaration's std::copy_if). */
function conditionsHold(annotations, flags, unknown) {
  for (const a of annotations) {
    if (a.name === 'if' || a.name === 'ifnot') {
      if (!(a.arg in flags)) { unknown.add(a.arg); continue; }
      if (a.name === 'if' ? !flags[a.arg] : flags[a.arg]) return false;
    }
  }
  return true;
}

const CLASS_HEAD_RE = /^(extern\s+)?(transient\s+)?(class|shape)\s+([A-Za-z_]\w*)\s+extends\s+([\s\S]+?)(\s+generates\s+'[^']*')?$/;

/**
 * Parse one .tq file into an ordered list of type declarations.
 * Each entry: {kind, name, deps[], ...}. `deps` are the type names that Torque
 * resolves eagerly when it computes this declaration's type.
 */
export function parseTq(text, { file = '<tq>', flags = buildFlags(), unknownFlags = new Set(), skipped = [] } = {}) {
  // Torque's only preprocessor directive is `#include 'path'`, which does not
  // end in `;` and would otherwise be glued onto the head of the next
  // declaration (that is how `class String` went missing the first time).
  const src = stripComments(text).replace(/^[ \t]*#include[ \t]+'[^']*'[ \t]*$/gm, '');
  const decls = [];

  // Line numbers, so that anything this reader cannot parse can be reported
  // with a source location instead of vanishing. stripComments preserves line
  // breaks, so these are the line numbers of the original file.
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const note = (container, start, statement, reason) => {
    skipped.push({
      file,
      line: lineOf(start),
      container,
      statement: statement.replace(/\s+/g, ' ').slice(0, 160),
      reason,
    });
  };

  for (const d of topLevelDeclarations(src)) {
    const { annotations, rest } = takeAnnotations(d.head);
    const head = rest.replace(/\s+/g, ' ').trim();
    if (!head) continue;
    if (!conditionsHold(annotations, flags, unknownFlags)) continue;  // @if on a declaration
    const annNames = new Set(annotations.map((a) => a.name));

    // class / shape
    let m = CLASS_HEAD_RE.exec(head);
    if (m) {
      const [, isExtern, transient, kind, name, parentExpr] = m;
      const fields = [];
      const droppedFields = [];
      for (const stmt of bodyStatements(d.body)) {
        const r = parseFieldStatement(stmt.text);
        if (r.skip) {
          // A statement that looks like a field but did not parse is a silent
          // layout corruption waiting to happen, so it is reported with its
          // location. Method and macro declarations are not field-shaped and
          // are not reported.
          if (r.fieldShaped) note(`class ${name}`, d.bodyStart + stmt.start, stmt.text, r.skip);
          continue;
        }
        const f = r.field;
        if (!conditionsHold(f.annotations, flags, unknownFlags)) {
          // Record it: a build-config-gated field that is absent under the
          // chosen config shifts every offset after it, so the decision has to
          // be visible in the profile rather than implied by its absence.
          droppedFields.push({
            name: f.name,
            type: f.type,
            conditions: f.annotations.filter((a) => a.name === 'if' || a.name === 'ifnot')
              .map((a) => ({ sense: a.name, flag: a.arg, value: flags[a.arg] })),
          });
          continue;
        }
        fields.push(f);
      }
      decls.push({
        droppedFields,
        kind: 'class',
        name,
        parent: parentExpr.trim(),
        deps: typeRefs(parentExpr),
        isExtern: !!isExtern,
        transient: !!transient || kind === 'shape',
        isShape: kind === 'shape',
        abstract: annNames.has('abstract'),
        generateUniqueMap: annNames.has('generateUniqueMap'),
        cppObjectDefinition: annNames.has('cppObjectDefinition'),
        cppObjectLayoutDefinition: annNames.has('cppObjectLayoutDefinition'),
        hasBody: d.hasBody,
        annotations,
        fields,
        file,
      });
      continue;
    }

    // bitfield struct
    m = /^bitfield struct ([A-Za-z_]\w*) extends ([A-Za-z_]\w*)$/.exec(head);
    if (m) {
      const fields = [];
      let bit = 0;
      for (const stmt of bodyStatements(d.body)) {
        const { annotations: fa, rest: fr } = takeAnnotations(stmt.text);
        if (!conditionsHold(fa, flags, unknownFlags)) continue;
        const fm = /^([A-Za-z_]\w*)\s*:\s*([^:]+?)\s*:\s*(\d+)\s*bit$/.exec(fr.trim().replace(/\s+/g, ' '));
        if (!fm) {
          note(`bitfield struct ${m[1]}`, d.bodyStart + stmt.start, stmt.text, 'not a `name: type: N bit` member');
          continue;
        }
        fields.push({ name: fm[1], type: fm[2].trim(), bits: Number(fm[3]), offset: bit });
        bit += Number(fm[3]);
      }
      decls.push({ kind: 'bitfield', name: m[1], base: m[2], deps: [m[2], ...fields.flatMap((f) => typeRefs(f.type))], fields, totalBits: bit, file });
      continue;
    }

    // struct (generic structs are not resolved during predeclaration)
    m = /^struct ([A-Za-z_]\w*)\s*(<[^>]*>)?$/.exec(head);
    if (m) {
      const fields = [];
      for (const stmt of bodyStatements(d.body)) {
        const r = parseFieldStatement(stmt.text);
        if (r.skip) {
          if (r.fieldShaped) note(`struct ${m[1]}`, d.bodyStart + stmt.start, stmt.text, r.skip);
          continue;
        }
        if (conditionsHold(r.field.annotations, flags, unknownFlags)) fields.push(r.field);
      }
      decls.push({
        kind: 'struct', name: m[1], generic: !!m[2], fields, file,
        deps: m[2] ? [] : fields.flatMap((f) => typeRefs(f.type)),
      });
      continue;
    }

    // type alias:  type X = EXPR;
    m = /^type ([A-Za-z_]\w*) = ([\s\S]+)$/.exec(head);
    if (m) { decls.push({ kind: 'alias', name: m[1], deps: typeRefs(m[2]), file }); continue; }

    // abstract type:  (transient)? type X (<...>)? (extends Y)? (generates '..')? (constexpr '..')?
    m = /^(transient )?type ([A-Za-z_]\w*)\s*(<[^>]*>)?(?: extends ([A-Za-z_][\w:]*))?(?: generates '[^']*')?(?: constexpr '[^']*')?$/.exec(head);
    if (m) { decls.push({ kind: 'abstract-type', name: m[2], deps: m[4] ? typeRefs(m[4]) : [], generic: !!m[3], file }); continue; }

    // enum:  (extern)? enum X (extends Y)? (constexpr '..')? { ... }
    m = /^(extern )?enum ([A-Za-z_]\w*)(?: extends ([A-Za-z_][\w:]*))?(?: constexpr '[^']*')?$/.exec(head);
    if (m) {
      // src/torque/torque-parser.cc, `Symbol enumDeclaration`: a member is
      //   name (':' type)? (',' | '...' )
      // so the member list has to be split on *top-level* commas -- a
      // `Slot<Context, ScopeInfo>` type contains one of its own. Splitting on
      // every comma and then dropping the halves that are not bare identifiers
      // is how enums.ContextSlot came out as `{MIN_CONTEXT_SLOTS: 0}`:
      // 78 members became 1, and the one that survived was renumbered to 0.
      //
      // The ordinals recorded here are Torque *declaration positions*. For an
      // `extern enum` they are not the values: C++ owns those (see
      // gen/cppenums.mjs, which overrides them and records the disagreement).
      const members = {};
      const memberTypes = {};
      let open = false;
      let next = 0;
      for (const piece of splitTopLevelCommas(d.body)) {
        const p = piece.trim().replace(/\s+/g, ' ');
        if (!p) continue;
        if (p === '...' || p.startsWith('...')) { open = true; continue; }
        const em = /^([A-Za-z_]\w*)(?:\s*:\s*([\s\S]+))?$/.exec(p);
        if (!em) {
          note(`enum ${m[2]}`, d.bodyStart, p, 'not a `NAME` or `NAME: type` enum member');
          continue;
        }
        members[em[1]] = next++;
        memberTypes[em[1]] = em[2] ? em[2].trim() : null;
      }
      decls.push({
        kind: 'enum', name: m[2], base: m[3] ?? null, open, members, memberTypes,
        isExtern: !!m[1], deps: m[3] ? typeRefs(m[3]) : [], file,
      });
      continue;
    }

    // `const kFoo: constexpr int32 generates 'kBar';` -- a Torque alias for a
    // C++ constant. ScopeInfo's `context_local_names` count expression is
    // written in terms of one of these (kMaxInlinedLocalNamesSize), so the
    // mapping has to travel with the layout program.
    m = /^const ([A-Za-z_]\w*)\s*:\s*constexpr ([\w:]+) generates '([^']+)'$/.exec(head);
    if (m) { decls.push({ kind: 'generates-const', name: m[1], cppType: m[2], cppName: m[3], deps: [], file }); continue; }
  }
  return decls;
}

// ------------------------------------------------------------ the class universe

/** src/torque/types.h ClassType::ShouldGenerateUniqueMap(). */
export function shouldGenerateUniqueMap(c) {
  return c.generateUniqueMap || (!c.isExtern && !c.abstract);
}

/**
 * Reproduce TypeOracle::GetClasses() order: walk every predeclared type alias
 * in declaration order and resolve it, resolving each declaration's eager type
 * references first. ClassTypes are emitted at creation time.
 */
export function orderClasses(allDecls) {
  // Only type declarations are predeclared; a `const ... generates '...'` is a
  // value, so it takes no part in type resolution and must not shadow a type
  // of the same name in the lookup table.
  const types = allDecls.filter((d) => d.kind !== 'generates-const');
  const byName = new Map();
  for (const d of types) if (!byName.has(d.name)) byName.set(d.name, d);
  const out = [];
  const state = new Map();
  const visit = (d) => {
    if (state.has(d.name)) return;
    state.set(d.name, 'doing');
    for (const dep of d.deps ?? []) {
      const t = byName.get(dep);
      if (t && t !== d && !state.has(t.name)) visit(t);
    }
    if (d.kind === 'class') out.push(d);
  };
  for (const d of types) {
    if (d.generic) continue;            // generics are instantiated, not predeclared
    visit(d);
  }
  return out;
}

/**
 * The TORQUE_DEFINED_MAP_ROOT_LIST body, as `{type, name, CamelName}` triples:
 * `V(Map, <snake>_map, <Name>Map)`.
 */
export function torqueDefinedMapRootList(orderedClasses) {
  return orderedClasses
    .filter(shouldGenerateUniqueMap)
    .map((c) => ({ type: 'Map', name: `${snakeify(c.name)}_map`, CamelName: `${c.name}Map`, torqueClass: c.name, file: c.file }));
}

/** Read `torque_files` out of BUILD.gn, honouring its GN conditionals. */
export function torqueFileList(buildGn, { intl = true, wasm = true, temporal = false } = {}) {
  const t = buildGn;
  const start = t.indexOf('torque_files = [');
  if (start < 0) throw new Error('BUILD.gn: torque_files not found');
  const end = t.indexOf('\n]', start);
  const files = [...t.slice(start, end).matchAll(/"([^"]+\.tq)"/g)].map((m) => m[1]);

  const re = /torque_files\s*\+=\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const before = t.slice(0, m.index);
    const guards = [...before.matchAll(/^\s*if\s*\(([^)]*)\)\s*\{\s*$/gm)];
    const guard = guards.length ? guards[guards.length - 1][1].trim() : '';
    const add = [...m[1].matchAll(/"([^"]+\.tq)"/g)].map((x) => x[1]);
    let on = null;
    if (/v8_enable_i18n_support/.test(guard)) on = intl;
    else if (/v8_enable_temporal_support/.test(guard)) on = temporal;
    else if (/v8_enable_webassembly/.test(guard)) on = wasm;
    if (on === null) throw new Error(`BUILD.gn: unmodelled guard for torque_files += [...]: "${guard}"`);
    if (on) files.push(...add);
  }
  return files;
}

// ------------------------------------------------------------------- field sizes

/** The container width of a `bitfield struct X extends uintN`. */
const BITFIELD_BASE_SIZE = { uint8: 1, uint16: 2, uint31: 4, uint32: 4, uint64: 8, int31: 4, int32: 4, bool: 1 };

/**
 * src/torque/types.cc SizeOf(const Type*), resolved against a size table.
 * `structs` and `bitfields` are name -> declaration maps; a bitfield struct has
 * the size of the integer type it extends, not of a tagged slot.
 */
export function torqueFieldSize(type, sizes, structs = new Map(), bitfields = new Map()) {
  const t = String(type).replace(/\s+/g, '');
  const base = t.split('|')[0];                 // a union of tagged types is tagged
  const generic = /^([A-Za-z_]\w*)</.exec(base);
  const head = (generic ? generic[1] : base).replace(/^.*::/, '');

  switch (head) {
    case 'void': return { size: 0, sizeName: '0', kind: 'void' };
    case 'RawPtr': case 'intptr': case 'uintptr':
      return { size: sizes.kSystemPointerSize, sizeName: 'kSystemPointerSize', kind: 'raw' };
    case 'ExternalPointer':
      return { size: sizes.kExternalPointerSlotSize, sizeName: 'kExternalPointerSlotSize', kind: 'external' };
    case 'CppHeapPointer':
      return { size: sizes.kCppHeapPointerSlotSize, sizeName: 'kCppHeapPointerSlotSize', kind: 'cppheap' };
    case 'TrustedPointer': case 'IndirectPointer':
      return { size: sizes.kTrustedPointerSize, sizeName: 'kTrustedPointerSize', kind: 'trusted' };
    case 'ProtectedPointer':
      return { size: sizes.kTaggedSize, sizeName: 'kTaggedSize', kind: 'protected' };
    case 'int8': case 'uint8': case 'bool': case 'char8':
      return { size: 1, sizeName: 'kUInt8Size', kind: 'int' };
    case 'int16': case 'uint16': case 'char16':
      return { size: 2, sizeName: 'kUInt16Size', kind: 'int' };
    case 'int32': case 'uint32': case 'int31': case 'uint31': case 'bint':
      return { size: 4, sizeName: 'kInt32Size', kind: 'int' };
    case 'float64': case 'float64_or_undefined_or_hole': case 'float64_or_hole':
      return { size: 8, sizeName: 'kDoubleSize', kind: 'float' };
    case 'float32':
      return { size: 4, sizeName: 'kFloat32Size', kind: 'float' };
    case 'JSDispatchHandle':
      return { size: sizes.kJSDispatchHandleSize ?? 4, sizeName: 'kJSDispatchHandleSize', kind: 'dispatch' };
    case 'CodePointer':
      return { size: sizes.kCodePointerSize ?? 4, sizeName: 'kCodePointerSize', kind: 'code' };
    default: break;
  }
  if (bitfields.has(head)) {
    const b = bitfields.get(head);
    const size = BITFIELD_BASE_SIZE[b.base] ?? sizes.kTaggedSize;
    return { size, sizeName: `sizeof(${b.base})`, kind: 'bitfield', bitfield: head };
  }
  if (structs.has(head)) {
    const st = structs.get(head);
    let total = 0;
    for (const f of st.fields) total += torqueFieldSize(f.type, sizes, structs, bitfields).size;
    return { size: total, sizeName: String(total), kind: 'struct', struct: head };
  }
  // SmiTagged<X>, Weak<X>, and every class or union name are one tagged slot
  return { size: sizes.kTaggedSize, sizeName: 'kTaggedSize', kind: 'tagged' };
}
