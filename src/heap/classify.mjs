// src/heap/classify.mjs
//
// What class is this object?
//
// The answer is in its map word. In a code cache a map is always reached as a
// root (`kRootArray` / `kRootArrayConstants`) or as a read-only reference, so
// the map's *name* is available even though the Map object itself is not
// deserialized:
//
//   roots.json    cppName 'scope_info_map', camelName 'ScopeInfoMap'
//   ro-heap.json  mapName 'InternalizedOneByteStringMap'
//
// Resolution is two steps, both data-driven:
//
//  1. Strip the trailing `Map` and look the remainder up in layouts.json,
//     case-insensitively (`regexp_boilerplate_description_map` yields
//     `RegexpBoilerplateDescription`; the class is `RegExpBoilerplateDescription`).
//
//  2. If that fails and the name is a string map, decompose it. V8 spells
//     string maps as an optional `shared_`/`uncached_`/`internalized_` decoration
//     over a representation and an encoding, and only the representation and
//     encoding affect the layout:
//        cons_*     -> ConsString      sliced_*  -> SlicedString
//        thin_*     -> ThinString      external_*-> ExternalString
//        otherwise  -> SeqOneByteString / SeqTwoByteString by encoding
//     The decorations change interning and sharing, not field offsets.
//
// Anything neither step resolves is recorded in `unresolvedMaps` with a count
// and left unclassified. No fallback guess is made, because a wrong class means
// a wrong layout means wrong field values with no outward sign.

const STRING_REPRESENTATIONS = [
  // Checked in order; the first match wins. `seq` is last because an
  // undecorated `one_byte_string_map` is also sequential.
  { token: 'cons', className: 'ConsString' },
  { token: 'sliced', className: 'SlicedString' },
  { token: 'thin', className: 'ThinString' },
  { token: 'external', className: 'ExternalString' },
];

/**
 * Map names whose class is spelled differently from the map, with the reason.
 * Each entry is a V8 structural fact, not version data.
 */
const MAP_ALIASES = {
  // A copy-on-write FixedArray is a FixedArray with a different map; the map is
  // the write barrier's marker, the layout is identical.
  fixed_cow_array: 'FixedArray',
  // BigInt's layout is declared in C++ (FLEXIBLE_ARRAY_MEMBER over
  // UnalignedValueMember<digit_t>), not in Torque, so layouts.json has no
  // `BigInt` class at all. The overlay carries the layout under the name of the
  // C++ base class, which is what the decoder looks for.
  bigint: 'BigIntBase',
};

export class MapClassifier {
  /**
   * @param {import('./layout.mjs').LayoutResolver} layout
   * @param {import('./roref.mjs').RoRefResolver} roRefs
   */
  constructor(layout, roRefs) {
    this.layout = layout;
    this.roRefs = roRefs;
    this.cache = new Map();          // mapName -> {className, encoding, via} | null
    this.noLayoutClass = new Map();  // mapName -> {count, className}
    this.unnamedMaps = 0;            // map words whose name could not be found at all
  }

  /** Every spelling of a map reference's name, most specific first. */
  mapNames(mapRef) {
    if (!mapRef || typeof mapRef !== 'object') return [];
    if (mapRef.k === 'RootArray' || mapRef.k === 'RootArrayConstant') {
      const r = mapRef.root;
      if (!r) return [];
      // cppName is the snake_case root name ('feedback_metadata_map'), camelName
      // is the ROOT_LIST label, which is sometimes a different word
      // ('FeedbackMetadataArrayMap'). Try both.
      return [r.cppName, r.camelName].filter(Boolean);
    }
    if (mapRef.k === 'ReadOnlyHeapRef') {
      const r = this.roRefs.resolve(mapRef.chunkIndex, mapRef.chunkOffset);
      if (!r.resolved) return [];
      return [r.entry.mapName, r.entry.rootName].filter(Boolean);
    }
    return [];
  }

  /** The printable name of a map reference, or null. */
  mapName(mapRef) {
    if (!mapRef || typeof mapRef !== 'object') return null;
    if (mapRef.k === 'RootArray' || mapRef.k === 'RootArrayConstant') {
      return mapRef.root?.camelName ?? mapRef.root?.cppName ?? null;
    }
    if (mapRef.k === 'ReadOnlyHeapRef') {
      const r = this.roRefs.resolve(mapRef.chunkIndex, mapRef.chunkOffset);
      return r.resolved ? (r.entry.mapName ?? r.entry.rootName ?? null) : null;
    }
    // A deserialized Map object: its own map word is the meta map. Reading its
    // instance_type would need the instance-type table, which no profile table
    // carries, so this is reported rather than guessed.
    if (mapRef.sizeInTagged !== undefined) return null;
    return null;
  }

  /**
   * @param {object} mapRef  the contents of an object's map slot
   * @returns {{className: string, encoding: 'one-byte'|'two-byte'|null, mapName: string, via: string}|null}
   */
  classifyMap(mapRef) {
    const names = this.mapNames(mapRef);
    if (!names.length) { this.unnamedMaps++; return null; }
    const key = names[0];
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      if (hit === null) this.#countNoLayout(key);
      return hit;
    }
    let result = null;
    for (const n of names) {
      result = this.#classifyName(n);
      if (result) break;
    }
    this.cache.set(key, result);
    if (result === null) this.#countNoLayout(key);
    return result;
  }

  #countNoLayout(name) {
    const e = this.noLayoutClass.get(name) ?? { count: 0 };
    e.count++;
    this.noLayoutClass.set(name, e);
  }

  #classifyName(name) {
    const snake = toSnake(name);

    // (1) direct: drop the trailing Map and look the class up.
    const stripped = /_map$/.test(snake) ? snake.replace(/_map$/, '') : snake;
    const aliased = MAP_ALIASES[stripped];
    if (aliased) {
      const cls = this.layout.resolveClassName(aliased);
      if (cls) return { className: cls, encoding: encodingOf(snake), mapName: name, via: `alias:${stripped}` };
      // The alias may name a class only the overlay's cppLayouts carries.
      if (this.layout.overlay?.data?.cppLayouts?.[aliased]) {
        return { className: aliased, encoding: null, mapName: name, via: `alias:${stripped}:cppLayout` };
      }
    }
    const direct = this.layout.resolveClassName(toPascal(stripped));
    if (direct) return { className: direct, encoding: encodingOf(snake), mapName: name, via: 'name' };

    // (2) string maps: representation + encoding decide the layout.
    if (/_string$/.test(stripped) || /_string_/.test(snake)) {
      const encoding = encodingOf(snake);
      for (const rep of STRING_REPRESENTATIONS) {
        if (new RegExp(`(^|_)${rep.token}(_|$)`).test(stripped)) {
          const cls = this.layout.resolveClassName(rep.className);
          if (cls) return { className: cls, encoding, mapName: name, via: `string-representation:${rep.token}` };
        }
      }
      if (encoding) {
        const seq = encoding === 'two-byte' ? 'SeqTwoByteString' : 'SeqOneByteString';
        const cls = this.layout.resolveClassName(seq);
        if (cls) return { className: cls, encoding, mapName: name, via: 'string-representation:seq' };
      }
    }

    return null;
  }

  /**
   * Two different failures, reported apart:
   *   noLayoutForClass  the map is named but layouts.json has no such class.
   *                     Benign for classes the front end never decodes
   *                     (WeakFixedArray, ClosureFeedbackCellArray, ...).
   *   unnamedMapWords   the map word itself could not be named -- an
   *                     unresolved read-only reference or a deserialized Map.
   *                     This one hides real objects.
   */
  report(limit = 30) {
    const rows = [...this.noLayoutClass.entries()]
      .map(([mapName, v]) => ({ mapName, count: v.count }))
      .sort((a, b) => b.count - a.count);
    return {
      distinctMapsSeen: this.cache.size,
      distinctClassified: [...this.cache.values()].filter(Boolean).length,
      distinctNoLayoutForClass: rows.length,
      noLayoutOccurrences: rows.reduce((s, r) => s + r.count, 0),
      unnamedMapWords: this.unnamedMaps,
      top: rows.slice(0, limit),
    };
  }
}

function toSnake(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function toPascal(snake) {
  return String(snake).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function encodingOf(snake) {
  if (/(^|_)two_byte(_|$)/.test(snake)) return 'two-byte';
  if (/(^|_)one_byte(_|$)/.test(snake)) return 'one-byte';
  return null;
}

export default { MapClassifier };
