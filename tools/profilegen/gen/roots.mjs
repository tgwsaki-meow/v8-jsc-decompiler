// tools/profilegen/gen/roots.mjs
//
// The root list, in serialized root order.
//
// src/roots/roots.h declares
//     enum class RootIndex : uint16_t { ROOT_LIST(DECL) ... };
// so the root index of a name is simply its position in the fully expanded
// ROOT_LIST, and READ_ONLY_ROOT_LIST is its prefix
// (kFirstReadOnlyRoot = kFirstRoot = 0 in the same enum).
//
// Two things make this harder than "expand a macro":
//
//  1. INTERNALIZED_STRING_LIST_GENERATOR_INTL is defined twice -- 142 entries
//     under #ifdef V8_INTL_SUPPORT and empty in the #else. Collecting defines
//     without evaluating the conditional silently drops 142 roots, which is
//     exactly what happened in the earlier probe. cpp.mjs fixes that.
//
//  2. TORQUE_DEFINED_MAP_ROOT_LIST is *used* in roots.h but defined nowhere in
//     the repository: Torque writes it into torque-generated/instance-types.h
//     at build time. We re-derive it from the .tq sources (see torque.mjs) and
//     inject it as a macro before expanding.

import { Cpp, collectCalls } from '../cpp.mjs';

/** Headers that contribute macros to ROOT_LIST, in #include order. */
export const ROOT_HEADERS = [
  'src/base/macros.h',            // IF_WASM, IF_FUNCTION_ARGUMENTS_CALLER_ARE_OWN_PROPS, EXPAND
  'src/builtins/accessors.h',     // ACCESSOR_INFO_LIST_GENERATOR
  'src/init/heap-symbols.h',      // every string / symbol generator
  'src/objects/objects-definitions.h', // STRUCT_LIST, *_MAPS_LIST
  'src/roots/roots.h',            // the lists themselves
];

/** Parse the `V(_, name, "value")` string tables out of heap-symbols.h. */
function harvestSymbolTables(cpp) {
  const strings = new Map();      // root name -> JS string value
  const descriptions = new Map(); // symbol root name -> description text
  const generators = [...cpp.macros.keys()].filter((n) => /_LIST_GENERATOR(_INTL)?$/.test(n));
  for (const g of generators) {
    const def = cpp.macros.get(g);
    if (!def || !def.params || def.params.length !== 2) continue;
    let expanded;
    try { expanded = cpp.expand(`${g}(ENTRY, _)`, new Set(['ENTRY'])); } catch { continue; }
    for (const args of collectCalls(expanded, 'ENTRY')) {
      if (args.length < 2) continue;
      const name = args[1].trim();
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
      const third = args[2]?.trim();
      if (third === undefined) continue;
      if (/^"/.test(third)) {
        try { strings.set(name, JSON.parse(third.replace(/"\s*"/g, '')));
        } catch { strings.set(name, third.slice(1, -1)); }
      } else if (third) {
        descriptions.set(name, third);
      }
    }
  }
  return { strings, descriptions };
}

/**
 * @param {import('../fetch.mjs').V8Source} src
 * @param {{defines: Record<string, any>, torqueMapRoots: Array<{type,name,CamelName}>}} opts
 */
export async function deriveRoots(src, { defines, torqueMapRoots }) {
  const cpp = new Cpp(defines);
  for (const p of ROOT_HEADERS) {
    const f = await src.require(p);
    cpp.run(f.text, { label: p });
  }

  // Inject the Torque-generated list. Its body is the same `V(Map, x_map, XMap)`
  // shape that instance-type-generator.cc emits.
  const body = torqueMapRoots.map((m) => `V(${m.type}, ${m.name}, ${m.CamelName})`).join(' ');
  cpp.define('TORQUE_DEFINED_MAP_ROOT_LIST', body, ['V'], false);

  const lists = {};
  for (const [listName, key] of [
    ['READ_ONLY_ROOT_LIST', 'readOnly'],
    ['MUTABLE_ROOT_LIST', 'mutable'],
    ['ROOT_LIST', 'all'],
    ['STRONG_MUTABLE_IMMOVABLE_ROOT_LIST', 'strongMutableImmovable'],
  ]) {
    if (!cpp.macros.has(listName)) { lists[key] = null; continue; }
    const calls = cpp.expandList(`${listName}(ENTRY)`, 'ENTRY');
    lists[key] = calls
      .filter((a) => a.length >= 3 && /^[A-Za-z_]\w*$/.test(a[1]))
      .map((a) => ({ cppType: a[0].trim(), cppName: a[1].trim(), CamelName: a[2].trim() }));
  }

  const { strings, descriptions } = harvestSymbolTables(cpp);

  // Mark the roots that exist only because V8_INTL_SUPPORT is on. This is the
  // list whose 142 entries the earlier macro expander silently dropped, and
  // tagging them lets a consumer (and the self-test) reconstruct what the
  // indices would have been without them.
  const intlOnly = new Set();
  if (cpp.macros.has('INTERNALIZED_STRING_LIST_GENERATOR_INTL')) {
    try {
      for (const a of cpp.expandList('INTERNALIZED_STRING_LIST_GENERATOR_INTL(ENTRY, _)', 'ENTRY')) {
        if (a.length >= 2 && /^[A-Za-z_]\w*$/.test(a[1].trim())) intlOnly.add(a[1].trim());
      }
    } catch { /* no intl in this variant */ }
  }

  const kindOf = (e) => {
    if (e.cppType === 'Map') return 'map';
    if (e.cppType === 'Symbol') return 'symbol';
    if (e.cppType === 'String') return 'string';
    if (e.cppType === 'AccessorInfo') return 'accessor';
    if (['Undefined', 'Null', 'True', 'False', 'TheHole', 'Boolean'].includes(e.cppType)) return 'oddball';
    if (['ExceptionHole', 'HashTableHole', 'PromiseHole', 'PropertyCellHole', 'ArgumentsMarker',
      'OptimizedOut', 'StaleRegister', 'TerminationException', 'UninitializedHole'].includes(e.cppType)) return 'hole';
    if (e.cppType === 'HeapNumber') return 'heapnumber';
    if (e.cppType === 'Smi') return 'smi';
    return 'object';
  };

  const ODDBALL_VALUES = {
    undefined_value: undefined, null_value: null, true_value: true, false_value: false,
  };

  const decorate = (e, index) => {
    const out = { index, cppName: e.cppName, camelName: e.CamelName, cppType: e.cppType, kind: kindOf(e) };
    if (strings.has(e.cppName)) out.value = strings.get(e.cppName);
    else if (e.cppName.endsWith('_string') && strings.has(e.cppName.replace(/_string$/, ''))) {
      out.value = strings.get(e.cppName.replace(/_string$/, ''));
    }
    if (descriptions.has(e.cppName)) out.description = descriptions.get(e.cppName);
    if (e.cppName in ODDBALL_VALUES) out.oddball = String(ODDBALL_VALUES[e.cppName]);
    if (intlOnly.has(e.cppName)) out.intlOnly = true;
    return out;
  };

  const all = (lists.all ?? []).map(decorate);
  const readOnlyCount = lists.readOnly?.length ?? 0;

  return {
    roots: all,
    readOnlyCount,
    mutableCount: lists.mutable?.length ?? 0,
    strongMutableImmovableCount: lists.strongMutableImmovable?.length ?? 0,
    readOnly: (lists.readOnly ?? []).map(decorate),
    intlOnlyCount: intlOnly.size,
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
    unexpandedMacros: [...cpp.unexpanded].sort(),
    stringValueCount: strings.size,
  };
}

/** The ordered `StaticReadOnlyRootsPointerTable` names, in table order. */
export function orderedStaticRootNames(headerText) {
  const i = headerText.indexOf('StaticReadOnlyRootsPointerTable');
  const tail = i >= 0 ? headerText.slice(i) : headerText;
  return [...tail.matchAll(/StaticReadOnlyRoot::k([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}
