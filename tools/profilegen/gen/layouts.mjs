// tools/profilegen/gen/layouts.mjs
//
// Object layouts, from both of V8's two layout mechanisms, plus the bitfield
// structs that the conditional layouts are predicated on.
//
// Mechanism 1 -- hand-written FIELD_LIST + DEFINE_FIELD_OFFSET_CONSTANTS
//   src/utils/utils.h:
//     #define DEFINE_ONE_FIELD_OFFSET(Name, Size, ...) Name, Name##End = Name + (Size)-1,
//     #define DEFINE_FIELD_OFFSET_CONSTANTS(StartOffset, LIST_MACRO) \
//       enum { LIST_MACRO##_StartOffset = StartOffset - 1, LIST_MACRO(DEFINE_ONE_FIELD_OFFSET) };
//   It is a plain C enum, so offset(f[k+1]) = offset(f[k]) + size(f[k]) seeded at
//   StartOffset, with no automatic alignment -- padding is an explicit
//   zero-named field sized OBJECT_POINTER_PADDING(...).
//
// Mechanism 2 -- Torque .tq field lists
//   src/torque/type-visitor.cc VisitClassFieldsAndMethods: the same running-sum
//   rule seeded at the parent class's size. Sizes come from
//   src/torque/types.cc SizeOf(). See torque.mjs for the citations.
//
// For classes whose layout is data-dependent (ScopeInfo above all) a flat
// offset table is simply wrong, so we emit a *layout program*: the ordered
// field list, each field's size, and each field's presence condition expressed
// against the object's own bitfields -- together with the bitfield and enum
// tables needed to evaluate those conditions.

import { Cpp, collectCalls, evalIntExpr, matchParen } from '../cpp.mjs';
import { torqueFieldSize, snakeify } from '../torque.mjs';

/** Classes whose layout the .jsc pipeline needs. */
export const REQUIRED_CLASSES = [
  'SharedFunctionInfo',
  'BytecodeArray', 'BytecodeWrapper',
  'ScopeInfo',
  'FixedArrayBase', 'FixedArray', 'TrustedFixedArray', 'ProtectedFixedArray',
  'ByteArray', 'TrustedByteArray',
  'ObjectBoilerplateDescription', 'ArrayBoilerplateDescription',
  'RegExpBoilerplateDescription', 'TemplateObjectDescription',
  'UncompiledData',
  'UncompiledDataWithoutPreparseData', 'UncompiledDataWithPreparseData',
  'UncompiledDataWithoutPreparseDataWithJob', 'UncompiledDataWithPreparseDataAndJob',
  'PreparseData',
  'FeedbackMetadata', 'FeedbackVector', 'FeedbackCell',
  'Script', 'HeapNumber',
  'String', 'SeqString', 'SeqOneByteString', 'SeqTwoByteString',
  'ConsString', 'SlicedString', 'ThinString', 'ExternalString',
  'Name', 'HeapObject', 'TrustedObject', 'ExposedTrustedObject', 'Struct',
  'PrimitiveHeapObject', 'Oddball', 'Hole', 'Symbol', 'Map',
];

/** Bitfield structs the layout conditions and the SFI flags need. */
export const REQUIRED_BITFIELDS = [
  'ScopeFlags', 'VariableProperties',
  'SharedFunctionInfoFlags', 'SharedFunctionInfoFlags2',
  'JSRegExpFlags',
];

/** C++ headers that may carry a FIELD_LIST for one of the required classes. */
export const LAYOUT_HEADERS = [
  'src/objects/bytecode-array.h',
  'src/objects/shared-function-info.h',
  'src/objects/scope-info.h',
  'src/objects/fixed-array.h',
  'src/objects/literal-objects.h',
  'src/objects/template-objects.h',
  'src/objects/js-regexp.h',
  'src/objects/feedback-vector.h',
  'src/objects/script.h',
  'src/objects/heap-number.h',
  'src/objects/string.h',
  'src/objects/name.h',
  'src/objects/heap-object.h',
  'src/objects/trusted-object.h',
  'src/objects/struct.h',
  'src/objects/objects.h',
];

// --------------------------------------------------------------- expression AST

/** A tiny parser for Torque condition / index expressions. */
export function parseExpression(text) {
  if (text === null || text === undefined) return null;
  const toks = [];
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9a-fA-FxX]/.test(s[j])) j++;
      toks.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '::'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    toks.push({ t: 'op', v: c }); i++;
  }
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { if (toks[p] && toks[p].v === v) { p++; return true; } return false; };

  function primary() {
    const t = toks[p];
    if (!t) return null;
    if (t.v === '(') { p++; const e = ternary(); eat(')'); return e; }
    if (t.v === '!') { p++; return { kind: 'not', arg: primary() }; }
    if (t.v === '-') { p++; const a = primary(); return { kind: 'neg', arg: a }; }
    if (t.t === 'num') { p++; return { kind: 'literal', value: t.v }; }
    if (t.t === 'id') {
      p++;
      // A call form: `Convert<intptr>(x)`, `FromConstexpr<T>(T::K)`, `f(x)`.
      // Torque's Convert/FromConstexpr are representation casts -- they change
      // the static type and never the value -- so the layout arithmetic is the
      // expression inside. The node keeps the cast visible rather than
      // silently dropping it; src/heap/layout.mjs evaluates `cast` as its
      // argument. Getting this wrong (or, as before, refusing to parse the
      // field at all) is what lost three ScopeInfo fields.
      if (peek() && peek().v === '<') {
        const save = p;
        let depth = 0;
        const parts = [];
        while (p < toks.length) {
          const g = toks[p].v;
          p++;
          if (g === '<') { depth++; if (depth === 1) continue; }
          else if (g === '>') { depth--; if (depth === 0) break; }
          parts.push(String(g));
        }
        if (depth === 0 && peek() && peek().v === '(') {
          p++;
          const arg = ternary();
          eat(')');
          return { kind: 'cast', castTo: parts.join(''), via: t.v, expr: arg };
        }
        p = save;        // `a < b`, a comparison after all
      } else if (peek() && peek().v === '(') {
        p++;
        const arg = ternary();
        eat(')');
        return { kind: 'cast', castTo: null, via: t.v, expr: arg };
      }
      let node = { kind: 'name', name: t.v };
      for (;;) {
        if (peek() && peek().v === '::' && toks[p + 1]?.t === 'id') {
          node = { kind: 'enumRef', enum: node.kind === 'name' ? node.name : node.enum, member: toks[p + 1].v };
          p += 2; continue;
        }
        if (peek() && peek().v === '.' && toks[p + 1]?.t === 'id') {
          node = { kind: 'member', object: node, field: toks[p + 1].v };
          p += 2; continue;
        }
        break;
      }
      return node;
    }
    p++;
    return null;
  }
  const PREC = { '*': 7, '/': 7, '%': 7, '+': 6, '-': 6, '<': 5, '>': 5, '<=': 5, '>=': 5, '==': 4, '!=': 4, '&&': 2, '||': 1 };
  function binary(min) {
    let lhs = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || PREC[t.v] === undefined || PREC[t.v] < min) break;
      p++;
      const rhs = binary(PREC[t.v] + 1);
      lhs = { kind: 'binary', op: t.v, left: lhs, right: rhs };
    }
    return lhs;
  }
  function ternary() {
    const c = binary(1);
    if (peek() && peek().v === '?') {
      p++;
      const a = ternary();
      eat(':');
      const b = ternary();
      return { kind: 'ternary', cond: c, then: a, else: b };
    }
    return c;
  }
  const ast = ternary();
  return { expr: String(text), ast };
}

// -------------------------------------------------------- mechanism 1: FIELD_LIST

/** Which class encloses the character offset `at` in a C++ header? */
function enclosingClass(text, at) {
  const head = text.slice(0, at);
  const matches = [...head.matchAll(/\bclass\s+(?:V8_EXPORT_PRIVATE\s+|V8_OBJECT\s+)?([A-Za-z_]\w*)\b[^;{]*[{:]/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/**
 * Expand the FIELD_LIST macros reachable from DEFINE_FIELD_OFFSET_CONSTANTS and
 * accumulate offsets. `anchorValues` maps `Class::kHeaderSize` -> number.
 */
export function deriveFieldLists(headerText, headerPath, cpp, sizes, anchorValues) {
  const out = [];
  let buffer = '';
  let scanPos = 0;

  const expandAt = (anchorExpr, listName, atIndex) => {
    if (!cpp.macros.has(listName)) return;
    let calls;
    try { calls = cpp.expandList(`${listName}(V)`, 'V'); } catch { return; }

    const anchorName = anchorExpr.replace(/\s+/g, '');
    const anchorValue = anchorValues[anchorName] ?? (/^\d+$/.test(anchorName) ? Number(anchorName) : null);

    let rel = 0;
    const fields = [];
    const unresolved = [];
    for (const a of calls) {
      if (a.length < 2) continue;
      const name = a[0].trim();
      const sizeExpr = a[1].trim();
      let size = null;
      const pad = /^(OBJECT_POINTER_PADDING|POINTER_SIZE_PADDING)\s*\(/.exec(sizeExpr);
      if (pad) {
        const align = pad[1] === 'OBJECT_POINTER_PADDING' ? (sizes.kObjectAlignment ?? 8) : (sizes.kSystemPointerSize ?? 8);
        const abs = (anchorValue ?? 0) + rel;
        size = (align - (abs % align)) % align;
      } else {
        const { value, unknown } = evalIntExpr(sizeExpr, sizes);
        if (unknown.length) { unresolved.push(`${name}: ${sizeExpr} (unknown ${unknown.join(',')})`); size = null; }
        else size = value;
      }
      fields.push({ name, sizeExpr, size, relativeOffset: rel, offset: anchorValue === null ? null : anchorValue + rel });
      rel += size ?? 0;
    }
    out.push({
      list: listName,
      anchor: anchorName,
      anchorValue,
      ownerClass: enclosingClass(buffer, atIndex),
      header: headerPath,
      fields,
      endRelative: rel,
      unresolved,
    });
  };

  cpp.run(headerText, {
    label: headerPath,
    onLine: (line) => {
      buffer += line + '\n';
      for (;;) {
        const idx = buffer.indexOf('DEFINE_FIELD_OFFSET_CONSTANTS', scanPos);
        if (idx < 0) return;
        const open = buffer.indexOf('(', idx);
        if (open < 0) return;
        const close = matchParen(buffer, open);
        if (close < 0) return;                 // the call spans more lines yet
        const args = buffer.slice(open + 1, close).split(',').map((x) => x.trim());
        if (args.length >= 2) expandAt(args[0], args[1], idx);
        scanPos = close + 1;
      }
    },
  });
  return out;
}

// ---------------------------------------------------- mechanism 2: Torque layout

/**
 * Compute Torque layouts for every parsed class, in inheritance order.
 * Returns `{ layouts: Map<name, layout>, order: string[] }`.
 */
export function computeTorqueLayouts(classDecls, sizes, structs, bitfields = new Map()) {
  const byName = new Map();
  for (const c of classDecls) if (!byName.has(c.name)) byName.set(c.name, c);

  const layouts = new Map();
  const visiting = new Set();

  const compute = (c) => {
    if (layouts.has(c.name)) return layouts.get(c.name);
    if (visiting.has(c.name)) return null;
    visiting.add(c.name);

    const parentName = (c.parent || '').replace(/\s+/g, '');
    const parent = byName.get(parentName);
    const parentLayout = parent && parent !== c ? compute(parent) : null;
    // StrongTagged / Tagged are the roots of the hierarchy and contribute nothing
    const start = parentLayout ? parentLayout.size : 0;
    const startKnown = parentLayout ? parentLayout.sizeKnown : true;

    let offset = start;
    let known = startKnown;
    let headerSize = start;
    const fields = [];

    for (const f of c.fields) {
      const sz = torqueFieldSize(f.type, sizes, structs, bitfields);
      const entry = {
        name: f.name,
        type: f.type,
        kind: sz.kind,
        size: sz.size,
        sizeName: sz.sizeName,
        const: f.const,
        weak: f.weak,
        offset: known ? offset : null,
        relativeOffset: known ? offset - start : null,
        present: true,
      };
      if (f.optional) {
        // `name?[cond]: T` -- present only when cond holds; everything after it
        // is data-dependent (Torque models it as an index of unknown length).
        entry.present = 'conditional';
        entry.condition = parseExpression(f.indexExpr);
        known = false;
      } else if (f.indexExpr !== null) {
        entry.indexed = true;
        entry.elementSize = sz.size;
        entry.count = parseExpression(f.indexExpr);
        const lit = /^\d+$/.test(f.indexExpr) ? Number(f.indexExpr) : null;
        if (lit !== null) { offset += sz.size * lit; entry.totalSize = sz.size * lit; }
        else known = false;
      } else {
        offset += sz.size;
      }
      if (known) headerSize = offset;
      fields.push(entry);
    }
    // the whole object is OBJECT_POINTER_ALIGNed, but header_size is not
    const layout = {
      name: c.name,
      source: c.file,
      parent: parentName,
      parentSize: start,
      parentSizeKnown: startKnown,
      isExtern: c.isExtern,
      abstract: c.abstract,
      isShape: c.isShape,
      hasBody: c.hasBody,
      fields,
      droppedFields: c.droppedFields ?? [],
      headerSize: known || fields.length === 0 ? headerSize : headerSize,
      size: known ? offset : null,
      sizeKnown: known,
      variableLength: !known,
    };
    layouts.set(c.name, layout);
    visiting.delete(c.name);
    return layout;
  };

  for (const c of classDecls) compute(c);
  return layouts;
}

// ------------------------------------------------------------------- cross-check

/** `kSourcePositionTableOffset` -> `source_position_table` */
function fieldListNameToTorque(name) {
  let n = name.replace(/^k/, '').replace(/Offset$/, '');
  return snakeify(n);
}

export function crossCheckLayout(torqueLayout, fieldList) {
  if (!torqueLayout || !fieldList) return null;
  if (!torqueLayout.hasBody) {
    // `extern class X extends Y;` with no body is ClassFlag::kUndefinedLayout:
    // Torque knows the type but not the layout, and the FIELD_LIST in the .h is
    // the only description. There is nothing to cross-check.
    return { ok: true, compared: 0, mismatches: [], skipped: 'torque declares no layout (extern class without a body)' };
  }
  const tq = new Map();
  for (const f of torqueLayout.fields) if (f.relativeOffset !== null) tq.set(f.name, f.relativeOffset);
  const mismatches = [];
  let compared = 0;
  for (const f of fieldList.fields) {
    const key = fieldListNameToTorque(f.name);
    if (!tq.has(key)) continue;
    compared++;
    if (tq.get(key) !== f.relativeOffset) {
      mismatches.push({ field: key, fieldList: f.relativeOffset, torque: tq.get(key) });
    }
  }
  // kHeaderSize must equal the Torque header size measured from the same anchor
  const hdr = fieldList.fields.find((f) => f.name === 'kHeaderSize');
  const torqueHeaderRelative = torqueLayout.headerSize - torqueLayout.parentSize;
  if (hdr) {
    compared++;
    if (hdr.relativeOffset !== torqueHeaderRelative) {
      mismatches.push({ field: 'kHeaderSize', fieldList: hdr.relativeOffset, torque: torqueHeaderRelative });
    }
  }
  return { ok: mismatches.length === 0 && compared > 0, compared, mismatches };
}

// ------------------------------------------------------------------------ driver

export async function deriveLayouts(src, {
  defines, sizes, taggedSize, classDecls, bitfieldDecls, structDecls, enumDecls,
  generatesConstDecls = [], cppEnums = {}, functionKindGroups = {}, globals = {},
  classes = REQUIRED_CLASSES,
}) {
  const structs = new Map(structDecls.map((s) => [s.name, s]));
  const bitfieldMap = new Map(bitfieldDecls.map((b) => [b.name, b]));
  const torqueLayouts = computeTorqueLayouts(classDecls, sizes, structs, bitfieldMap);

  // Class::kHeaderSize anchors, taken from the Torque hierarchy
  const anchorValues = { '0': 0 };
  for (const [name, l] of torqueLayouts) {
    if (l.headerSize !== null) {
      anchorValues[`${name}::kHeaderSize`] = l.headerSize;
      anchorValues[`${name}::kSize`] = l.size ?? l.headerSize;
    }
  }
  // FixedArrayBase and friends define kHeaderSize as a plain constant in the .h;
  // Torque agrees, so the anchor table above covers both spellings.

  const cpp = new Cpp(defines);
  const fieldListsByClass = new Map();
  const headerUnresolved = [];
  for (const p of LAYOUT_HEADERS) {
    const f = await src.get(p, { optional: true });
    if (!f.text) continue;
    let lists;
    try { lists = deriveFieldLists(f.text, p, cpp, sizes, anchorValues); } catch (e) { headerUnresolved.push(`${p}: ${e.message}`); continue; }
    for (const l of lists) {
      if (l.unresolved.length) headerUnresolved.push(...l.unresolved.map((u) => `${p} ${l.list}: ${u}`));
      const owner = l.ownerClass;
      if (owner && !fieldListsByClass.has(owner)) fieldListsByClass.set(owner, l);
    }
  }

  const out = {};
  const missing = [];
  for (const name of classes) {
    const tq = torqueLayouts.get(name) ?? null;
    const fl = fieldListsByClass.get(name) ?? null;
    if (!tq && !fl) { missing.push(name); continue; }

    // When Torque declares no layout, the hand-written FIELD_LIST *is* the
    // layout, so promote it into the same field-program shape.
    const useFieldList = fl && (!tq || !tq.hasBody);
    let fields = tq ? tq.fields : [];
    let headerSize = tq ? tq.headerSize : null;
    let size = tq ? tq.size : null;
    let sizeKnown = tq ? tq.sizeKnown : false;
    if (useFieldList) {
      const base = fl.anchorValue ?? 0;
      fields = fl.fields
        .filter((f) => !/^kUnalignedHeaderSize$|^kHeaderSize$|^kSize$/.test(f.name))
        .map((f) => ({
          name: snakeify(f.name.replace(/^k/, '').replace(/Offset$/, '')),
          cppName: f.name,
          type: null,
          kind: 'fieldList',
          size: f.size,
          sizeName: f.sizeExpr,
          offset: base + f.relativeOffset,
          relativeOffset: f.relativeOffset,
          present: true,
        }));
      const hdr = fl.fields.find((f) => f.name === 'kHeaderSize');
      headerSize = base + (hdr ? hdr.relativeOffset : fl.endRelative);
      size = headerSize;
      sizeKnown = true;
    }

    // Torque's ClassType::ComputeAllFields(): the parent's fields then our own.
    // `fields` above holds only the class's *own* declarations, which is what
    // Torque stores, so flatten the chain for callers that want the whole object.
    const allFields = [];
    const chain = [];
    if (tq) {
      for (let cur = tq; cur; cur = torqueLayouts.get(cur.parent)) {
        chain.unshift(cur.name);
        if (cur === tq) continue;
        allFields.unshift(...cur.fields.map((f) => ({ ...f, declaredIn: cur.name })));
        if (!torqueLayouts.has(cur.parent)) break;
      }
      allFields.push(...fields.map((f) => ({ ...f, declaredIn: name })));
    }

    out[name] = {
      ...(tq ?? {
        name, source: fl.header, parent: null, parentSize: fl.anchorValue ?? null,
        isExtern: true, abstract: false, isShape: false, hasBody: true, droppedFields: [],
      }),
      layoutSource: useFieldList ? 'FIELD_LIST' : 'torque',
      inheritanceChain: chain,
      fields,
      ...(allFields.length ? { allFields } : {}),
      headerSize,
      size,
      sizeKnown,
      variableLength: !sizeKnown,
      fieldList: fl,
      crossCheck: crossCheckLayout(tq, fl),
      ...(sizeKnown
        ? {
          offsets: Object.fromEntries(fields.filter((f) => f.offset !== null).map((f) => [f.name, f.offset])),
          relativeOffsets: Object.fromEntries(fields.filter((f) => f.relativeOffset !== null).map((f) => [f.name, f.relativeOffset])),
        }
        : {}),
    };
  }

  const bitfields = {};
  for (const b of bitfieldDecls) {
    const width = { uint8: 8, uint16: 16, uint31: 31, uint32: 32, uint64: 64, int31: 31, int32: 32 }[b.base] ?? null;
    bitfields[b.name] = {
      name: b.name,
      base: b.base,
      containerBits: width,
      usedBits: b.totalBits,
      source: b.file,
      fields: b.fields.map((f) => ({
        name: f.name, type: f.type, offset: f.offset, width: f.bits,
        mask: f.bits >= 32 ? null : (((1 << f.bits) - 1) << f.offset) >>> 0,
      })),
    };
  }

  // ---- enums -----------------------------------------------------------------
  // Torque first (names, declaration order, member types), then C++ on top:
  // for an `extern enum` Torque states only that the names exist and C++ owns
  // the values, so where both describe an enum the C++ value is authoritative
  // and the disagreement is recorded rather than averaged away.
  const enums = {};
  for (const e of enumDecls) {
    if (!e.members || Object.keys(e.members).length === 0) continue;
    enums[e.name] = {
      name: e.name,
      base: e.base ?? null,
      open: !!e.open,
      source: e.file,
      valueSource: 'torque-declaration-order',
      members: e.members,
      memberTypes: e.memberTypes ?? null,
      torqueIsExtern: !!e.isExtern,
      // An `extern enum` is defined in C++; Torque only names its members. Say
      // so, so that nobody reads a declaration position as a value by accident.
      ...(e.isExtern ? {
        valuesAreDeclarationOrderOnly: true,
        valueNote: 'this is an `extern enum`: C++ owns the values and this generator has no C++ '
          + 'extraction for it, so these ordinals are Torque declaration positions, not values',
      } : {}),
    };
  }
  const enumDisagreements = [];
  for (const [name, c] of Object.entries(cppEnums)) {
    const tq = enums[name] ?? null;
    enums[name] = {
      name,
      base: tq?.base ?? null,
      open: tq?.open ?? false,
      valueSource: 'cpp',
      source: c.source,
      sourceLine: c.sourceLine,
      cppName: c.cppName,
      members: c.members,
      aliases: c.aliases,
      declarationOrder: c.declarationOrder,
      memberTypes: tq?.memberTypes ?? null,
      torqueSource: c.torqueSource ?? null,
      torqueIsExtern: c.torqueIsExtern ?? null,
      torqueDeclarationOrder: c.torqueDeclarationOrder ?? null,
      disagreements: c.disagreements ?? [],
      membersTorqueDeclaresAndCppDoesNot: c.membersTorqueDeclaresAndCppDoesNot ?? [],
      consumers: c.consumers ?? null,
      ...(c.declaredBitSize !== undefined ? { declaredBitSize: c.declaredBitSize } : {}),
    };
    for (const d of c.disagreements ?? []) enumDisagreements.push({ enum: name, ...d });
  }

  // ---- Torque `generates` constants -----------------------------------------
  // `const kMaxInlinedLocalNamesSize: constexpr int32 generates
  // 'kScopeInfoMaxInlinedLocalNamesSize';` -- ScopeInfo's context_local_names
  // count expression is written with the Torque name, and the value lives in
  // constants.json under the C++ name, so the mapping has to travel with the
  // layout program or the count cannot be evaluated at all.
  const torqueConstants = {};
  for (const g of generatesConstDecls) {
    torqueConstants[g.name] = {
      generates: g.cppName,
      cppType: g.cppType,
      source: g.file,
      value: globals[g.cppName] !== undefined ? globals[g.cppName] : null,
    };
  }

  const structsOut = {};
  for (const s of structDecls) {
    let off = 0;
    const fields = [];
    for (const f of s.fields) {
      const sz = torqueFieldSize(f.type, sizes, structs, bitfieldMap);
      fields.push({ name: f.name, type: f.type, size: sz.size, offset: off });
      off += sz.size;
    }
    structsOut[s.name] = { name: s.name, source: s.file, packedSize: off, fields };
  }

  return {
    classes: out,
    missingClasses: missing,
    bitfields,
    requiredBitfieldsMissing: REQUIRED_BITFIELDS.filter((b) => !bitfields[b]),
    structs: structsOut,
    enums,
    enumDisagreements,
    torqueConstants,
    functionKindGroups,
    anchors: anchorValues,
    headerUnresolved,
    allTorqueClassCount: torqueLayouts.size,
  };
}
