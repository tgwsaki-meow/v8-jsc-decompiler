// src/heap/layout.mjs
//
// The layout-program walker.
//
// A Torque class is not a fixed set of offsets. Fields can be
//   * absent, under `?[condition]`
//   * variable-length, under `[count]`
// and either makes every later field's offset depend on the object's own data.
// ScopeInfo is almost entirely of this kind: 18 declared fields, 7 conditional,
// 3 variable-length regions.
//
// So decoding is a *walk*: start at the parent's size, and for each declared
// field in order decide whether it is there and how wide it is, reading the
// values earlier fields hold in order to answer that. Field names, order,
// conditions and counts all come from the profile (plus the overlay for the
// fields the profile dropped). This file states no offset of its own.
//
// Nothing here indexes by slot number. `src/deserializer.js` reached fields as
// `slots[4]` / `slots[5]`; here every access is `layout.read(view, 'name')`,
// so a field moving between versions is a data change, not a code change.

import { loadOverlay } from '../cache/overlay.mjs';

export class LayoutError extends Error {}

/** Evaluate the Torque expression ASTs layouts.json and the overlay carry. */
class ExpressionEvaluator {
  constructor(resolver, fieldValue, rawFieldValue) {
    this.resolver = resolver;
    this.fieldValue = fieldValue;       // name -> scalar already decoded
    this.rawFieldValue = rawFieldValue; // name -> {bitfieldStruct, raw}
  }

  eval(node) {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'name': {
        if (Object.prototype.hasOwnProperty.call(this.fieldValue, node.name)) return this.fieldValue[node.name];
        const c = this.resolver.namedConstant(node.name);
        if (c !== undefined) return c;
        throw new LayoutError(`layout expression references ${node.name}, which is neither an earlier field nor a known constant`);
      }
      case 'member': {
        if (node.object.kind !== 'name') throw new LayoutError('layout expression: only one level of member access is supported');
        const holder = node.object.name;
        const rec = this.rawFieldValue[holder];
        if (!rec) throw new LayoutError(`layout expression reads ${holder}.${node.field} before ${holder} was decoded`);
        if (!rec.bitfieldStruct) throw new LayoutError(`${holder} is not a bitfield, so ${holder}.${node.field} cannot be read`);
        return this.resolver.readBitfield(rec.bitfieldStruct, node.field, rec.raw);
      }
      case 'enumRef':
        return this.resolver.enumValue(node.enum, node.member);
      case 'binary': {
        const a = this.eval(node.left);
        const b = this.eval(node.right);
        switch (node.op) {
          case '==': return a === b;
          case '!=': return a !== b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
          default: throw new LayoutError(`layout expression: unsupported operator ${node.op}`);
        }
      }
      case 'ternary':
        return this.eval(node.cond) ? this.eval(node.then) : this.eval(node.else);
      case 'cast':
        return this.eval(node.expr);
      default:
        throw new LayoutError(`layout expression: unsupported node kind ${node.kind}`);
    }
  }
}

/**
 * Per-profile layout resolver. Build one and reuse it: it caches the flattened
 * field program of every class it is asked about.
 */
export class LayoutResolver {
  /**
   * @param {import('../profile/index.mjs').Profile} profile
   * @param {import('../cache/overlay.mjs').Overlay} overlay
   */
  constructor(profile, overlay) {
    this.profile = profile;
    this.overlay = overlay ?? loadOverlay(profile.version);
    this.taggedSize = profile.taggedSize;
    this.programs = new Map();
    this.classIndexCI = new Map();
    for (const name of Object.keys(profile.tables.layouts.classes)) {
      this.classIndexCI.set(name.toLowerCase(), name);
    }
    // Torque `const X: constexpr T generates 'Y'` -> constants.globals.Y
    this.generatesConsts = Object.create(null);
    for (const cls of Object.values(this.overlay.data.classes)) {
      Object.assign(this.generatesConsts, cls.generatesConsts ?? {});
    }
  }

  /** A class name that exists in layouts.json, matched case-insensitively. */
  resolveClassName(candidate) {
    if (!candidate) return null;
    return this.classIndexCI.get(String(candidate).toLowerCase()) ?? null;
  }

  namedConstant(name) {
    const g = this.profile.constants.globals ?? {};
    const alias = this.generatesConsts[name];
    if (alias !== undefined && g[alias] !== undefined) return g[alias];
    if (g[name] !== undefined) return g[name];
    const si = this.profile.constants.scopeInfo ?? {};
    if (si[name] !== undefined) return si[name];
    return undefined;
  }

  /** Overlay enums win: for an `extern enum` only C++ states the values. */
  enumValue(enumName, member) {
    const o = this.overlay.data.enums[enumName];
    if (o && o.members[member] !== undefined) return o.members[member];
    const p = this.profile.tables.layouts.enums?.[enumName];
    if (p && p.members[member] !== undefined) return p.members[member];
    throw new LayoutError(`no value for ${enumName}::${member} in the overlay or in layouts.json`);
  }

  readBitfield(structName, fieldName, raw) {
    return this.profile.readBitfield(structName, fieldName, raw);
  }

  /**
   * The flattened field program of a class: inherited fields (always static)
   * followed by the class's own declared fields, overlay-patched when the
   * profile dropped any.
   *
   * The program is split at the first field whose presence or width depends on
   * the object's data. Everything before that point has a fixed offset for
   * every instance of the class, so it is computed once and shared; only the
   * tail is walked per object. For SharedFunctionInfo the tail is empty, which
   * means its walk costs nothing after the first object.
   */
  program(className) {
    const cached = this.programs.get(className);
    if (cached) return cached;
    const cls = this.profile.layoutOf(className);
    const inherited = (cls.allFields ?? []).filter((f) => f.declaredIn !== className);
    const ownFromOverlay = this.overlay.classFields(className);
    const own = ownFromOverlay ?? (cls.fields ?? []);
    const fields = [...inherited, ...own].map((f) => normalizeField(f, this));

    const firstDynamic = fields.findIndex((f) => !f.gatedOut && (f.conditional || f.indexed));
    const cut = firstDynamic < 0 ? fields.length : firstDynamic;

    const staticFields = new Map();
    let offset = 0;
    for (let i = 0; i < cut; i++) {
      const f = fields[i];
      if (f.gatedOut) { staticFields.set(f.name, { ...f, present: false, reason: 'build-config', offset: null }); continue; }
      staticFields.set(f.name, { ...f, present: true, offset });
      offset += f.size;
    }
    const dynamic = fields.slice(cut);

    // Which static values the tail's conditions and counts actually read.
    const needed = new Set();
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'name') needed.add(node.name);
      else if (node.kind === 'member' && node.object?.kind === 'name') needed.add(node.object.name);
      for (const k of ['left', 'right', 'cond', 'then', 'else', 'expr', 'object']) collect(node[k]);
    };
    for (const f of dynamic) {
      if (f.condition) collect(f.condition.ast);
      if (f.count) collect(f.count.ast);
    }
    const neededRecords = [...staticFields.values()].filter((r) => r.present && needed.has(r.name));

    const prog = {
      className,
      source: cls.source,
      parentSize: cls.parentSize,
      headerSize: cls.headerSize ?? null,
      size: cls.size ?? null,
      variableLength: dynamic.length > 0,
      patchedByOverlay: Boolean(ownFromOverlay),
      fields,
      byName: new Map(fields.map((f) => [f.name, f])),
      staticFields,
      staticEnd: offset,
      dynamic,
      neededRecords,
    };
    // A class with no data-dependent field has one walk result for all time.
    prog.staticWalk = dynamic.length === 0
      ? { fields: new FieldSet(staticFields, null), endOffset: offset, warnings: EMPTY, truncatedAt: null, program: prog }
      : null;
    this.programs.set(className, prog);
    return prog;
  }

  /**
   * Walk a class's layout against one object's data.
   *
   * @param {string} className
   * @param {import('./view.mjs').HeapView} view
   * @returns {{fields: FieldSet, endOffset: number|null, warnings: string[]}}
   */
  walk(className, view) {
    const prog = this.program(className);
    if (prog.staticWalk) return prog.staticWalk;

    const out = new Map();
    const warnings = [];
    const fieldValue = Object.create(null);
    const rawFieldValue = Object.create(null);

    for (const rec of prog.neededRecords) {
      if (rec.bitfieldStruct) {
        const raw = view.readUnsignedInt(rec.offset, rec.size, { optional: true });
        if (raw !== null) rawFieldValue[rec.name] = { bitfieldStruct: rec.bitfieldStruct, raw };
      } else if (rec.scalarKind) {
        const v = view.readScalar(rec, { optional: true });
        if (v !== null && typeof v === 'number') fieldValue[rec.name] = v;
      }
    }
    const evaluator = new ExpressionEvaluator(this, fieldValue, rawFieldValue);
    const result = (endOffset, truncatedAt) => ({
      fields: new FieldSet(prog.staticFields, out), endOffset, warnings, truncatedAt, program: prog,
    });

    let offset = prog.staticEnd;
    for (const f of prog.dynamic) {
      if (f.gatedOut) { out.set(f.name, { ...f, present: false, reason: 'build-config', offset: null }); continue; }

      if (f.conditional) {
        let present;
        try { present = Boolean(evaluator.eval(f.condition.ast)); }
        catch (e) {
          warnings.push(`${className}.${f.name}: cannot evaluate condition ${f.condition.expr}: ${e.message}`);
          out.set(f.name, { ...f, present: false, reason: 'condition-unevaluable', offset: null });
          // Every later offset is now unknown; stop rather than guess.
          return result(null, f.name);
        }
        if (!present) { out.set(f.name, { ...f, present: false, reason: 'condition-false', offset: null }); continue; }
      }

      if (f.indexed) {
        let count;
        try { count = Number(evaluator.eval(f.count.ast)); }
        catch (e) {
          warnings.push(`${className}.${f.name}: cannot evaluate count ${f.count.expr}: ${e.message}`);
          return result(null, f.name);
        }
        if (!Number.isInteger(count) || count < 0) {
          warnings.push(`${className}.${f.name}: count ${count} is not a non-negative integer`);
          return result(null, f.name);
        }
        const rec = { ...f, present: true, offset, count, byteLength: count * f.elementSize };
        out.set(f.name, rec);
        offset += rec.byteLength;
        continue;
      }

      const rec = { ...f, present: true, offset };
      out.set(f.name, rec);
      offset += f.size;

      if (f.bitfieldStruct) {
        const raw = view.readUnsignedInt(rec.offset, f.size, { optional: true });
        if (raw !== null) rawFieldValue[f.name] = { bitfieldStruct: f.bitfieldStruct, raw };
      } else if (f.scalarKind) {
        const v = view.readScalar(rec, { optional: true });
        if (v !== null && typeof v === 'number') fieldValue[f.name] = v;
      }
    }

    return result(offset, null);
  }
}

const EMPTY = Object.freeze([]);

/**
 * The walked fields of one object: a shared static prefix plus a per-object
 * tail. Reads check the tail first so a field can only be in one of them.
 */
export class FieldSet {
  constructor(staticFields, dynamicFields) {
    this.s = staticFields;
    this.d = dynamicFields;
  }

  get(name) {
    if (this.d !== null) {
      const hit = this.d.get(name);
      if (hit !== undefined) return hit;
    }
    return this.s.get(name);
  }

  has(name) { return this.get(name) !== undefined; }

  values() {
    const out = [];
    for (const v of this.s.values()) out.push(v);
    if (this.d !== null) for (const v of this.d.values()) out.push(v);
    return out;
  }

  /** Names of the fields that are present, without materialising records. */
  presentNames() {
    const out = [];
    for (const v of this.s.values()) if (v.present) out.push(v.name);
    if (this.d !== null) for (const v of this.d.values()) if (v.present) out.push(v.name);
    return out;
  }
}

/** Put profile fields and overlay fields into one shape. */
function normalizeField(f, resolver) {
  const taggedSize = resolver.taggedSize;
  const conditional = f.conditional === true || f.present === 'conditional' || f.condition !== undefined;
  const indexed = f.indexed === true;
  const kind = f.kind;
  const bitfieldStruct = kind === 'bitfield' ? f.type : null;
  // Which fields can be read as a number, for use in later conditions/counts.
  const scalarKind = (kind === 'int' || kind === 'float')
    ? kind
    : (kind === 'tagged' && /^(Smi|SmiTagged<)/.test(f.type) ? 'smi' : null);
  return {
    name: f.name,
    type: f.type,
    kind,
    size: indexed ? (f.elementSize ?? f.size ?? taggedSize) : (f.size ?? taggedSize),
    elementSize: indexed ? (f.elementSize ?? f.size ?? taggedSize) : null,
    indexed,
    conditional,
    condition: f.condition ?? null,
    count: f.count ?? null,
    bitfieldStruct,
    scalarKind,
    gatedOut: f.present === false,
    declaredIn: f.declaredIn ?? null,
    staticOffset: typeof f.offset === 'number' ? f.offset : null,
  };
}

export default { LayoutResolver, LayoutError, FieldSet };
