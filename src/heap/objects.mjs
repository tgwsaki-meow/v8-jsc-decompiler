// src/heap/objects.mjs
//
// Typed views. Every field is reached as `fields.get('name')` on a walked
// layout program -- never by slot index, never by a literal offset.
//
// Covered here:
//   ScopeInfo                      the variable-name table and the outer chain
//   SharedFunctionInfo             identity, flags, positions
//   BytecodeArray                  bytecode, frame, the three side tables
//   FixedArray / TrustedFixedArray / ProtectedFixedArray
//   TrustedByteArray / ByteArray
//   ObjectBoilerplateDescription / ArrayBoilerplateDescription /
//   RegExpBoilerplateDescription / TemplateObjectDescription
//   UncompiledData and its four concrete subclasses
//   HeapNumber, BigInt, Symbol
//
// Strings are in strings.mjs; the two side-table encodings are in
// handlertable.mjs and sourceposition.mjs.

import { smiFromBytes } from './view.mjs';

export const HOLE_KINDS = new Set(['hole']);

// --------------------------------------------------------------- small helpers

/** Resolve a reference to a plain JS value where that is possible. */
export function describeRef(ref, ctx) {
  if (ref === undefined) return { t: 'unresolved', why: 'slot-never-written' };
  if (ref === null) return { t: 'unresolved', why: 'null-slot' };

  if (ref.k === 'RawSlot') {
    // A non-pointer slot: in a constant pool this is a Smi.
    const tg = ctx.profile.constants.tagging;
    if ((ref.raw[0] & tg.kSmiTagMask) !== tg.kSmiTag) {
      return { t: 'unresolved', why: 'raw-slot-is-not-a-smi', detail: { raw: ref.raw.toString('hex') } };
    }
    return { t: 'number', v: smiFromBytes(ref.raw, tg.kSmiTagSize + tg.kSmiShiftSize), repr: 'smi' };
  }

  if (ref.k === 'RootArray' || ref.k === 'RootArrayConstant') {
    const r = ref.root;
    if (!r) return { t: 'unresolved', why: 'unknown-root-index', detail: { rootIndex: ref.rootIndex } };
    return rootToUnion(r, ref.rootIndex);
  }

  if (ref.k === 'ReadOnlyHeapRef') {
    const hit = ctx.roRefs.resolve(ref.chunkIndex, ref.chunkOffset);
    const base = { t: 'roRef', chunk: ref.chunkIndex, offset: ref.chunkOffset, address: hit.address };
    if (!hit.resolved) return base; // `resolved` absent, per the FunctionUnit contract
    const e = hit.entry;
    if (e.kind === 'string') return { t: 'string', v: e.value, via: 'roRef', roRef: base };
    if (e.kind === 'heapNumber') return { t: 'number', v: e.value, via: 'roRef', roRef: base };
    if (e.kind === 'symbol') return { t: 'symbol', desc: e.description ?? null, via: 'roRef', roRef: base };
    if (e.kind === 'oddball') return oddballUnion(e.oddball ?? e.value, { via: 'roRef', roRef: base }, e.rootName ?? e.mapName);
    if (e.kind === 'hole') return { t: 'hole', holeKind: e.mapName ?? e.rootName ?? null, via: 'roRef', roRef: base };
    return { ...base, resolved: { kind: e.kind, mapName: e.mapName ?? null, rootName: e.rootName ?? null, value: e.value } };
  }

  if (ref.k !== undefined) {
    return { t: 'unresolved', why: `reference-kind-${ref.k}`, detail: refDetail(ref) };
  }
  return null; // a deserialized object; the caller classifies it
}

function refDetail(ref) {
  const out = {};
  for (const key of ['index', 'referenceId', 'rootIndex', 'chunkIndex', 'chunkOffset', 'parameterCount', 'id']) {
    if (ref[key] !== undefined) out[key] = ref[key];
  }
  return out;
}

/**
 * Classify an oddball or a hole.
 *
 * roots.json gives most oddballs an `oddball` field, but not all of them: for
 * `the_hole_value` the only discriminator is `cppType`, and V8 has nine
 * distinct holes (`arguments_marker`, `exception`, `hash_table_hole_value`,
 * `optimized_out`, `promise_hole_value`, `property_cell_hole_value`,
 * `stale_register`, `termination_exception`, `uninitialized_value`) whose
 * identity matters: the hole in a sparse array literal and the elided value in
 * an object boilerplate are both `the_hole_value`, and the decompiler has to
 * tell them from `undefined`.
 */
function oddballUnion(which, extra, cppType) {
  switch (which) {
    case 'undefined': return { t: 'undefined', ...extra };
    case 'null': return { t: 'null', ...extra };
    case 'true': return { t: 'boolean', v: true, ...extra };
    case 'false': return { t: 'boolean', v: false, ...extra };
    default: break;
  }
  switch (cppType) {
    case 'Undefined': return { t: 'undefined', ...extra };
    case 'Null': return { t: 'null', ...extra };
    case 'True': return { t: 'boolean', v: true, ...extra };
    case 'False': return { t: 'boolean', v: false, ...extra };
    default: break;
  }
  if (typeof cppType === 'string' && /Hole|Marker|Exception|OptimizedOut|StaleRegister|Uninitialized/.test(cppType)) {
    return { t: 'hole', holeKind: cppType, ...extra };
  }
  return { t: 'unresolved', why: 'unknown-oddball', detail: { which, cppType } };
}

function rootToUnion(r, rootIndex) {
  switch (r.kind) {
    case 'string': return { t: 'string', v: r.value, via: 'root', rootName: r.cppName };
    case 'oddball': return oddballUnion(r.oddball, { via: 'root', rootName: r.cppName }, r.cppType);
    case 'hole': return { t: 'hole', holeKind: r.cppType ?? null, via: 'root', rootName: r.cppName };
    case 'smi': return { t: 'number', v: r.value ?? null, via: 'root', rootName: r.cppName, repr: 'smi' };
    case 'heapNumber': return { t: 'number', v: r.value ?? null, via: 'root', rootName: r.cppName };
    case 'symbol': return { t: 'symbol', desc: r.value ?? null, via: 'root', rootName: r.cppName };
    case 'object':
    case 'map':
      // A canonical heap object reached by root: its contents are in the
      // read-only heap, not in this payload. roots.json gives its C++ type, and
      // the `empty_*` roots are the canonical empty instances -- which is how a
      // BytecodeArray with no handlers or no constants spells "no table".
      return {
        t: 'rootObject',
        rootName: r.cppName,
        cppType: r.cppType ?? null,
        isEmpty: /^empty_/.test(r.cppName ?? ''),
        via: 'root',
      };
    default:
      return { t: 'unresolved', why: 'root-is-not-a-value', detail: { rootIndex, rootName: r.cppName, kind: r.kind } };
  }
}

/** Is this reference one of V8's canonical `empty_*` roots? */
export function isEmptyRoot(ref) {
  if (!ref || (ref.k !== 'RootArray' && ref.k !== 'RootArrayConstant')) return false;
  return /^empty_/.test(ref.root?.cppName ?? '');
}

/** Follow a resolved forward reference to the object it was filled with. */
export function deref(ref) {
  let cur = ref;
  for (let i = 0; i < 16 && cur && cur.k === 'PendingForwardRef'; i++) cur = cur.target;
  return cur;
}

// ------------------------------------------------------------------ ScopeInfo

/**
 * Decode a ScopeInfo by walking its layout program against its own ScopeFlags.
 *
 * This is the only place real variable names come from. The layout is almost
 * entirely conditional, so each field's presence is decided from `flags` as the
 * walk proceeds. `context_local_names` is an inlined String array when there
 * are fewer than kScopeInfoMaxInlinedLocalNamesSize context locals, and a
 * NameToIndexHashTable above that threshold.
 */
export function decodeScopeInfo(record, ctx, depth = 0, seen = new Set()) {
  if (depth > ctx.maxScopeChainDepth) {
    return { warnings: [`scope chain deeper than ${ctx.maxScopeChainDepth}; truncated`], truncated: true };
  }
  if (seen.has(record.id)) {
    return { warnings: [`scope chain revisits object ${record.id}; truncated to avoid a cycle`], truncated: true };
  }
  // A ScopeInfo is reached once per function that closes over it, and an outer
  // scope is reached once per inner function -- the corpus has outer chains ten
  // deep. Decoding it once per object, not once per path, is the difference
  // between a corpus run of minutes and one of hours.
  const memo = ctx.scopeInfoCache.get(record.id);
  if (memo !== undefined) return memo;
  seen.add(record.id);

  const view = ctx.viewOf(record);
  const walk = ctx.walk('ScopeInfo', view);
  const warnings = [...walk.warnings];
  const F = (n) => walk.fields.get(n);

  const flagsRec = F('flags');
  const rawFlags = flagsRec && flagsRec.present ? view.readUnsignedInt(flagsRec.offset, flagsRec.size, { optional: true }) : null;
  if (rawFlags === null) {
    const failed = { warnings: [...warnings, `ScopeInfo ${record.id}: flags were not serialized, so nothing else can be located`], failed: true };
    ctx.scopeInfoCache.set(record.id, failed);
    return failed;
  }
  const flags = ctx.expandBitfield('ScopeFlags', rawFlags);
  const scopeTypeName = ctx.enumName('ScopeType', flags.scope_type);

  const out = {
    scopeInfoId: record.id,
    scopeType: scopeTypeName,
    scopeTypeValue: flags.scope_type,
    flags,
    rawFlags,
    // ScopeFlags.language_mode is a LanguageMode, whose *values* come from C++
    // (kSloppy = 0, kStrict = 1); layouts.json records Torque's declaration
    // order, which is the other way round. See tools/layoutpatch.
    languageMode: ctx.enumName('LanguageMode', flags.language_mode),
    functionKindValue: flags.function_kind,
    functionKindName: ctx.overlay.functionKindName(flags.function_kind),
    parameterCount: null,
    contextLocalCount: null,
    positionInfo: null,
    contextLocalNames: [],
    contextLocalNamesSource: null,
    contextLocalInfos: [],
    savedClassVariableInfo: null,
    functionVariable: null,
    inferredFunctionName: null,
    moduleVariableCount: null,
    hasOuterScopeInfo: Boolean(flags.has_outer_scope_info),
    outer: null,
    warnings,
    fieldsPresent: walk.fields.presentNames(),
    truncatedAt: walk.truncatedAt,
  };
  // Published before the outer chain is walked so that a cycle through
  // outer_scope_info terminates on the memo rather than on the `seen` set.
  ctx.scopeInfoCache.set(record.id, out);

  const pc = F('parameter_count');
  if (pc?.present) out.parameterCount = view.readSmi(pc.offset, { optional: true });
  const clc = F('context_local_count');
  if (clc?.present) out.contextLocalCount = view.readSmi(clc.offset, { optional: true });

  const pi = F('position_info');
  if (pi?.present) {
    const struct = ctx.profile.tables.layouts.structs?.PositionInfo;
    if (struct) {
      const startOff = pi.offset + struct.fields.find((x) => x.name === 'start').offset;
      const endOff = pi.offset + struct.fields.find((x) => x.name === 'end').offset;
      out.positionInfo = {
        start: view.readSmi(startOff, { optional: true }),
        end: view.readSmi(endOff, { optional: true }),
      };
    } else {
      warnings.push('layouts.json has no PositionInfo struct, so ScopeInfo position_info cannot be split');
    }
  }

  const mvc = F('module_variable_count');
  if (mvc?.present) out.moduleVariableCount = view.readSmi(mvc.offset, { optional: true });

  // ---- context_local_names: the inlined array, or the hash table above the threshold.
  const namesRec = F('context_local_names');
  const hashRec = F('context_local_names_hashtable');
  if (namesRec?.present && namesRec.count > 0) {
    out.contextLocalNamesSource = 'inlined';
    for (let i = 0; i < namesRec.count; i++) {
      const slot = view.slot(namesRec.offset + i * namesRec.elementSize);
      const s = ctx.strings.decode(deref(slot));
      out.contextLocalNames.push(s.ok ? s.value : null);
      if (!s.ok) warnings.push(`ScopeInfo ${record.id}: context local name ${i} unresolved (${s.why})`);
    }
  } else if (hashRec?.present) {
    const r = readNameToIndexHashTable(view.slot(hashRec.offset), ctx, out.contextLocalCount);
    out.contextLocalNamesSource = 'hashtable';
    out.contextLocalNames = r.names;
    out.contextLocalNamesHashtable = r.diagnostics;
    warnings.push(...r.warnings);
  } else if (namesRec?.present) {
    out.contextLocalNamesSource = 'inlined';
  }

  // ---- context_local_infos: one SmiTagged<VariableProperties> per context local.
  const infosRec = F('context_local_infos');
  if (infosRec?.present) {
    for (let i = 0; i < infosRec.count; i++) {
      const raw = view.readSmi(infosRec.offset + i * infosRec.elementSize, { optional: true });
      if (raw === null) { out.contextLocalInfos.push(null); continue; }
      const b = ctx.expandBitfield('VariableProperties', raw);
      out.contextLocalInfos.push({
        mode: ctx.enumName('VariableMode', b.variable_mode),
        modeValue: b.variable_mode,
        initFlag: ctx.enumName('InitializationFlag', b.init_flag),
        maybeAssigned: ctx.enumName('MaybeAssignedFlag', b.maybe_assigned_flag) === 'kMaybeAssigned',
        isStaticFlag: ctx.enumName('IsStaticFlag', b.is_static_flag) === 'kStatic',
        parameterNumber: b.parameter_number,
        raw,
      });
    }
  }

  const savedRec = F('saved_class_variable_info');
  if (savedRec?.present) {
    const slot = view.slot(savedRec.offset);
    const u = describeRef(deref(slot), ctx);
    out.savedClassVariableInfo = u ?? { t: 'unresolved', why: 'saved-class-variable-is-an-object' };
  }

  // ---- function_variable_info: {name, context_or_stack_slot_index}
  const fvRec = F('function_variable_info');
  if (fvRec?.present) {
    const struct = ctx.profile.tables.layouts.structs?.FunctionVariableInfo;
    if (!struct) {
      warnings.push('layouts.json has no FunctionVariableInfo struct');
    } else {
      const nameOff = fvRec.offset + struct.fields.find((x) => x.name === 'name').offset;
      const idxOff = fvRec.offset + struct.fields.find((x) => x.name === 'context_or_stack_slot_index').offset;
      const s = ctx.strings.decode(deref(view.slot(nameOff)));
      out.functionVariable = {
        name: s.ok ? s.value : null,
        nameWhy: s.ok ? undefined : s.why,
        slotIndex: view.readSmi(idxOff, { optional: true }),
        allocation: ctx.enumName('VariableAllocationInfo', flags.function_variable),
      };
    }
  }

  const ifn = F('inferred_function_name');
  if (ifn?.present) {
    const s = ctx.strings.decode(deref(view.slot(ifn.offset)));
    out.inferredFunctionName = s.ok ? s.value : null;
    if (!s.ok && s.why !== 'root-is-oddball') out.inferredFunctionNameWhy = s.why;
  }

  // ---- the outer scope chain: this is what makes LdaContextSlot depth resolvable.
  const outerRec = F('outer_scope_info');
  if (outerRec?.present) {
    const outer = deref(view.slot(outerRec.offset));
    if (outer && outer.sizeInTagged !== undefined) {
      const cls = ctx.classifyObject(outer);
      if (cls && cls.className === 'ScopeInfo') {
        out.outer = decodeScopeInfo(outer, ctx, depth + 1, seen);
      } else {
        warnings.push(`ScopeInfo ${record.id}: outer_scope_info points at ${cls?.className ?? 'an unclassified object'}`);
      }
    } else {
      const u = describeRef(outer, ctx);
      out.outerRef = u;
      if (!u || u.t === 'unresolved') {
        warnings.push(`ScopeInfo ${record.id}: outer_scope_info is ${u?.why ?? 'not a deserialized object'}`);
      }
    }
  }

  return out;
}

/**
 * Recover names from a NameToIndexHashTable.
 *
 * The table is a FixedArray whose entries are (Name, Smi index) pairs starting
 * after the HashTableBase prefix. The *shape* constants (kPrefixSize,
 * kEntrySize) live with each table class in C++ and are not in any profile
 * table, so rather than assume them this reads every slot and keeps a pair
 * whenever a string is immediately followed by a Smi in range. The result is
 * then validated: it must be exactly `expectedCount` names at distinct indices
 * covering 0..expectedCount-1. If it is not, no names are returned and the
 * reason is reported.
 */
function readNameToIndexHashTable(tableRef, ctx, expectedCount) {
  const warnings = [];
  const table = deref(tableRef);
  if (!table || table.sizeInTagged === undefined) {
    return { names: [], warnings: ['context_local_names_hashtable is not a deserialized object'], diagnostics: { ok: false, why: 'not-an-object' } };
  }
  const view = ctx.viewOf(table);
  const taggedSize = ctx.profile.taggedSize;
  const found = new Map();
  let strings = 0;
  for (let i = 1; i < table.sizeInTagged; i++) {
    const slot = view.slot(i * taggedSize);
    const s = ctx.strings.decode(deref(slot));
    if (!s.ok) continue;
    strings++;
    const next = view.slot((i + 1) * taggedSize);
    if (!next || next.k !== 'RawSlot') continue;
    const tg = ctx.profile.constants.tagging;
    const idx = smiFromBytes(next.raw, tg.kSmiTagSize + tg.kSmiShiftSize);
    if (!Number.isInteger(idx) || idx < 0 || (expectedCount != null && idx >= expectedCount)) continue;
    if (found.has(idx)) {
      return {
        names: [], warnings: [`context_local_names_hashtable: index ${idx} claimed by two names`],
        diagnostics: { ok: false, why: 'duplicate-index', stringsSeen: strings },
      };
    }
    found.set(idx, s.value);
  }
  if (expectedCount != null && found.size !== expectedCount) {
    return {
      names: [],
      warnings: [`context_local_names_hashtable: recovered ${found.size} of ${expectedCount} names; `
        + 'the pair scan could not account for all context locals, so none are reported'],
      diagnostics: { ok: false, why: 'count-mismatch', recovered: found.size, expected: expectedCount, stringsSeen: strings },
    };
  }
  const names = new Array(expectedCount ?? found.size).fill(null);
  for (const [i, n] of found) names[i] = n;
  return { names, warnings, diagnostics: { ok: true, recovered: found.size, stringsSeen: strings, via: 'pair-scan' } };
}

// --------------------------------------------------------- SharedFunctionInfo

export function decodeSharedFunctionInfo(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('SharedFunctionInfo', view);
  const warnings = [...walk.warnings];
  const F = (n) => walk.fields.get(n);

  const flagsRec = F('flags');
  const rawFlags = flagsRec?.present ? view.readUnsignedInt(flagsRec.offset, flagsRec.size, { optional: true }) : null;
  const flags2Rec = F('flags2');
  const rawFlags2 = flags2Rec?.present ? view.readUnsignedInt(flags2Rec.offset, flags2Rec.size, { optional: true }) : null;

  const out = {
    sfiId: record.id,
    flags: rawFlags === null ? null : ctx.expandBitfield('SharedFunctionInfoFlags', rawFlags),
    flags2: rawFlags2 === null ? null : ctx.expandBitfield('SharedFunctionInfoFlags2', rawFlags2),
    rawFlags,
    rawFlags2,
    functionLiteralId: F('function_literal_id')?.present
      ? view.readSignedInt(F('function_literal_id').offset, F('function_literal_id').size, { optional: true }) : null,
    uniqueId: F('unique_id')?.present
      ? view.readSignedInt(F('unique_id').offset, F('unique_id').size, { optional: true }) : null,
    length: F('length')?.present ? view.readUnsignedInt(F('length').offset, F('length').size, { optional: true }) : null,
    formalParameterCount: F('formal_parameter_count')?.present
      ? view.readUnsignedInt(F('formal_parameter_count').offset, F('formal_parameter_count').size, { optional: true }) : null,
    functionTokenOffset: F('function_token_offset')?.present
      ? view.readUnsignedInt(F('function_token_offset').offset, F('function_token_offset').size, { optional: true }) : null,
    expectedNofProperties: F('expected_nof_properties')?.present
      ? view.readUnsignedInt(F('expected_nof_properties').offset, F('expected_nof_properties').size, { optional: true }) : null,
    trustedFunctionData: F('trusted_function_data')?.present ? deref(view.slot(F('trusted_function_data').offset)) : undefined,
    untrustedFunctionData: F('untrusted_function_data')?.present ? deref(view.slot(F('untrusted_function_data').offset)) : undefined,
    nameOrScopeInfo: F('name_or_scope_info')?.present ? deref(view.slot(F('name_or_scope_info').offset)) : undefined,
    outerScopeInfoOrFeedbackMetadata: F('outer_scope_info_or_feedback_metadata')?.present
      ? deref(view.slot(F('outer_scope_info_or_feedback_metadata').offset)) : undefined,
    script: F('script')?.present ? deref(view.slot(F('script').offset)) : undefined,
    warnings,
  };

  // ---- kind / isGenerator / isAsync / isStrict
  if (out.flags) {
    const kindValue = out.flags.function_kind;
    out.functionKindValue = kindValue;
    out.functionKindName = ctx.overlay.functionKindName(kindValue);
    out.functionSyntaxKind = ctx.overlay.functionSyntaxKindName(out.flags.function_syntax_kind);
    const flags = ctx.overlay.kindFlags(kindValue);
    const is = (p) => flags[p] === true;
    // Checked most specific first; a getter is never also a method here because
    // function-kind.h gives accessors their own kinds.
    out.kind = is('IsClassConstructor') ? 'classCtor'
      : is('IsGetterFunction') ? 'getter'
        : is('IsSetterFunction') ? 'setter'
          : is('IsArrowFunction') ? 'arrow'
            : is('IsConciseMethod') ? 'method'
              : is('IsModule') ? 'module'
                : 'normal';
    out.isGenerator = is('IsGeneratorFunction');
    out.isAsync = is('IsAsyncFunction');
    out.isStrict = out.flags.is_strict === 1;
    out.isClassConstructor = out.flags.is_class_constructor === 1;
    out.isTopLevel = out.flags.is_top_level === 1;
    out.allowLazyCompilation = out.flags.allow_lazy_compilation === 1;
    out.isNative = out.flags.is_native === 1;
    out.hasDuplicateParameters = out.flags.has_duplicate_parameters === 1;
    out.privateNameLookupSkipsOuterClass = out.flags.private_name_lookup_skips_outer_class === 1;
    out.requiresInstanceMembersInitializer = out.flags.requires_instance_members_initializer === 1;
  } else {
    warnings.push(`SharedFunctionInfo ${record.id}: flags were not serialized`);
    out.kind = null;
    out.isGenerator = null;
    out.isAsync = null;
    out.isStrict = null;
  }

  // ---- name_or_scope_info: a String name, the no-name sentinel, or a ScopeInfo
  out.scopeInfoRecord = null;
  out.name = null;
  out.nameSource = null;
  const nos = out.nameOrScopeInfo;
  if (nos && nos.sizeInTagged !== undefined) {
    const cls = ctx.classifyObject(nos);
    if (cls && cls.className === 'ScopeInfo') {
      out.scopeInfoRecord = nos;
    } else {
      const s = ctx.strings.decode(nos);
      if (s.ok) { out.name = s.value; out.nameSource = 'name_or_scope_info'; }
      else warnings.push(`SharedFunctionInfo ${record.id}: name_or_scope_info is ${cls?.className ?? 'unclassified'} (${s.why})`);
    }
  } else if (nos !== undefined) {
    const s = ctx.strings.decode(nos);
    if (s.ok) { out.name = s.value; out.nameSource = 'name_or_scope_info'; }
    // The no-shared-name sentinel is a Smi; not having a name is normal.
  }

  // ---- the outer ScopeInfo of a function that was never compiled
  out.outerScopeInfoRecord = null;
  const osi = out.outerScopeInfoOrFeedbackMetadata;
  if (osi && osi.sizeInTagged !== undefined) {
    const cls = ctx.classifyObject(osi);
    if (cls && cls.className === 'ScopeInfo') out.outerScopeInfoRecord = osi;
    else out.feedbackMetadataClass = cls?.className ?? null;
  }

  // ---- what the function data actually is
  out.functionDataClass = null;
  const fd = out.trustedFunctionData;
  if (fd && fd.sizeInTagged !== undefined) {
    const cls = ctx.classifyObject(fd);
    out.functionDataClass = cls?.className ?? null;
    out.functionDataRecord = fd;
    if (!cls) warnings.push(`SharedFunctionInfo ${record.id}: trusted_function_data has an unclassified map`);
  } else if (fd !== undefined && fd !== null && fd.k) {
    out.functionDataRef = describeRef(fd, ctx);
  }

  return out;
}

// ----------------------------------------------------------------- UncompiledData

export function decodeUncompiledData(record, className, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk(className, view);
  const F = (n) => walk.fields.get(n);
  const inferred = F('inferred_name')?.present ? ctx.strings.decode(deref(view.slot(F('inferred_name').offset))) : null;
  return {
    className,
    uncompiledDataId: record.id,
    startPosition: F('start_position')?.present
      ? view.readSignedInt(F('start_position').offset, F('start_position').size, { optional: true }) : null,
    endPosition: F('end_position')?.present
      ? view.readSignedInt(F('end_position').offset, F('end_position').size, { optional: true }) : null,
    inferredName: inferred?.ok ? inferred.value : null,
    inferredNameWhy: inferred && !inferred.ok ? inferred.why : undefined,
    hasPreparseData: walk.fields.get('preparse_data')?.present === true,
    warnings: walk.warnings,
  };
}

// --------------------------------------------------------------- array classes

/**
 * The Torque names of the variable-length payload across the array-shaped
 * classes. Hoisted so the lookup does not allocate per call.
 */
const DATA_FIELD_NAMES = ['objects', 'values', 'raw_entries', 'chars', 'bytes'];

/** Length and element offsets of any of the FixedArray-shaped classes. */
export function decodeArrayLike(record, className, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk(className, view);
  const lenRec = walk.fields.get('length');
  const length = lenRec?.present ? view.readScalar(lenRec, { optional: true }) : null;
  let dataRec = null;
  for (let i = 0; i < DATA_FIELD_NAMES.length; i++) {
    const r = walk.fields.get(DATA_FIELD_NAMES[i]);
    if (r?.present) { dataRec = r; break; }
  }
  return { className, length, view, walk, dataRec, warnings: walk.warnings };
}

/** The byte payload of a ByteArray / TrustedByteArray. */
export function byteArrayPayload(record, className, ctx) {
  const a = decodeArrayLike(record, className, ctx);
  if (a.length === null || !a.dataRec) {
    return { bytes: null, why: a.length === null ? 'length-not-serialized' : 'no-data-region', length: a.length };
  }
  const bytes = a.view.bytes(a.dataRec.offset, a.length * a.dataRec.elementSize, { optional: true });
  if (bytes === null) return { bytes: null, why: 'payload-not-serialized', length: a.length };
  return { bytes, length: a.length };
}

/** The element references of a FixedArray-shaped class. */
export function fixedArrayElements(record, className, ctx) {
  const a = decodeArrayLike(record, className, ctx);
  if (a.length === null || !a.dataRec) return { elements: null, why: 'length-or-region-missing', length: a.length };
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(deref(a.view.slot(a.dataRec.offset + i * a.dataRec.elementSize)));
  return { elements: out, length: a.length };
}

// ------------------------------------------------------------- numeric classes

export function decodeHeapNumber(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('HeapNumber', view);
  const rec = walk.fields.get('value');
  if (!rec?.present) return { ok: false, why: 'heap-number-has-no-value-field' };
  const v = view.readDouble(rec.offset, { optional: true });
  return v === null ? { ok: false, why: 'heap-number-value-not-serialized' } : { ok: true, value: v };
}

/**
 * BigInt. Its layout is C++ (`FLEXIBLE_ARRAY_MEMBER`), not Torque, so
 * layouts.json has no class for it; the offsets come from the overlay's
 * cppLayouts.BigIntBase, extracted from src/objects/bigint.h.
 */
export function decodeBigInt(record, ctx) {
  const spec = ctx.overlay.data.cppLayouts?.BigIntBase;
  if (!spec) return { ok: false, why: 'overlay-has-no-BigIntBase-layout' };
  const view = ctx.viewOf(record);
  const raw = view.readUnsignedInt(spec.bitfieldOffset, spec.bitfieldSize, { optional: true });
  if (raw === null) return { ok: false, why: 'bigint-bitfield-not-serialized' };
  // VERSION-FREE: all-ones 32-bit mask for a full-width field.
  const mask = (w) => (w >= 32 ? 0xffffffff : ((1 << w) - 1) >>> 0);
  const sign = (raw >>> spec.fields.sign.offset) & mask(spec.fields.sign.width);
  const length = (raw >>> spec.fields.length.offset) & mask(spec.fields.length.width);
  let value = 0n;
  for (let i = length - 1; i >= 0; i--) {
    const b = view.bytes(spec.digitsOffset + i * spec.digitSize, spec.digitSize, { optional: true });
    if (b === null) return { ok: false, why: 'bigint-digits-not-serialized', detail: { length, digit: i } };
    value = (value << BigInt(8 * spec.digitSize)) | b.readBigUInt64LE(0);
  }
  if (sign) value = -value;
  return { ok: true, value, length, sign: Boolean(sign) };
}

export function decodeSymbol(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('Symbol', view);
  const d = walk.fields.get('description');
  if (!d?.present) return { ok: true, description: null };
  const s = ctx.strings.decode(deref(view.slot(d.offset)));
  return { ok: true, description: s.ok ? s.value : null, why: s.ok ? undefined : s.why };
}

// ----------------------------------------------------------- boilerplate classes

export function decodeObjectBoilerplate(record, ctx) {
  const a = decodeArrayLike(record, 'ObjectBoilerplateDescription', ctx);
  const F = (n) => a.walk.fields.get(n);
  const flagsRec = F('flags');
  const bssRec = F('backing_store_size');
  const out = {
    t: 'objectBoilerplate',
    flags: flagsRec?.present ? a.view.readSmi(flagsRec.offset, { optional: true }) : null,
    backingStoreSize: bssRec?.present ? a.view.readSmi(bssRec.offset, { optional: true }) : null,
    length: a.length,
    entries: [],
  };
  if (a.length !== null && a.dataRec) {
    // raw_entries is a flat (key, value) sequence.
    const flat = [];
    for (let i = 0; i < a.length; i++) {
      flat.push(ctx.decodeValue(deref(a.view.slot(a.dataRec.offset + i * a.dataRec.elementSize))));
    }
    out.rawEntries = flat;
    for (let i = 0; i + 1 < flat.length; i += 2) out.entries.push({ key: flat[i], value: flat[i + 1] });
    if (flat.length % 2 !== 0) out.warnings = [`ObjectBoilerplateDescription ${record.id}: ${flat.length} raw entries is odd, so the last key has no value`];
  }
  return out;
}

export function decodeArrayBoilerplate(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('ArrayBoilerplateDescription', view);
  const F = (n) => walk.fields.get(n);
  const flagsRec = F('flags');
  const out = {
    t: 'arrayBoilerplate',
    flags: flagsRec?.present ? view.readSmi(flagsRec.offset, { optional: true }) : null,
    elementsKind: null,
    elements: null,
  };
  if (out.flags !== null) out.elementsKind = ctx.enumName('ElementsKind', out.flags);
  const ceRec = F('constant_elements');
  if (ceRec?.present) {
    const ce = deref(view.slot(ceRec.offset));
    if (ce && ce.sizeInTagged !== undefined) {
      const cls = ctx.classifyObject(ce);
      if (cls && /FixedArray$/.test(cls.className)) {
        const r = fixedArrayElements(ce, cls.className, ctx);
        out.elements = r.elements ? r.elements.map((e) => ctx.decodeValue(e)) : null;
        if (!r.elements) out.why = r.why;
      } else if (cls) {
        out.why = `constant_elements is ${cls.className}, which this reader does not decode`;
        out.elementsClass = cls.className;
      } else {
        // The usual case here is FixedDoubleArray (an array literal of
        // doubles). Its layout is @cppObjectLayoutDefinition, so layouts.json
        // carries no class for it and its Torque element type
        // (float64_or_undefined_or_hole) is a 9-byte Torque struct rather than
        // the 8-byte on-heap double, which means the element size cannot be
        // taken from the profile either. Reported by map name rather than
        // decoded with a guessed stride.
        const mapName = ctx.classifier.mapName(ce.map);
        out.elementsClass = mapName;
        out.why = mapName
          ? `constant_elements has map ${mapName}, for which layouts.json has no class`
          : 'constant_elements has an unnamed map';
        ctx.note(`arrayBoilerplate:no-layout-for-elements:${mapName ?? 'unnamed'}`, { objectId: record.id });
      }
    } else {
      const u = ctx.decodeValue(ce);
      out.elementsRef = u;
      // `[]` stores the canonical empty_fixed_array root.
      if (u && u.t === 'rootObject' && u.isEmpty) out.elements = [];
      else out.why = u?.why ?? `constant_elements is ${u?.t ?? 'an unexpected reference'}`;
    }
  }
  return out;
}

export function decodeRegExpBoilerplate(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('RegExpBoilerplateDescription', view);
  const F = (n) => walk.fields.get(n);
  const srcRec = F('source');
  const flagsRec = F('flags');
  const s = srcRec?.present ? ctx.strings.decode(deref(view.slot(srcRec.offset))) : null;
  const rawFlags = flagsRec?.present ? view.readSmi(flagsRec.offset, { optional: true }) : null;
  const out = { t: 'regexpBoilerplate', source: s?.ok ? s.value : null, flags: rawFlags };
  if (!s?.ok) out.sourceWhy = s?.why ?? 'no-source-field';
  if (rawFlags !== null) {
    const expanded = ctx.expandBitfieldOptional('JSRegExpFlags', rawFlags);
    if (expanded) {
      out.flagBits = expanded;
      out.flagString = regExpFlagString(expanded);
    }
  }
  return out;
}

/** JSRegExpFlags bit names map onto the source-visible flag letters. */
const REGEXP_FLAG_LETTERS = [
  ['has_indices', 'd'], ['global', 'g'], ['ignore_case', 'i'], ['multiline', 'm'],
  ['dot_all', 's'], ['unicode', 'u'], ['unicode_sets', 'v'], ['sticky', 'y'],
];
function regExpFlagString(bits) {
  // V8 prints flags in the order the spec lists them, which is the order above.
  return REGEXP_FLAG_LETTERS.filter(([n]) => bits[n] === 1).map(([, l]) => l).join('');
}

export function decodeTemplateObjectDescription(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('TemplateObjectDescription', view);
  const F = (n) => walk.fields.get(n);
  const read = (fieldName) => {
    const rec = F(fieldName);
    if (!rec?.present) return { list: null, why: 'field-absent' };
    const arr = deref(view.slot(rec.offset));
    if (!arr || arr.sizeInTagged === undefined) return { list: null, why: 'not-a-deserialized-array', ref: ctx.decodeValue(arr) };
    const cls = ctx.classifyObject(arr);
    if (!cls) return { list: null, why: 'unclassified-map' };
    const r = fixedArrayElements(arr, cls.className, ctx);
    if (!r.elements) return { list: null, why: r.why };
    return { list: r.elements.map((e) => ctx.decodeValue(e)) };
  };
  const raw = read('raw_strings');
  const cooked = read('cooked_strings');
  const out = { t: 'templateObject', raw: raw.list, cooked: cooked.list };
  if (!raw.list) out.rawWhy = raw.why;
  if (!cooked.list) out.cookedWhy = cooked.why;
  return out;
}

export default {
  describeRef, deref, decodeScopeInfo, decodeSharedFunctionInfo, decodeUncompiledData,
  decodeArrayLike, byteArrayPayload, fixedArrayElements,
  decodeHeapNumber, decodeBigInt, decodeSymbol,
  decodeObjectBoilerplate, decodeArrayBoilerplate, decodeRegExpBoilerplate,
  decodeTemplateObjectDescription,
};
