// src/heap/strings.mjs
//
// String decoding for the five on-heap representations a code cache can hold.
// All offsets come from the walked layout program; the only thing this file
// adds is the recursion, and the character width, which the map name states
// (`*_one_byte_string_map` vs `*_two_byte_string_map`).
//
//   SeqOneByteString   chars[length]: char8   -> latin1
//   SeqTwoByteString   chars[length]: char16  -> utf-16le
//   ConsString         first + second         -> concatenation
//   SlicedString       parent + offset        -> substring of length `length`
//   ThinString         actual                 -> forwarding to the real string
//   ExternalString     resource lives outside the heap -> not in the cache
//
// A code cache stores its own strings, so Seq/Cons/Sliced/Thin all appear.
// ExternalString cannot be decoded: its characters were never serialized, only
// the external pointer. That is reported, not faked.

// VERSION-FREE: a recursion cap on Cons/Sliced/Thin chains. Policy, not V8 data:
// a deeper chain is reported as unresolved rather than risking a stack overflow.
const MAX_DEPTH = 200;

export class StringDecoder {
  constructor(ctx) {
    this.ctx = ctx;
    this.stats = { seq: 0, cons: 0, sliced: 0, thin: 0, external: 0, failed: 0, fromRoot: 0, fromRoHeap: 0 };
  }

  /**
   * Decode any reference that should be a string.
   *
   * @returns {{ok: true, value: string, via: string} | {ok: false, why: string, detail?: object}}
   */
  decode(ref, depth = 0) {
    if (depth > MAX_DEPTH) return { ok: false, why: 'string-recursion-too-deep' };
    if (ref === undefined || ref === null) return { ok: false, why: 'empty-slot' };

    // Roots and read-only references carry their value in the tables.
    if (ref.k === 'RootArray' || ref.k === 'RootArrayConstant') {
      const r = ref.root;
      if (!r) return { ok: false, why: 'unknown-root-index', detail: { rootIndex: ref.rootIndex } };
      if (r.kind === 'string' && typeof r.value === 'string') { this.stats.fromRoot++; return { ok: true, value: r.value, via: 'root' }; }
      if (r.kind === 'oddball' || r.kind === 'hole') return { ok: false, why: `root-is-${r.kind}`, detail: { root: r.cppName } };
      return { ok: false, why: 'root-is-not-a-string', detail: { root: r.cppName, kind: r.kind } };
    }
    if (ref.k === 'ReadOnlyHeapRef') {
      const hit = this.ctx.roRefs.resolve(ref.chunkIndex, ref.chunkOffset);
      if (!hit.resolved) return { ok: false, why: 'unresolved-read-only-ref', detail: { chunk: ref.chunkIndex, offset: ref.chunkOffset } };
      if (hit.entry.kind === 'string' && typeof hit.entry.value === 'string') {
        this.stats.fromRoHeap++;
        return { ok: true, value: hit.entry.value, via: 'ro-heap' };
      }
      return { ok: false, why: 'read-only-ref-is-not-a-string', detail: { kind: hit.entry.kind, mapName: hit.entry.mapName } };
    }
    if (ref.k !== undefined) return { ok: false, why: `reference-kind-${ref.k}` };

    // A deserialized object.
    if (ref.sizeInTagged === undefined) return { ok: false, why: 'not-a-heap-object' };
    const cls = this.ctx.classifyObject(ref);
    if (!cls) return { ok: false, why: 'unclassified-map', detail: { objectId: ref.id } };
    return this.decodeObject(ref, cls, depth);
  }

  decodeObject(record, cls, depth) {
    const view = this.ctx.viewOf(record);
    const walk = this.ctx.walk(cls.className, view);
    const f = (n) => walk.fields.get(n);

    switch (cls.className) {
      case 'SeqOneByteString':
      case 'SeqTwoByteString': {
        const lenRec = f('length');
        const len = lenRec && lenRec.present ? view.readScalar(lenRec, { optional: true }) : null;
        if (len === null) return { ok: false, why: 'string-length-not-serialized', detail: { objectId: record.id } };
        const charsRec = f('chars');
        if (!charsRec || !charsRec.present) return { ok: false, why: 'string-has-no-chars-region' };
        const bytes = view.bytes(charsRec.offset, len * charsRec.elementSize, { optional: true });
        if (bytes === null) {
          this.stats.failed++;
          return { ok: false, why: 'string-characters-not-serialized', detail: { objectId: record.id, length: len } };
        }
        this.stats.seq++;
        const value = charsRec.elementSize === 1 ? bytes.toString('latin1') : bytes.toString('utf16le');
        return { ok: true, value, via: cls.className };
      }

      case 'ConsString': {
        const a = this.decode(view.slot(f('first').offset), depth + 1);
        const b = this.decode(view.slot(f('second').offset), depth + 1);
        if (!a.ok) return a;
        if (!b.ok) return b;
        this.stats.cons++;
        return { ok: true, value: a.value + b.value, via: 'ConsString' };
      }

      case 'SlicedString': {
        const p = this.decode(view.slot(f('parent').offset), depth + 1);
        if (!p.ok) return p;
        const off = view.readSmi(f('offset').offset, { optional: true });
        const lenRec = f('length');
        const len = view.readScalar(lenRec, { optional: true });
        if (off === null || len === null) return { ok: false, why: 'sliced-string-metadata-not-serialized' };
        this.stats.sliced++;
        return { ok: true, value: p.value.slice(off, off + len), via: 'SlicedString' };
      }

      case 'ThinString': {
        const r = this.decode(view.slot(f('actual').offset), depth + 1);
        if (r.ok) this.stats.thin++;
        return r;
      }

      case 'ExternalString': {
        this.stats.external++;
        return {
          ok: false,
          why: 'external-string',
          detail: {
            objectId: record.id,
            note: 'characters live outside the heap; only the external pointer was serialized',
          },
        };
      }

      default:
        return { ok: false, why: 'not-a-string-class', detail: { className: cls.className } };
    }
  }
}

export default { StringDecoder };
