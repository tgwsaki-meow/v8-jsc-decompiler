// tools/profilegen/expectations.mjs
//
// The declared expectations manifest.
//
// Why this file exists
// --------------------
// profilegen's five known bugs were not five bugs. They were one bug: a table
// could come out incomplete and nothing said so. `meta.json -> unresolved`
// recorded the gaps the generator *knew* it had, and every one of the five was
// a gap it did not know it had -- a Torque field skipped by a parser
// heuristic, an enum member dropped by a regex, a C++ enum nobody extracted,
// a constant nobody looked for. The profile still loaded, still validated,
// still passed 67 self-test checks, and the decoder downstream read the wrong
// slots.
//
// So this file states, as data, what every profile must contain and who
// consumes each entry. `assertExpectations` runs after the tables are built
// and before anything is written, and a missing entry *fails generation*. A
// future parser change that silently stops producing one of these cannot ship
// a profile.
//
// The rules this manifest follows, so that it stays honest rather than
// becoming a second place to hardcode V8:
//
//   1. No V8 value is pinned unless the value itself is the fact a decoder
//      depends on. Where a relation is what matters
//      (MIN_CONTEXT_EXTENDED_SLOTS == MIN_CONTEXT_SLOTS + 1), the relation is
//      what is checked, so a future V8 that renumbers still passes.
//   2. Every entry names its consumer and what breaks without it. An entry
//      nobody consumes does not belong here.
//   3. An entry is satisfied by *presence and shape*, never by equality with a
//      recorded blob, so this is not a golden-file test in disguise.

export class ExpectationError extends Error {}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * `a.b.c` into the view. Returns undefined for a missing link rather than
 * throwing, so a missing table is reported as a missing expectation.
 */
function at(view, path) {
  let cur = view;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Every entry: {id, kind, consumer, why, ...}
 *
 * kinds:
 *   classField      a Torque/FIELD_LIST field that must be in the field program
 *   bitfieldField   a bitfield-struct member, with its width where the width
 *                   itself is the contract
 *   enum            an enum table, with the value source that must own it
 *   enumMembers     named members that must exist
 *   enumRelation    a relation over an enum's values (not a pinned value)
 *   constant        a path into constants.json that must be a finite number
 *   path            any path that must be present (object/array/number)
 *   predicate       an arbitrary assertion over the view, for cross-table facts
 */
export const EXPECTATIONS = [
  // ---------------------------------------------------------------- ScopeInfo
  // ARCHITECTURE.md 9.6 gap 1. These three are interior fields: when they are
  // absent the layout program does not merely lose them, every later field
  // moves.
  {
    id: 'ScopeInfo.context_local_names',
    kind: 'classField',
    class: 'ScopeInfo',
    field: 'context_local_names',
    indexed: true,
    consumer: 'src/heap/objects.mjs readScopeInfo -> src/ir/context.mjs (context slot naming)',
    why: 'it IS the variable-name table: 98.726% of resolved context-slot names come from it, '
      + 'and its index expression contains a cast call, which is what the old parser choked on',
  },
  {
    id: 'ScopeInfo.context_local_names_hashtable',
    kind: 'classField',
    class: 'ScopeInfo',
    field: 'context_local_names_hashtable',
    conditional: true,
    consumer: 'src/heap/objects.mjs readNameToIndexHashTable',
    why: 'the out-of-line name table for scopes with >= kScopeInfoMaxInlinedLocalNamesSize locals; '
      + 'absent, every such ScopeInfo misdecodes from this field onwards',
  },
  {
    id: 'ScopeInfo.function_variable_info',
    kind: 'classField',
    class: 'ScopeInfo',
    field: 'function_variable_info',
    conditional: true,
    consumer: 'src/heap/layout.mjs walk (offsets of every later ScopeInfo field)',
    why: 'two slots that are present for a named function expression; its condition contains a '
      + 'FromConstexpr cast call, which is what the old parser choked on',
  },
  {
    id: 'ScopeInfo.field-order',
    kind: 'fieldOrder',
    class: 'ScopeInfo',
    order: [
      'flags', 'parameter_count', 'context_local_count', 'position_info',
      'module_variable_count', 'context_local_names', 'context_local_names_hashtable',
      'context_local_infos', 'saved_class_variable_info', 'function_variable_info',
      'inferred_function_name', 'outer_scope_info', 'module_info', 'module_variables',
      'dependent_code', 'unused_parameter_bits',
    ],
    consumer: 'src/heap/layout.mjs walk',
    why: 'the walk is a running sum in declaration order, so a reordering is as wrong as a drop',
  },
  {
    id: 'ScopeInfo.context_local_names.count-expression',
    kind: 'predicate',
    consumer: 'src/heap/layout.mjs ExpressionEvaluator',
    why: "the count is `Convert<intptr>(context_local_count) < kMaxInlinedLocalNamesSize ? "
      + "context_local_count : 0`; without the parsed AST the region's width is unknown and the "
      + 'walk stops at the variable-name table',
    test: (view) => {
      const f = (at(view, 'layouts.classes.ScopeInfo.fields') ?? []).find((x) => x.name === 'context_local_names');
      if (!f) return 'ScopeInfo has no context_local_names field';
      if (!f.count || !f.count.ast) return 'context_local_names has no parsed count expression';
      return null;
    },
  },
  {
    id: 'ScopeInfo.kMaxInlinedLocalNamesSize',
    kind: 'predicate',
    consumer: 'src/heap/layout.mjs namedConstant (via the overlay view) -> context_local_names count',
    why: 'the count expression names the Torque constant kMaxInlinedLocalNamesSize, whose value '
      + 'lives in constants.json under its C++ name kScopeInfoMaxInlinedLocalNamesSize; without '
      + 'the mapping the count cannot be evaluated',
    test: (view) => {
      const tc = at(view, 'layouts.torqueConstants.kMaxInlinedLocalNamesSize');
      if (!tc) return 'layouts.json -> torqueConstants has no kMaxInlinedLocalNamesSize';
      if (!num(tc.value)) return `kMaxInlinedLocalNamesSize -> ${tc.generates} has no value in constants.json`;
      return null;
    },
  },

  // ------------------------------------------------- BytecodeArray (the anchor)
  {
    id: 'BytecodeArray.fields',
    kind: 'fieldOrder',
    class: 'BytecodeArray',
    order: [
      'length', 'wrapper', 'source_position_table', 'handler_table', 'constant_pool',
      'frame_size', 'parameter_size', 'max_arguments', 'incoming_new_target_or_generator_register',
    ],
    consumer: 'src/cache/deserialize.mjs + src/heap/objects.mjs',
    why: 'the bytecode payload, the constant pool, the handler table and the source position '
      + 'table are all reached through these offsets',
  },

  // ----------------------------------------------------------------- bitfields
  {
    id: 'SharedFunctionInfoFlags.function_kind',
    kind: 'bitfieldField',
    struct: 'SharedFunctionInfoFlags',
    field: 'function_kind',
    consumer: 'src/heap/objects.mjs SharedFunctionInfo',
    why: 'the only source of isGenerator / isAsync / arrow / getter / setter',
  },
  {
    id: 'SharedFunctionInfoFlags.function_syntax_kind',
    kind: 'bitfieldField',
    struct: 'SharedFunctionInfoFlags',
    field: 'function_syntax_kind',
    consumer: 'src/heap/objects.mjs SharedFunctionInfo',
    why: 'declaration vs expression vs accessor vs wrapped',
  },
  {
    id: 'ScopeFlags.scope_type',
    kind: 'bitfieldField',
    struct: 'ScopeFlags',
    field: 'scope_type',
    consumer: 'src/heap/layout.mjs ScopeInfo conditions',
    why: 'four ScopeInfo fields are gated on it',
  },
  {
    id: 'ScopeFlags.has_context_extension_slot',
    kind: 'bitfieldField',
    struct: 'ScopeFlags',
    field: 'has_context_extension_slot',
    consumer: 'src/ir/context.mjs contextHeaderLength',
    why: 'it chooses between MIN_CONTEXT_SLOTS and MIN_CONTEXT_EXTENDED_SLOTS, i.e. whether a '
      + 'context slot index is off by one',
  },
  {
    id: 'ScopeFlags.function_variable',
    kind: 'bitfieldField',
    struct: 'ScopeFlags',
    field: 'function_variable',
    consumer: 'src/heap/layout.mjs ScopeInfo function_variable_info condition',
    why: 'function_variable_info is present iff this is not VariableAllocationInfo::NONE',
  },
  {
    id: 'VariableProperties.variable_mode',
    kind: 'bitfieldField',
    struct: 'VariableProperties',
    field: 'variable_mode',
    consumer: 'src/heap/objects.mjs context local infos',
    why: 'let / const / var per context local',
  },

  // --------------------------------------------------------------------- enums
  // ARCHITECTURE.md 9.6 gaps 2 and 3.
  {
    id: 'enums.FunctionKind',
    kind: 'enum',
    name: 'FunctionKind',
    valueSource: 'cpp',
    minMembers: 2,
    consumer: 'src/heap/objects.mjs functionKindName / kindFlags',
    why: 'FunctionKind is a plain C++ enum, so no Torque reader will ever produce it, yet '
      + 'SharedFunctionInfoFlags.function_kind is five bits of exactly this enum',
  },
  {
    id: 'enums.FunctionKind.width',
    kind: 'predicate',
    consumer: 'src/heap/objects.mjs SharedFunctionInfo',
    why: 'if the enum outgrows the bitfield, the kind read back is truncated and plausible',
    test: (view) => {
      const e = at(view, 'layouts.enums.FunctionKind');
      const f = (at(view, 'layouts.bitfields.SharedFunctionInfoFlags.fields') ?? []).find((x) => x.name === 'function_kind');
      if (!e || !f) return 'FunctionKind or SharedFunctionInfoFlags.function_kind missing';
      const max = Math.max(...Object.values(e.members));
      if (max >= 2 ** f.width) return `FunctionKind reaches ${max}, which does not fit in ${f.width} bits`;
      const declared = e.declaredBitSize ?? at(view, 'cppEnums.functionKindBitSize');
      if (num(declared) && declared !== f.width) {
        return `function-kind.h says kFunctionKindBitSize = ${declared} but the Torque bitfield is ${f.width} bits`;
      }
      return null;
    },
  },
  {
    id: 'enums.FunctionSyntaxKind',
    kind: 'enum',
    name: 'FunctionSyntaxKind',
    valueSource: 'cpp',
    minMembers: 2,
    consumer: 'src/heap/objects.mjs functionSyntaxKindName',
    why: 'also a plain C++ enum, also three bits of SharedFunctionInfoFlags',
  },
  {
    id: 'enums.LanguageMode',
    kind: 'enum',
    name: 'LanguageMode',
    valueSource: 'cpp',
    members: ['kSloppy', 'kStrict'],
    consumer: 'src/heap/objects.mjs + src/heap/layout.mjs enumValue',
    why: "Torque declares { kStrict, kSloppy } and C++ defines { kSloppy, kStrict }: taking the "
      + 'Torque order reports every strict function as sloppy and every sloppy one as strict',
  },
  {
    id: 'enums.ScopeType',
    kind: 'enum',
    name: 'ScopeType',
    valueSource: 'cpp',
    members: ['FUNCTION_SCOPE', 'MODULE_SCOPE'],
    consumer: 'src/heap/layout.mjs ScopeInfo conditions',
    why: 'module_variable_count, module_info, module_variables and unused_parameter_bits are '
      + 'gated on these two ordinals',
  },
  {
    id: 'enums.VariableAllocationInfo',
    kind: 'enum',
    name: 'VariableAllocationInfo',
    valueSource: 'cpp',
    members: ['NONE'],
    consumer: 'src/heap/layout.mjs ScopeInfo function_variable_info condition',
    why: 'the condition is `flags.function_variable != VariableAllocationInfo::NONE`',
  },
  {
    id: 'enums.ElementsKind',
    kind: 'enum',
    name: 'ElementsKind',
    valueSource: 'cpp',
    members: ['PACKED_SMI_ELEMENTS', 'DICTIONARY_ELEMENTS', 'NO_ELEMENTS'],
    consumer: 'src/heap/objects.mjs ArrayBoilerplateDescription',
    why: "Torque's declaration order puts NO_ELEMENTS at 0 while C++ puts PACKED_SMI_ELEMENTS "
      + 'there, so every kind would be named one step too high',
  },
  {
    id: 'enums.VariableMode',
    kind: 'enum',
    name: 'VariableMode',
    valueSource: 'cpp',
    members: ['kLet', 'kConst', 'kVar'],
    consumer: 'src/heap/objects.mjs context local infos',
    why: 'VariableProperties.variable_mode is four bits of it',
  },
  // ARCHITECTURE.md 10.7, the fifth gap.
  {
    id: 'enums.ContextSlot',
    kind: 'enum',
    name: 'ContextSlot',
    valueSource: 'cpp',
    members: ['SCOPE_INFO_INDEX', 'PREVIOUS_INDEX', 'MIN_CONTEXT_SLOTS', 'MIN_CONTEXT_EXTENDED_SLOTS'],
    consumer: 'src/ir/context.mjs contextHeaderConstants',
    why: 'ScopeInfo::ContextHeaderLength() is one of these two, and it is the subtrahend that '
      + 'turns a context slot index into a variable name; the Torque reader used to drop every '
      + 'Slot<Context, T> member and renumber the one survivor to 0',
  },
  {
    id: 'enums.ContextSlot.header-length',
    kind: 'enumRelation',
    name: 'ContextSlot',
    describe: 'MIN_CONTEXT_EXTENDED_SLOTS == MIN_CONTEXT_SLOTS + 1 and MIN_CONTEXT_SLOTS >= 1',
    test: (m) => {
      if (!num(m.MIN_CONTEXT_SLOTS) || !num(m.MIN_CONTEXT_EXTENDED_SLOTS)) return 'both members must be numbers';
      if (m.MIN_CONTEXT_SLOTS < 1) return `MIN_CONTEXT_SLOTS is ${m.MIN_CONTEXT_SLOTS}; every context has at least a scope_info slot`;
      if (m.MIN_CONTEXT_EXTENDED_SLOTS !== m.MIN_CONTEXT_SLOTS + 1) {
        return `MIN_CONTEXT_EXTENDED_SLOTS (${m.MIN_CONTEXT_EXTENDED_SLOTS}) is not MIN_CONTEXT_SLOTS + 1 (${m.MIN_CONTEXT_SLOTS + 1}); the extension slot is exactly one slot`;
      }
      return null;
    },
    consumer: 'src/ir/context.mjs contextHeaderConstants',
    why: 'an off-by-one here renames every context slot, and the result looks plausible',
  },
  {
    id: 'enums.SnapshotSpace',
    kind: 'enum',
    name: 'SnapshotSpace',
    valueSource: 'cpp',
    minMembers: 2,
    consumer: 'src/cache/deserialize.mjs (kNewObject space index)',
    why: 'kNewObject spans one tag per snapshot space',
  },
  {
    id: 'enums.SnapshotSpace.count',
    kind: 'predicate',
    consumer: 'src/cache/deserialize.mjs',
    why: 'kNewObject occupies kNumberOfSnapshotSpaces tag bytes; if the space list and that count '
      + 'disagree, either the tag range or the space names are wrong',
    test: (view) => {
      const n = Object.keys(at(view, 'layouts.enums.SnapshotSpace.members') ?? {}).length;
      const k = at(view, 'serializerTags.kNumberOfSnapshotSpaces');
      if (!n) return 'no SnapshotSpace members';
      if (!num(k)) return 'serializer-tags.json has no kNumberOfSnapshotSpaces';
      if (n !== k) return `${n} SnapshotSpace members but kNumberOfSnapshotSpaces is ${k}`;
      return null;
    },
  },
  {
    id: 'layouts.functionKindGroups',
    kind: 'predicate',
    consumer: 'src/heap/objects.mjs kindFlags / src/cache/overlay.mjs kindIs',
    why: 'isGenerator / isAsync / isArrow are range tests over FunctionKind taken from '
      + 'function-kind.h; reinventing them is how an ordinary function becomes a generator',
    test: (view) => {
      const g = at(view, 'layouts.functionKindGroups') ?? {};
      const need = ['IsGeneratorFunction', 'IsAsyncFunction', 'IsArrowFunction', 'IsConciseMethod'];
      const missing = need.filter((n) => !Array.isArray(g[n]) || !g[n].length);
      if (missing.length) return `no range for ${missing.join(', ')}`;
      return null;
    },
  },

  // ------------------------------------------------------- code-cache header
  // ARCHITECTURE.md 9.6 gap 4.
  {
    id: 'constants.codeCacheHeader.magicBase',
    kind: 'constant',
    path: 'constants.codeCacheHeader.magicBase',
    consumer: 'src/cache/header.mjs parseHeader',
    why: 'magic = magicBase ^ ExternalReferenceTable::kSize; without the base the magic word '
      + 'cannot be checked at all and the table size cannot be recovered from it',
  },
  {
    id: 'constants.codeCacheHeader.sourceHash',
    kind: 'predicate',
    consumer: 'src/cache/header.mjs parseHeader',
    why: 'the sourceHash word is the source character count in bits 0..28 with '
      + 'hasWrappedArguments at 29 and isModule at 30; reading the whole word as a length '
      + 'turns every module into a 2-gigabyte script',
    test: (view) => {
      const sh = at(view, 'constants.codeCacheHeader.sourceHash');
      if (!sh) return 'constants.json has no codeCacheHeader.sourceHash';
      for (const k of ['length', 'hasWrappedArguments', 'isModule']) {
        if (!sh[k] || !num(sh[k].offset) || !num(sh[k].width)) return `sourceHash.${k} is missing its offset/width`;
      }
      if (sh.length.offset !== 0) return `sourceHash.length starts at bit ${sh.length.offset}, not 0`;
      if (sh.hasWrappedArguments.offset !== sh.length.offset + sh.length.width) {
        return 'sourceHash.hasWrappedArguments does not sit immediately above the length field';
      }
      if (sh.isModule.offset !== sh.hasWrappedArguments.offset + sh.hasWrappedArguments.width) {
        return 'sourceHash.isModule does not sit immediately above hasWrappedArguments';
      }
      return null;
    },
  },
  {
    id: 'constants.codeCacheHeader.checksum',
    kind: 'path',
    path: 'constants.codeCacheHeader.checksum.algorithm',
    consumer: 'src/cache/header.mjs verifyPayloadChecksum',
    why: 'adler32 seeded with 0 rather than 1, and only written when '
      + '--verify-snapshot-checksum was on',
  },
  {
    id: 'constants.codeCacheHeader.offsets',
    kind: 'predicate',
    consumer: 'src/cache/header.mjs parseHeader',
    why: 'the six header words plus the header size are where every other check starts',
    test: (view) => {
      const h = at(view, 'constants.codeCacheHeader') ?? {};
      const need = ['kMagicNumberOffset', 'kVersionHashOffset', 'kSourceHashOffset', 'kFlagHashOffset',
        'kReadOnlySnapshotChecksumOffset', 'kPayloadLengthOffset', 'kChecksumOffset', 'kHeaderSize'];
      const missing = need.filter((k) => !num(h[k]));
      return missing.length ? `missing ${missing.join(', ')}` : null;
    },
  },

  // --------------------------------------------- C++-only layouts and geometry
  {
    id: 'layouts.cppLayouts.SourcePosition',
    kind: 'path',
    path: 'layouts.cppLayouts.SourcePosition.fields.scriptOffset.offset',
    consumer: 'src/heap/sourceposition.mjs',
    why: 'the source position table stores SourcePosition::raw(), not a character offset; '
      + 'without the bitfield every reported position is the raw word',
  },
  {
    id: 'layouts.cppLayouts.BigIntBase',
    kind: 'path',
    path: 'layouts.cppLayouts.BigIntBase.digitsOffset',
    consumer: 'src/heap/objects.mjs decodeBigInt',
    why: 'BigInt is declared with FLEXIBLE_ARRAY_MEMBER, so no Torque class describes it, and a '
      + 'BigInt literal does reach a constant pool',
  },
  {
    id: 'layouts.cppLayouts.HashTableBase',
    kind: 'path',
    path: 'layouts.cppLayouts.HashTableBase.capacityIndex',
    consumer: 'docs/FRONTEND.md (NameToIndexHashTable walk)',
    why: "the hash table prefix indices; the walk currently validates rather than assumes them, "
      + 'but the fixed prefix is still part of the format',
  },
  {
    id: 'constants.readOnlyPage',
    kind: 'predicate',
    consumer: 'src/profile/index.mjs resolveRoRef',
    why: 'Tagged_t = (chunkIndex << pageSizeBits) + chunkOffset + kHeapObjectTag',
    test: (view) => {
      const p = at(view, 'constants.readOnlyPage') ?? {};
      if (!num(p.pageSizeBits)) return 'pageSizeBits missing';
      if (!num(p.pageHeaderSize)) return 'pageHeaderSize missing';
      if (!num(at(view, 'constants.tagging.kHeapObjectTag'))) return 'kHeapObjectTag missing';
      return null;
    },
  },
  {
    id: 'constants.scopeInfo.kScopeInfoMaxInlinedLocalNamesSize',
    kind: 'constant',
    path: 'constants.scopeInfo.kScopeInfoMaxInlinedLocalNamesSize',
    consumer: 'src/heap/layout.mjs (context_local_names count)',
    why: 'the threshold between the inline name array and the hash table',
  },

  // ------------------------------------------------------------ build identity
  // ARCHITECTURE.md 9.7: the sandbox switch has to be recorded, because a .jsc
  // from a differently configured build of the same V8 version decodes into
  // nonsense rather than failing.
  {
    id: 'meta.build',
    kind: 'predicate',
    consumer: 'src/cache/index.mjs readCache (up-front build check)',
    why: 'trusted-pointer slot widths and two serializer tags depend on the sandbox switch; '
      + 'without it a non-sandboxed .jsc fails deep inside deserialisation with an unreadable error',
    test: (view) => {
      const b = at(view, 'meta.build');
      if (!b) return 'meta.json has no build section';
      for (const k of ['sandbox', 'pointerCompression', 'externalCodeSpace', 'staticRoots']) {
        if (typeof b[k] !== 'boolean') return `meta.build.${k} is not a boolean`;
      }
      if (!num(b.taggedSize)) return 'meta.build.taggedSize is not a number';
      if ((b.taggedSize === 4) !== b.pointerCompression) {
        return `meta.build says taggedSize ${b.taggedSize} with pointerCompression ${b.pointerCompression}`;
      }
      return null;
    },
  },
];

/** Run the manifest. Returns {checked, satisfied, missing: [{id, consumer, why, reason}]}. */
export function checkExpectations(view) {
  const missing = [];
  for (const e of EXPECTATIONS) {
    const reason = reasonFor(e, view);
    if (reason) missing.push({ id: e.id, kind: e.kind, consumer: e.consumer, why: e.why, reason });
  }
  return { checked: EXPECTATIONS.length, satisfied: EXPECTATIONS.length - missing.length, missing };
}

function reasonFor(e, view) {
  switch (e.kind) {
    case 'classField': {
      const cls = at(view, `layouts.classes.${e.class}`);
      if (!cls) return `layouts.json has no class ${e.class}`;
      const f = (cls.fields ?? []).find((x) => x.name === e.field);
      if (!f) {
        const dropped = (cls.droppedFields ?? []).find((x) => x.name === e.field);
        if (dropped) return `${e.class}.${e.field} was dropped by the build config (${JSON.stringify(dropped.conditions)})`;
        return `${e.class} has no field ${e.field} (declared fields: ${(cls.fields ?? []).map((x) => x.name).join(', ')})`;
      }
      if (e.indexed && f.indexed !== true) return `${e.class}.${e.field} is not an indexed region`;
      if (e.conditional && f.present !== 'conditional') return `${e.class}.${e.field} is not conditional (present=${JSON.stringify(f.present)})`;
      return null;
    }
    case 'fieldOrder': {
      const cls = at(view, `layouts.classes.${e.class}`);
      if (!cls) return `layouts.json has no class ${e.class}`;
      const have = (cls.fields ?? []).map((f) => f.name);
      const missing = e.order.filter((n) => !have.includes(n));
      if (missing.length) return `${e.class} is missing ${missing.join(', ')}`;
      const positions = e.order.map((n) => have.indexOf(n));
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] < positions[i - 1]) {
          return `${e.class} declares ${e.order[i]} before ${e.order[i - 1]}`;
        }
      }
      return null;
    }
    case 'bitfieldField': {
      const b = at(view, `layouts.bitfields.${e.struct}`);
      if (!b) return `layouts.json has no bitfield struct ${e.struct}`;
      const f = (b.fields ?? []).find((x) => x.name === e.field);
      if (!f) return `${e.struct} has no member ${e.field}`;
      if (!num(f.offset) || !num(f.width)) return `${e.struct}.${e.field} has no offset/width`;
      if (e.width !== undefined && f.width !== e.width) return `${e.struct}.${e.field} is ${f.width} bits, expected ${e.width}`;
      return null;
    }
    case 'enum': {
      const en = at(view, `layouts.enums.${e.name}`);
      if (!en) return `layouts.json has no enum ${e.name}`;
      if (e.valueSource && en.valueSource !== e.valueSource) {
        return `enums.${e.name}.valueSource is ${JSON.stringify(en.valueSource)}, expected ${JSON.stringify(e.valueSource)}`
          + (e.valueSource === 'cpp' ? ' (for an `extern enum` the Torque declaration order is not the value)' : '');
      }
      const members = en.members ?? {};
      const n = Object.keys(members).length;
      if (e.minMembers !== undefined && n < e.minMembers) return `enums.${e.name} has ${n} member(s), expected at least ${e.minMembers}`;
      for (const m of e.members ?? []) {
        if (!num(members[m])) return `enums.${e.name} has no member ${m}`;
      }
      return null;
    }
    case 'enumRelation': {
      const en = at(view, `layouts.enums.${e.name}`);
      if (!en) return `layouts.json has no enum ${e.name}`;
      const r = e.test(en.members ?? {});
      return r ? `${e.describe}: ${r}` : null;
    }
    case 'constant': {
      const v = at(view, e.path);
      return num(v) ? null : `${e.path} is ${JSON.stringify(v)}, expected a number`;
    }
    case 'path': {
      const v = at(view, e.path);
      return v === undefined || v === null ? `${e.path} is not present` : null;
    }
    case 'predicate':
      return e.test(view);
    default:
      return `unknown expectation kind ${e.kind}`;
  }
}

/** Throw unless every expectation is met. Called before anything is written. */
export function assertExpectations(view, { tag = '<tag>' } = {}) {
  const r = checkExpectations(view);
  if (!r.missing.length) return r;
  const lines = [
    `${tag}: ${r.missing.length} of ${r.checked} declared expectations are not met, so this profile is NOT written.`,
    '',
    'Each line is a table entry a consumer needs. An extractor stopped producing it; the fix is',
    'in the extractor, not here. tools/profilegen/expectations.mjs says who consumes each one and',
    'what goes wrong without it, and meta.json -> unresolved should name the source line.',
    '',
  ];
  for (const m of r.missing) {
    lines.push(`  [${m.id}] ${m.reason}`);
    lines.push(`      consumer: ${m.consumer}`);
    lines.push(`      why it matters: ${m.why}`);
  }
  throw new ExpectationError(lines.join('\n'));
}

export default { EXPECTATIONS, checkExpectations, assertExpectations, ExpectationError };
