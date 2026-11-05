// src/heap/index.mjs
//
// The typed-object layer: slot-level graph -> `FunctionUnit[]`.
//
// `HeapContext` holds the per-file decode state (views, layout walks, the
// read-only resolver, the string decoder) and the counters that make every
// failure visible. `buildUnits` produces the structure docs/ARCHITECTURE.md
// 8.1 specifies, with one documented deviation, recorded in docs/FRONTEND.md:
// a `SwitchOnSmiNoFeedback` jump table is not an array object in V8, it is a
// run of consecutive constant-pool slots, so it surfaces as
// `constantPoolSmiRuns` rather than as a single `{t:'smiArray'}` entry.

import { LayoutResolver } from './layout.mjs';
import { HeapView } from './view.mjs';
import { MapClassifier } from './classify.mjs';
import { RoRefResolver } from './roref.mjs';
import { StringDecoder } from './strings.mjs';
import { HandlerTableDecoder } from './handlertable.mjs';
import { SourcePositionTableDecoder } from './sourceposition.mjs';
import * as O from './objects.mjs';

export { LayoutResolver } from './layout.mjs';
export { HeapView } from './view.mjs';
export { MapClassifier } from './classify.mjs';
export { RoRefResolver } from './roref.mjs';
export { StringDecoder } from './strings.mjs';
export { HandlerTableDecoder } from './handlertable.mjs';
export { SourcePositionTableDecoder } from './sourceposition.mjs';

const STRING_CLASSES = new Set(['SeqOneByteString', 'SeqTwoByteString', 'ConsString', 'SlicedString', 'ThinString', 'ExternalString']);
const FIXED_ARRAY_CLASSES = new Set(['FixedArray', 'TrustedFixedArray', 'ProtectedFixedArray']);
const BYTE_ARRAY_CLASSES = new Set(['ByteArray', 'TrustedByteArray']);
const UNCOMPILED_CLASSES = new Set([
  'UncompiledData',
  'UncompiledDataWithoutPreparseData',
  'UncompiledDataWithPreparseData',
  'UncompiledDataWithoutPreparseDataWithJob',
  'UncompiledDataWithPreparseDataAndJob',
]);

export class HeapContext {
  /**
   * @param {object} env  a CacheEnvironment from src/cache
   * @param {object} graph the deserializer result
   */
  constructor(env, graph, opts = {}) {
    this.profile = env.profile;
    this.overlayObj = env.overlay;
    this.graph = graph;
    this.layout = opts.layout ?? new LayoutResolver(env.profile, env.overlay);
    this.roRefs = opts.roRefs ?? new RoRefResolver(env.roHeap, env.profile);
    this.classifier = opts.classifier ?? new MapClassifier(this.layout, this.roRefs);
    this.strings = new StringDecoder(this);
    this.handlerTables = opts.handlerTables ?? new HandlerTableDecoder(env.profile);
    this.sourcePositions = opts.sourcePositions ?? new SourcePositionTableDecoder(env.profile, env.overlay);
    this.maxScopeChainDepth = opts.maxScopeChainDepth ?? 64;

    this.views = new Map();
    this.walks = new Map();
    this.classes = new Map();
    this.scopeInfoCache = new Map();
    const tg = env.profile.constants.tagging;
    this.smiShift = tg.kSmiTagSize + tg.kSmiShiftSize;
    this.smiShiftBig = BigInt(this.smiShift);
    this.bitfieldCache = new Map();
    this.enumIndex = new Map();

    this.unresolvedByCategory = new Map();
    this.warnings = [];
  }

  get overlay() { return this.overlayObj; }

  note(category, detail) {
    const e = this.unresolvedByCategory.get(category) ?? { count: 0, samples: [] };
    e.count++;
    if (detail !== undefined && e.samples.length < 5) e.samples.push(detail);
    this.unresolvedByCategory.set(category, e);
  }

  viewOf(record) {
    let v = this.views.get(record.id);
    if (!v) { v = new HeapView(record, this); this.views.set(record.id, v); }
    return v;
  }

  walk(className, view) {
    const key = `${view.record.id}|${className}`;
    let w = this.walks.get(key);
    if (!w) { w = this.layout.walk(className, view); this.walks.set(key, w); }
    return w;
  }

  classifyObject(record) {
    if (this.classes.has(record.id)) return this.classes.get(record.id);
    const c = this.classifier.classifyMap(record.map);
    this.classes.set(record.id, c);
    if (!c) {
      const name = this.classifier.mapName(record.map);
      if (name) this.note(`noLayoutForClass:${name}`, { objectId: record.id });
      else this.note('unnamed-map-word', { objectId: record.id });
    }
    return c;
  }

  /**
   * Expand a bitfield struct into named members.
   *
   * A plain object literal rather than Object.create(null): the key set and the
   * insertion order are identical every time, so V8 reuses one hidden class,
   * while a null-prototype object goes to dictionary mode and makes every
   * property add a hash insert. This is called once per SharedFunctionInfo,
   * once per ScopeInfo and once per context local.
   */
  expandBitfield(structName, raw) {
    let spec = this.bitfieldCache.get(structName);
    if (spec === undefined) {
      spec = this.profile.bitfieldOf(structName).fields.map((f) => ({
        name: f.name,
        offset: f.offset,
        // VERSION-FREE: all-ones 32-bit mask for a full-width field.
        mask: f.width >= 32 ? 0xffffffff : ((1 << f.width) - 1) >>> 0,
      }));
      this.bitfieldCache.set(structName, spec);
    }
    const out = {};
    for (let i = 0; i < spec.length; i++) {
      const f = spec[i];
      out[f.name] = (raw >>> f.offset) & f.mask;
    }
    return out;
  }

  expandBitfieldOptional(structName, raw) {
    try { return this.expandBitfield(structName, raw); } catch { return null; }
  }

  /**
   * Name an enum value. The overlay wins over layouts.json, because for an
   * `extern enum` Torque states only the names and C++ states the values; the
   * two disagree for LanguageMode and ElementsKind. When the overlay's copy is
   * a partial extraction, a value beyond its extracted prefix resolves to null
   * rather than falling back to the table that is known to be shifted.
   */
  enumName(enumName, value) {
    let idx = this.enumIndex.get(enumName);
    if (!idx) {
      const o = this.overlayObj.data.enums[enumName];
      const p = this.profile.tables.layouts.enums?.[enumName];
      const chosen = o ?? p;
      idx = { map: new Map(), partial: Boolean(o?.partial), completeUpTo: o?.completeUpTo ?? null };
      for (const [k, v] of Object.entries(chosen?.members ?? {})) if (!idx.map.has(v)) idx.map.set(v, k);
      this.enumIndex.set(enumName, idx);
    }
    const hit = idx.map.get(value);
    if (hit !== undefined) return hit;
    if (idx.partial && value > idx.completeUpTo) {
      this.note(`enum:${enumName}:beyond-extracted-prefix`, { value });
    }
    return null;
  }

  // ------------------------------------------------------- the tagged union

  /** Decode any slot content into the FunctionUnit constant union. */
  decodeValue(ref) {
    const simple = O.describeRef(ref, this);
    if (simple) {
      if (simple.t === 'unresolved') this.note(`constant:${simple.why}`, simple.detail);
      else if (simple.t === 'roRef' && simple.resolved === undefined) this.note('constant:unresolved-read-only-ref', { chunk: simple.chunk, offset: simple.offset });
      return simple;
    }

    const record = ref;
    const cls = this.classifyObject(record);
    if (!cls) {
      // Name the map even when there is no class for it: `<ClassBoilerplate>`
      // is a very different report from "something unidentifiable".
      const mapName = this.classifier.mapName(record.map);
      return {
        t: 'unresolved',
        why: mapName ? 'no-layouts-class-for-map' : 'unnamed-map-word',
        detail: { objectId: record.id, mapName: mapName ?? null },
      };
    }
    const name = cls.className;

    if (STRING_CLASSES.has(name)) {
      const s = this.strings.decode(record);
      if (s.ok) return { t: 'string', v: s.value };
      this.note(`constant:string:${s.why}`, s.detail);
      return { t: 'unresolved', why: s.why, detail: { ...(s.detail ?? {}), className: name } };
    }
    if (name === 'HeapNumber') {
      const n = O.decodeHeapNumber(record, this);
      if (n.ok) return { t: 'number', v: n.value };
      this.note(`constant:${n.why}`);
      return { t: 'unresolved', why: n.why };
    }
    if (name === 'BigInt' || name === 'BigIntBase') {
      const n = O.decodeBigInt(record, this);
      if (n.ok) return { t: 'bigint', v: n.value.toString() };
      this.note(`constant:${n.why}`, n.detail);
      return { t: 'unresolved', why: n.why, detail: n.detail };
    }
    if (name === 'Symbol') {
      const s = O.decodeSymbol(record, this);
      return { t: 'symbol', desc: s.description };
    }
    if (name === 'SharedFunctionInfo') return { t: 'sfi', sfiId: record.id };
    if (name === 'ScopeInfo') return { t: 'scopeInfo', scopeInfoId: record.id };
    if (name === 'ObjectBoilerplateDescription') return O.decodeObjectBoilerplate(record, this);
    if (name === 'ArrayBoilerplateDescription') return O.decodeArrayBoilerplate(record, this);
    if (name === 'RegExpBoilerplateDescription') return O.decodeRegExpBoilerplate(record, this);
    if (name === 'TemplateObjectDescription') return O.decodeTemplateObjectDescription(record, this);
    if (name === 'ClassBoilerplate') return O.decodeClassBoilerplate(record, this);

    if (FIXED_ARRAY_CLASSES.has(name)) {
      const r = O.fixedArrayElements(record, name, this);
      if (!r.elements) {
        this.note(`constant:array:${r.why}`, { objectId: record.id, className: name });
        return { t: 'unresolved', why: r.why, detail: { className: name } };
      }
      const decoded = r.elements.map((e) => this.decodeValue(e));
      // A FixedArray of nothing but Smis is a value array (the contract's smiArray).
      if (decoded.length > 0 && decoded.every((d) => d.t === 'number' && d.repr === 'smi')) {
        return { t: 'smiArray', values: decoded.map((d) => d.v), arrayClass: name };
      }
      return { t: 'array', className: name, values: decoded };
    }
    if (BYTE_ARRAY_CLASSES.has(name)) {
      const p = O.byteArrayPayload(record, name, this);
      if (!p.bytes) {
        this.note(`constant:byteArray:${p.why}`, { objectId: record.id });
        return { t: 'unresolved', why: p.why, detail: { className: name } };
      }
      return { t: 'byteArray', className: name, length: p.length, bytes: p.bytes };
    }

    this.note(`constant:class-not-decoded:${name}`, { objectId: record.id });
    return { t: 'unresolved', why: 'class-not-decoded', detail: { className: name, objectId: record.id } };
  }

  // ------------------------------------------------------------- the report

  unresolvedReport(limit = 40) {
    const rows = [...this.unresolvedByCategory.entries()]
      .map(([category, v]) => ({ category, count: v.count, samples: v.samples }))
      .sort((a, b) => b.count - a.count);
    return { total: rows.reduce((s, r) => s + r.count, 0), categories: rows.slice(0, limit), distinct: rows.length };
  }
}

// --------------------------------------------------------------- BytecodeArray

function decodeBytecodeArray(record, ctx) {
  const view = ctx.viewOf(record);
  const walk = ctx.walk('BytecodeArray', view);
  const warnings = [...walk.warnings];
  const F = (n) => walk.fields.get(n);
  const num = (n, signed = true) => {
    const rec = F(n);
    if (!rec?.present) { warnings.push(`BytecodeArray ${record.id}: field ${n} is absent`); return null; }
    const v = signed ? view.readSignedInt(rec.offset, rec.size, { optional: true })
      : view.readUnsignedInt(rec.offset, rec.size, { optional: true });
    if (v === null) warnings.push(`BytecodeArray ${record.id}: field ${n} was not serialized`);
    return v;
  };

  const lengthRec = F('length');
  const length = lengthRec?.present ? view.readSmi(lengthRec.offset, { optional: true }) : null;
  const frameSize = num('frame_size', true);
  const parameterCount = num('parameter_size', false);
  const maxArguments = num('max_arguments', false);
  const incomingRaw = num('incoming_new_target_or_generator_register', true);

  let bytecode = null;
  const bytesRec = F('bytes');
  if (length !== null && bytesRec?.present) {
    bytecode = view.bytes(bytesRec.offset, length * bytesRec.elementSize, { optional: true });
    if (bytecode === null) warnings.push(`BytecodeArray ${record.id}: ${length} bytes of bytecode were not serialized`);
  }

  const sysPtr = ctx.profile.constants.sizes.kSystemPointerSize;
  return {
    bytecodeId: record.id,
    bytecode,
    bytecodeLength: length,
    frameSize,
    // BytecodeArray::register_count() == frame_size() / kSystemPointerSize
    registerCount: frameSize === null ? null : Math.trunc(frameSize / sysPtr),
    // BytecodeArray::parameter_count() is the parameter_size field and counts
    // the receiver; parameter_count_without_receiver() subtracts it. V8's
    // --print-bytecode prints the former.
    parameterCount,
    parameterCountWithoutReceiver: parameterCount === null ? null : parameterCount - 1,
    maxArguments,
    // 0 means Register::invalid_value(); any other value is a register operand,
    // decoded by the disassembly layer (ARCHITECTURE.md 8.3).
    incomingNewTargetOrGeneratorRegister: incomingRaw === 0 ? null : incomingRaw,
    incomingNewTargetOrGeneratorRegisterRaw: incomingRaw,
    constantPoolRef: F('constant_pool')?.present ? O.deref(view.slot(F('constant_pool').offset)) : undefined,
    handlerTableRef: F('handler_table')?.present ? O.deref(view.slot(F('handler_table').offset)) : undefined,
    sourcePositionTableRef: F('source_position_table')?.present ? O.deref(view.slot(F('source_position_table').offset)) : undefined,
    warnings,
  };
}

const EMPTY = Buffer.alloc(0);

/** Decode a protected pointer that should be a byte-array side table. */
function sideTableBytes(ref, ctx, what) {
  if (ref === undefined || ref === null) return { bytes: null, why: 'slot-absent' };
  if (ref.k !== undefined) {
    // No handlers / no source positions is spelled as the canonical
    // empty_trusted_byte_array root, which is a root reference, not an object.
    if (O.isEmptyRoot(ref)) return { bytes: EMPTY, why: null, empty: true, rootName: ref.root.cppName };
    const u = O.describeRef(ref, ctx);
    return { bytes: null, why: u?.t === 'unresolved' ? u.why : `${what}-is-${u?.t ?? ref.k}`, ref: u };
  }
  const cls = ctx.classifyObject(ref);
  if (!cls) return { bytes: null, why: 'unclassified-map' };
  if (!BYTE_ARRAY_CLASSES.has(cls.className)) return { bytes: null, why: `${what}-is-${cls.className}` };
  const p = O.byteArrayPayload(ref, cls.className, ctx);
  return { bytes: p.bytes, why: p.why ?? null, length: p.length };
}

function constantPoolEntries(ref, ctx) {
  if (ref === undefined || ref === null) return { entries: [], why: 'slot-absent' };
  if (ref.k !== undefined) {
    // An empty pool is the empty_trusted_fixed_array root.
    if (O.isEmptyRoot(ref)) return { entries: [], why: null, rootName: ref.root.cppName };
    const u = O.describeRef(ref, ctx);
    return { entries: [], rootRef: u, why: `constant-pool-is-${u?.t === 'unresolved' ? u.why : (u?.t ?? ref.k)}` };
  }
  const cls = ctx.classifyObject(ref);
  if (!cls) return { entries: [], why: 'unclassified-map' };
  if (!FIXED_ARRAY_CLASSES.has(cls.className)) return { entries: [], why: `constant-pool-is-${cls.className}` };
  const r = O.fixedArrayElements(ref, cls.className, ctx);
  if (!r.elements) return { entries: [], why: r.why };
  return { entries: r.elements.map((e) => ctx.decodeValue(e)), poolClass: cls.className, poolId: ref.id };
}

/** Maximal runs of >= 2 consecutive Smi constants: the jump-table shape. */
function smiRuns(constants) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= constants.length; i++) {
    const isSmi = i < constants.length && constants[i].t === 'number' && constants[i].repr === 'smi';
    if (isSmi && start < 0) start = i;
    if (!isSmi && start >= 0) {
      if (i - start >= 2) runs.push({ start, length: i - start, values: constants.slice(start, i).map((c) => c.v) });
      start = -1;
    }
  }
  return runs;
}

// -------------------------------------------------------------- FunctionUnit

/**
 * Build every FunctionUnit in a decoded cache.
 *
 * @param {object} env   CacheEnvironment
 * @param {object} graph the deserializer result
 * @param {{maxScopeChainDepth?: number, decodeScopes?: boolean, keepBytecode?: boolean}} opts
 */
export function buildUnits(env, graph, opts = {}) {
  const ctx = opts.ctx ?? new HeapContext(env, graph, opts);
  const decodeScopes = opts.decodeScopes !== false;

  // Index every object by class once.
  const byClass = new Map();
  for (const rec of graph.objects) {
    const cls = ctx.classifyObject(rec);
    const key = cls?.className ?? '(unclassified)';
    (byClass.get(key) ?? byClass.set(key, []).get(key)).push(rec);
  }

  const sfis = byClass.get('SharedFunctionInfo') ?? [];
  const units = [];
  const unitBySfiId = new Map();

  const scopeFor = (record) => (record ? O.decodeScopeInfo(record, ctx) : null);

  for (const rec of sfis) {
    const sfi = O.decodeSharedFunctionInfo(rec, ctx);
    const warnings = [...sfi.warnings];

    const unit = {
      // ---- identity
      sfiId: sfi.sfiId,
      bytecodeId: null,
      functionLiteralId: sfi.functionLiteralId,
      name: sfi.name,
      kind: sfi.kind,
      functionKindName: sfi.functionKindName,
      functionSyntaxKind: sfi.functionSyntaxKind,
      isGenerator: sfi.isGenerator,
      isAsync: sfi.isAsync,
      isStrict: sfi.isStrict,
      isTopLevel: sfi.isTopLevel ?? null,
      startPosition: null,
      endPosition: null,
      formalParameterCount: sfi.formalParameterCount,
      functionTokenOffset: sfi.functionTokenOffset,
      expectedNofProperties: sfi.expectedNofProperties,
      uniqueId: sfi.uniqueId,

      // ---- bytecode body
      bytecode: null,
      bytecodeLength: null,
      frameSize: null,
      parameterCount: null,
      parameterCountWithoutReceiver: null,
      maxArguments: null,
      registerCount: null,
      incomingNewTargetOrGeneratorRegister: null,

      constants: [],
      constantPoolSmiRuns: [],
      handlers: [],
      sourcePositions: [],
      scope: null,
      uncompiled: null,
      children: [],
      warnings,
      sfiFlags: sfi.flags,
      sfiFlags2: sfi.flags2,
      functionDataClass: sfi.functionDataClass,
    };

    // ---- scope: either name_or_scope_info is the ScopeInfo (compiled), or
    // outer_scope_info_or_feedback_metadata is the outer one (not compiled).
    if (decodeScopes) {
      if (sfi.scopeInfoRecord) {
        unit.scope = scopeFor(sfi.scopeInfoRecord);
        unit.scopeSource = 'name_or_scope_info';
      } else if (sfi.outerScopeInfoRecord) {
        unit.scope = null;
        unit.outerScope = scopeFor(sfi.outerScopeInfoRecord);
        unit.scopeSource = 'outer_scope_info (function was not compiled)';
      }
      // V8 derives a function's name from its ScopeInfo when
      // name_or_scope_info holds the ScopeInfo rather than a String.
      if (unit.name === null && unit.scope) {
        unit.name = unit.scope.functionVariable?.name ?? unit.scope.inferredFunctionName ?? null;
        if (unit.name !== null) unit.nameSource = 'scopeInfo';
      }
      if (unit.scope?.positionInfo) {
        unit.startPosition = unit.scope.positionInfo.start;
        unit.endPosition = unit.scope.positionInfo.end;
        unit.positionSource = 'scopeInfo.position_info';
      }
    }

    // ---- the function data: BytecodeArray (compiled) or UncompiledData (not)
    const fdClass = sfi.functionDataClass;
    if (fdClass === 'BytecodeArray') {
      const ba = decodeBytecodeArray(sfi.functionDataRecord, ctx);
      warnings.push(...ba.warnings);
      unit.bytecodeId = ba.bytecodeId;
      unit.bytecode = opts.keepBytecode === false ? null : ba.bytecode;
      unit.bytecodeLength = ba.bytecodeLength;
      unit.frameSize = ba.frameSize;
      unit.parameterCount = ba.parameterCount;
      unit.parameterCountWithoutReceiver = ba.parameterCountWithoutReceiver;
      unit.maxArguments = ba.maxArguments;
      unit.registerCount = ba.registerCount;
      unit.incomingNewTargetOrGeneratorRegister = ba.incomingNewTargetOrGeneratorRegister;

      const pool = constantPoolEntries(ba.constantPoolRef, ctx);
      unit.constants = pool.entries;
      unit.constantPoolId = pool.poolId ?? null;
      if (pool.why) { warnings.push(`constant pool: ${pool.why}`); ctx.note(`constantPool:${pool.why}`, { sfiId: sfi.sfiId }); }
      unit.constantPoolSmiRuns = smiRuns(unit.constants);

      const ht = sideTableBytes(ba.handlerTableRef, ctx, 'handler_table');
      if (ht.bytes) {
        const d = ctx.handlerTables.decode(ht.bytes);
        unit.handlers = d.entries;
        warnings.push(...d.warnings);
      } else if (ht.why) {
        warnings.push(`handler table: ${ht.why}`);
        ctx.note(`handlerTable:${ht.why}`, { sfiId: sfi.sfiId });
      }
      unit.handlerTableBytes = ht.bytes ? ht.bytes.length : 0;

      const sp = sideTableBytes(ba.sourcePositionTableRef, ctx, 'source_position_table');
      if (sp.bytes) {
        const d = ctx.sourcePositions.decode(sp.bytes);
        unit.sourcePositions = d.entries;
        warnings.push(...d.warnings);
      } else if (sp.why) {
        warnings.push(`source position table: ${sp.why}`);
        ctx.note(`sourcePositionTable:${sp.why}`, { sfiId: sfi.sfiId });
      }
      unit.sourcePositionTableBytes = sp.bytes ? sp.bytes.length : 0;
      unit.compiled = true;
    } else if (fdClass && UNCOMPILED_CLASSES.has(fdClass)) {
      const u = O.decodeUncompiledData(sfi.functionDataRecord, fdClass, ctx);
      warnings.push(...u.warnings);
      unit.compiled = false;
      unit.uncompiled = {
        startPosition: u.startPosition,
        endPosition: u.endPosition,
        inferredName: u.inferredName,
        className: fdClass,
        hasPreparseData: u.hasPreparseData,
      };
      if (unit.startPosition === null) { unit.startPosition = u.startPosition; unit.positionSource = 'uncompiledData'; }
      if (unit.endPosition === null) unit.endPosition = u.endPosition;
      if (unit.name === null && u.inferredName) { unit.name = u.inferredName; unit.nameSource = 'uncompiledData.inferred_name'; }
    } else {
      unit.compiled = false;
      const why = fdClass ? `function-data-is-${fdClass}` : 'function-data-unclassified';
      warnings.push(`SharedFunctionInfo ${sfi.sfiId}: ${why}`);
      ctx.note(`functionData:${why}`, { sfiId: sfi.sfiId, ref: sfi.functionDataRef });
    }

    units.push(unit);
    unitBySfiId.set(unit.sfiId, unit);
  }

  // ---- the SFI tree: a parent's constant pool names its inner functions.
  const byLiteralId = new Map();
  for (const u of units) {
    if (u.functionLiteralId === null || u.functionLiteralId === undefined) continue;
    if (byLiteralId.has(u.functionLiteralId)) {
      u.warnings.push(`function_literal_id ${u.functionLiteralId} is claimed by more than one SharedFunctionInfo`);
      ctx.note('duplicate-function-literal-id', { functionLiteralId: u.functionLiteralId, sfiId: u.sfiId });
      continue;
    }
    byLiteralId.set(u.functionLiteralId, u);
  }
  for (const u of units) {
    for (const c of u.constants) {
      if (c.t !== 'sfi') continue;
      const child = unitBySfiId.get(c.sfiId);
      if (!child) { ctx.note('constant-sfi-not-in-graph', { sfiId: c.sfiId }); continue; }
      u.children.push({ sfiId: child.sfiId, functionLiteralId: child.functionLiteralId });
      if (child.parentSfiId === undefined) child.parentSfiId = u.sfiId;
    }
  }
  for (const u of units) if (u.parentSfiId === undefined) u.parentSfiId = null;

  // ---- BytecodeArrays reached by no SharedFunctionInfo
  const claimed = new Set(units.map((u) => u.bytecodeId).filter((x) => x !== null));
  const orphanBytecode = (byClass.get('BytecodeArray') ?? []).filter((b) => !claimed.has(b.id)).map((b) => b.id);
  if (orphanBytecode.length) ctx.note('bytecode-array-with-no-sfi', { ids: orphanBytecode.slice(0, 5) });

  const classCounts = Object.fromEntries([...byClass.entries()].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]));

  return {
    ctx,
    units,
    unitBySfiId,
    unitByFunctionLiteralId: byLiteralId,
    rootSfiId: graph.root && graph.root.sizeInTagged !== undefined ? graph.root.id : null,
    stats: {
      objects: graph.objects.length,
      classCounts,
      units: units.length,
      compiled: units.filter((u) => u.compiled).length,
      uncompiled: units.filter((u) => !u.compiled).length,
      orphanBytecodeArrays: orphanBytecode.length,
      scopeInfos: ctx.scopeInfoCache.size,
      stringStats: ctx.strings.stats,
    },
    reports: {
      unresolved: ctx.unresolvedReport(),
      roRefs: ctx.roRefs.report(),
      maps: ctx.classifier.report(),
    },
  };
}

/**
 * Context-slot naming rate: of all context slots the scope chains describe, how
 * many carry a real name? This is the number ARCHITECTURE.md 4.5 depends on --
 * every named slot is one `ctx[d][i]` the back end does not have to invent.
 */
export function contextSlotNamingStats(units) {
  const seen = new Set();
  let total = 0;
  let named = 0;
  let scopes = 0;
  let viaInlined = 0;
  let viaHashtable = 0;
  const byScopeType = new Map();

  const visit = (scope) => {
    if (!scope || scope.scopeInfoId === undefined || seen.has(scope.scopeInfoId)) return;
    seen.add(scope.scopeInfoId);
    scopes++;
    const n = scope.contextLocalCount ?? 0;
    const names = scope.contextLocalNames ?? [];
    let localNamed = 0;
    for (let i = 0; i < n; i++) if (typeof names[i] === 'string' && names[i].length >= 0 && names[i] !== null) localNamed++;
    total += n;
    named += localNamed;
    if (scope.contextLocalNamesSource === 'inlined') viaInlined += localNamed;
    if (scope.contextLocalNamesSource === 'hashtable') viaHashtable += localNamed;
    const key = scope.scopeType ?? 'unknown';
    const e = byScopeType.get(key) ?? { slots: 0, named: 0, scopes: 0 };
    e.slots += n; e.named += localNamed; e.scopes++;
    byScopeType.set(key, e);
    visit(scope.outer);
  };

  for (const u of units) { visit(u.scope); visit(u.outerScope); }

  return {
    scopes,
    contextSlots: total,
    namedSlots: named,
    anonymousSlots: total - named,
    rate: total ? named / total : null,
    viaInlined,
    viaHashtable,
    byScopeType: Object.fromEntries([...byScopeType.entries()].sort((a, b) => b[1].slots - a[1].slots)),
  };
}

export default { HeapContext, buildUnits, contextSlotNamingStats };
