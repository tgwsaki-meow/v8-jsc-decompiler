// tools/profilegen/gen/cppenums.mjs
//
// The enums Torque does not define, and the values Torque gets wrong.
//
// Torque declares an enum in one of two ways:
//
//   enum X extends uint32 { A, B }           // Torque owns the values
//   extern enum X extends uint32 { A, B }    // C++ owns the values; Torque
//                                            // only states that the names exist
//
// For an `extern enum` the declaration order in the .tq file carries no
// meaning, and V8 does reorder with respect to C++:
//
//   src/builtins/base.tq   extern enum LanguageMode extends bool { kStrict, kSloppy }
//   src/common/globals.h   enum class LanguageMode : bool { kSloppy, kStrict };
//
// so `kStrict` is 0 by Torque declaration order and 1 in the binary. Reading a
// SharedFunctionInfoFlags.language_mode bit against the Torque order reports
// every strict function as sloppy and vice versa -- a wrong-but-plausible
// answer, which is the worst failure mode for an auditing tool.
//
// Therefore: for every enum that a decoder consumes, the C++ definition is
// extracted and is authoritative; the Torque declaration order is kept
// alongside it; and every disagreement is recorded in
// layouts.json -> enums.<X>.disagreements and in meta.json -> unresolved.
//
// Two of these enums are not Torque enums at all -- FunctionKind and
// FunctionSyntaxKind -- yet SharedFunctionInfoFlags.function_kind is five bits
// of the first and function_syntax_kind is three bits of the second, and they
// are the only source of isGenerator / isAsync / arrow / getter / setter.
//
// Citations, all at refs/tags/<tag>:
//   src/objects/function-kind.h          enum class FunctionKind : uint8_t
//                                        + the base::IsInRange group predicates
//                                        + constexpr int kFunctionKindBitSize
//   src/objects/function-syntax-kind.h   enum class FunctionSyntaxKind : uint8_t
//   src/common/globals.h                 LanguageMode, ScopeType, VariableMode,
//                                        VariableAllocationInfo, InitializationFlag,
//                                        MaybeAssignedFlag, IsStaticFlag
//   src/objects/elements-kind.h          enum ElementsKind : uint8_t
//                                        (partly macro-generated: TYPED_ARRAYS)
//   src/objects/contexts.h               class Context { enum Field ... }
//                                        (partly macro-generated: NATIVE_CONTEXT_FIELDS)
//   src/snapshot/references.h            enum class SnapshotSpace : uint8_t

import { Cpp, evalIntExpr, splitArgs } from '../cpp.mjs';

/**
 * The C++ enums a decoder consumes, with the Torque enum each one governs.
 *
 * `consumers` is not documentation: expectations.mjs turns this table into a
 * generation-time assertion, so an enum that stops being extracted fails the
 * run instead of disappearing.
 */
export const CPP_ENUMS = [
  {
    name: 'FunctionKind',
    header: 'src/objects/function-kind.h',
    torque: null,
    consumers: ['src/heap/objects.mjs: SharedFunctionInfo.functionKindName / kindFlags'],
    why: 'SharedFunctionInfoFlags.function_kind is 5 bits of this enum and is the only source of isGenerator / isAsync / arrow / getter / setter',
  },
  {
    name: 'FunctionSyntaxKind',
    header: 'src/objects/function-syntax-kind.h',
    torque: null,
    consumers: ['src/heap/objects.mjs: SharedFunctionInfo.functionSyntaxKind'],
    why: 'SharedFunctionInfoFlags.function_syntax_kind is 3 bits of this enum (declaration vs expression vs accessor vs wrapped)',
  },
  {
    name: 'LanguageMode',
    header: 'src/common/globals.h',
    torque: 'LanguageMode',
    consumers: ['src/heap/objects.mjs: SharedFunctionInfo flags', 'src/heap/layout.mjs: enumValue'],
    why: 'Torque declares { kStrict, kSloppy } and C++ defines { kSloppy, kStrict }: the Torque order inverts strict and sloppy',
  },
  {
    name: 'ScopeType',
    header: 'src/common/globals.h',
    torque: 'ScopeType',
    consumers: ['src/heap/layout.mjs: ScopeInfo module_variable_count / module_info / module_variables / unused_parameter_bits conditions'],
    why: 'ScopeInfo gates four fields on flags.scope_type == ScopeType::MODULE_SCOPE / FUNCTION_SCOPE, so a wrong ordinal shifts the layout of every module or function scope',
  },
  {
    name: 'VariableAllocationInfo',
    header: 'src/common/globals.h',
    torque: 'VariableAllocationInfo',
    consumers: ['src/heap/layout.mjs: ScopeInfo function_variable_info condition'],
    why: 'function_variable_info is present iff flags.function_variable != VariableAllocationInfo::NONE',
  },
  {
    name: 'VariableMode',
    header: 'src/common/globals.h',
    torque: 'VariableMode',
    consumers: ['src/heap/objects.mjs: ScopeInfo context local variable modes'],
    why: 'VariableProperties.variable_mode is 4 bits of this enum; it is how a context local is reported as let / const / var',
  },
  {
    name: 'InitializationFlag',
    header: 'src/common/globals.h',
    torque: 'InitializationFlag',
    consumers: ['src/heap/objects.mjs: ScopeInfo context local infos'],
    why: 'VariableProperties.init_flag',
  },
  {
    name: 'MaybeAssignedFlag',
    header: 'src/common/globals.h',
    torque: 'MaybeAssignedFlag',
    consumers: ['src/heap/objects.mjs: ScopeInfo context local infos'],
    why: 'VariableProperties.maybe_assigned_flag',
  },
  {
    name: 'IsStaticFlag',
    header: 'src/common/globals.h',
    torque: 'IsStaticFlag',
    consumers: ['src/heap/objects.mjs: ScopeInfo context local infos'],
    why: 'VariableProperties.is_static_flag',
  },
  {
    name: 'ElementsKind',
    header: 'src/objects/elements-kind.h',
    torque: 'ElementsKind',
    consumers: ['src/heap/objects.mjs: ArrayBoilerplateDescription.elements_kind'],
    why: "Torque's declaration order starts at NO_ELEMENTS while C++ starts at PACKED_SMI_ELEMENTS, so every kind would be named one step too high",
  },
  {
    name: 'Field',
    cppScope: 'Context',
    emitAs: 'ContextSlot',
    header: 'src/objects/contexts.h',
    torque: 'ContextSlot',
    after: /class\s+Context\s*:/,
    consumers: ['src/ir/context.mjs: contextHeaderConstants (MIN_CONTEXT_SLOTS / MIN_CONTEXT_EXTENDED_SLOTS)'],
    why: 'ScopeInfo::ContextHeaderLength() is MIN_CONTEXT_EXTENDED_SLOTS or MIN_CONTEXT_SLOTS, and it is the subtrahend that turns a context slot index into a variable name',
  },
  {
    name: 'SnapshotSpace',
    header: 'src/snapshot/references.h',
    torque: null,
    consumers: ['src/cache/deserialize.mjs: kNewObject space index'],
    why: 'kNewObject spans kNumberOfSnapshotSpaces tags, one per space, and the space is reported per object',
  },
];

/**
 * Preprocess one header and expand the list-macro invocations that build an
 * enum body.
 *
 * A macro-generated enum body looks like
 *
 *   #define NATIVE_CONTEXT_SLOT(index, type, name) index,
 *       NATIVE_CONTEXT_FIELDS(NATIVE_CONTEXT_SLOT)
 *   #undef NATIVE_CONTEXT_SLOT
 *
 * so the expansion has to happen *where the list is used*, while the callback
 * macro is still defined. Cpp.run's onLine hook exposes the macro table at
 * exactly that point (the same mechanism gen/layouts.mjs uses for FIELD_LIST).
 */
export function activeTextWithExpandedLists(text, defines, label) {
  const cpp = new Cpp(defines);
  const lines = [];
  const expanded = [];
  cpp.run(text, {
    label,
    onLine: (line, c) => {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*\(\s*([A-Za-z_]\w*)\s*\)\s*$/.exec(line);
      if (m && c.macros.has(m[1]) && c.macros.get(m[1]).params !== null && c.macros.has(m[2])) {
        lines.push(c.expand(line, new Set()));
        expanded.push(`${m[1]}(${m[2]})`);
        return;
      }
      lines.push(line);
    },
  });
  return { text: lines.join('\n'), expandedLists: expanded, cpp };
}

/**
 * Read one C++ enum as C reads it.
 *
 * The counter rule is the C one: an un-initialised member is the previous
 * value plus one, and an initialised member resets the counter to its value
 * plus one. A member whose initialiser names another member of the same enum
 * is also recorded in `aliases`, because consumers that print a value want the
 * primary name, not the alias.
 */
export function parseCppEnumBody(body, { name, constants = {} } = {}) {
  const members = {};
  const aliases = {};
  const order = [];
  const unresolved = [];
  let next = 0;
  for (const piece of splitArgs(body)) {
    const t = piece.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const m = /^([A-Za-z_]\w*)(?:\s*=\s*([\s\S]+))?$/.exec(t);
    if (!m) { unresolved.push({ member: t, reason: 'not a `NAME` or `NAME = expr` enumerator' }); continue; }
    const [, member, init] = m;
    if (init === undefined) {
      members[member] = next++;
      order.push(member);
      continue;
    }
    const scope = { ...constants, ...members };
    const { value, unknown } = evalIntExpr(init, scope);
    if (unknown.length) {
      unresolved.push({ member, init, reason: `initialiser references ${unknown.join(', ')}` });
      continue;
    }
    const target = /^([A-Za-z_]\w*)$/.exec(init.trim());
    if (target && members[target[1]] !== undefined) aliases[member] = target[1];
    members[member] = value;
    order.push(member);
    next = value + 1;
  }
  return { name, members, aliases, order, unresolved };
}

/** Find `enum [class] NAME [: type] { ... }` in preprocessed text. */
export function findCppEnum(text, name, after = null) {
  let from = 0;
  if (after) {
    const m = after.exec(text);
    if (!m) return null;
    from = m.index;
  }
  const re = new RegExp(`enum\\s+(?:class\\s+)?${name}\\s*(?::\\s*[\\w:]+\\s*)?\\{`, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  const upto = text.slice(0, m.index);
  return { body: text.slice(open + 1, i - 1), line: upto.split('\n').length };
}

/**
 * `inline bool IsFoo(FunctionKind kind) { return base::IsInRange(kind, A, B) || ...; }`
 * -> inclusive ordinal ranges.
 *
 * Only two forms are understood -- `base::IsInRange(x, E::A, E::B)` and
 * `x == E::A` joined by `||`. A predicate written any other way (for instance
 * one that calls another predicate) is reported, not approximated: an
 * over-wide isGenerator group would silently mark ordinary functions as
 * generators.
 */
export function parseIsInRangePredicates(text, enumName, members) {
  const groups = {};
  const notUnderstood = [];
  const re = new RegExp(`inline\\s+bool\\s+(\\w+)\\s*\\(\\s*${enumName}\\s+\\w+\\s*\\)\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const predicate = m[1];
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const body = text.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ');
    let rest = body.replace(/^\s*return\s*/, '').replace(/;\s*$/, '');
    const ranges = [];
    const rangeRe = new RegExp(`base::IsInRange\\(\\s*\\w+\\s*,\\s*${enumName}::(\\w+)\\s*,\\s*${enumName}::(\\w+)\\s*\\)`, 'g');
    let r;
    while ((r = rangeRe.exec(rest))) ranges.push([r[1], r[2]]);
    rest = rest.replace(rangeRe, '');
    const eqRe = new RegExp(`\\w+\\s*==\\s*${enumName}::(\\w+)`, 'g');
    let e;
    while ((e = eqRe.exec(rest))) ranges.push([e[1], e[1]]);
    rest = rest.replace(eqRe, '');
    if (rest.replace(/[\s|()]/g, '') !== '') { notUnderstood.push({ predicate, body }); continue; }
    const resolved = [];
    let bad = null;
    for (const [a, b] of ranges) {
      if (members[a] === undefined || members[b] === undefined) { bad = `${a}..${b}`; break; }
      resolved.push([members[a], members[b]]);
    }
    if (bad) { notUnderstood.push({ predicate, body, reason: `names unknown ${enumName} member ${bad}` }); continue; }
    if (!resolved.length) { notUnderstood.push({ predicate, body, reason: 'no range or equality test found' }); continue; }
    groups[predicate] = resolved;
  }
  return { groups, notUnderstood };
}

/**
 * Extract every declared C++ enum, cross-check it against the Torque
 * declaration order, and return the merged tables.
 *
 * @param {object} src   V8Source
 * @param {{defines: object, torqueEnums: Map<string, object>, constants: object}} opts
 */
export async function deriveCppEnums(src, { defines, torqueEnums = new Map(), constants = {} }) {
  const byHeader = new Map();
  const enums = {};
  const disagreements = [];
  const unresolved = [];
  let functionKindGroups = {};
  let predicatesNotUnderstood = [];
  let functionKindBitSize = null;

  for (const spec of CPP_ENUMS) {
    if (!byHeader.has(spec.header)) {
      const f = await src.get(spec.header, { optional: true });
      if (!f.text) {
        unresolved.push({ enum: spec.name, source: spec.header, line: null, reason: `header not available (HTTP ${f.status})` });
        byHeader.set(spec.header, null);
        continue;
      }
      byHeader.set(spec.header, activeTextWithExpandedLists(f.text, defines, spec.header));
    }
    const prepared = byHeader.get(spec.header);
    if (!prepared) continue;

    const found = findCppEnum(prepared.text, spec.name, spec.after ?? null);
    const emitAs = spec.emitAs ?? spec.name;
    if (!found) {
      unresolved.push({
        enum: emitAs,
        source: spec.header,
        line: null,
        reason: `enum ${spec.cppScope ? spec.cppScope + '::' : ''}${spec.name} not found after preprocessing`,
      });
      continue;
    }
    const parsed = parseCppEnumBody(found.body, { name: emitAs, constants });
    for (const u of parsed.unresolved) {
      unresolved.push({ enum: emitAs, source: spec.header, line: found.line, reason: `${u.member}: ${u.reason}` });
    }
    const tq = spec.torque ? torqueEnums.get(spec.torque) ?? null : null;
    const mine = {
      name: emitAs,
      cppName: `${spec.cppScope ? spec.cppScope + '::' : ''}${spec.name}`,
      valueSource: 'cpp',
      source: spec.header,
      sourceLine: found.line,
      members: parsed.members,
      aliases: parsed.aliases,
      declarationOrder: parsed.order,
      torqueName: spec.torque,
      consumers: spec.consumers,
    };
    if (tq) {
      mine.torqueSource = tq.file;
      mine.torqueIsExtern = !!tq.isExtern;
      mine.torqueDeclarationOrder = tq.members;
      const d = [];
      for (const [member, value] of Object.entries(parsed.members)) {
        const t = tq.members[member];
        if (t !== undefined && t !== value) d.push({ member, torqueDeclarationOrder: t, cppValue: value });
      }
      const missingInCpp = Object.keys(tq.members).filter((k) => parsed.members[k] === undefined);
      mine.disagreements = d;
      mine.membersTorqueDeclaresAndCppDoesNot = missingInCpp;
      if (d.length) {
        disagreements.push(...d.map((x) => ({ enum: emitAs, ...x })));
      }
      if (missingInCpp.length) {
        // Torque naming a member C++ does not have means one of the two reads
        // is wrong; it is never benign, so it is recorded as unresolved.
        unresolved.push({
          enum: emitAs,
          source: spec.header,
          line: found.line,
          reason: `Torque (${tq.file}) declares ${missingInCpp.join(', ')}, which the C++ enum does not define`,
        });
      }
      if (!tq.isExtern && d.length) {
        // A non-extern Torque enum is one Torque itself defines, so the two
        // must agree; a disagreement means one of the two readers is wrong.
        unresolved.push({
          enum: emitAs,
          source: spec.header,
          line: found.line,
          reason: `Torque defines this enum (not \`extern\`) yet its order disagrees with C++ at ${d.map((x) => x.member).join(', ')}`,
        });
      }
    }
    enums[emitAs] = mine;

    if (emitAs === 'FunctionKind') {
      const p = parseIsInRangePredicates(prepared.text, 'FunctionKind', parsed.members);
      functionKindGroups = p.groups;
      predicatesNotUnderstood = p.notUnderstood;
      // `constexpr int kFunctionKindBitSize = 5;` -- the width V8 itself says
      // the enum must fit in, which is cross-checked against the Torque
      // bitfield member rather than assumed to agree.
      const bits = /constexpr\s+int\s+kFunctionKindBitSize\s*=\s*(\d+)/.exec(prepared.text);
      functionKindBitSize = bits ? Number(bits[1]) : null;
      mine.declaredBitSize = functionKindBitSize;
    }
  }

  return {
    enums, disagreements, unresolved,
    functionKindGroups, predicatesNotUnderstood, functionKindBitSize,
  };
}

export default { CPP_ENUMS, deriveCppEnums, parseCppEnumBody, findCppEnum, parseIsInRangePredicates, activeTextWithExpandedLists };
