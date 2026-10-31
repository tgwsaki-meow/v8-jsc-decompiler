// tools/profilegen/gen/static-roots.mjs
//
// The compressed read-only addresses of the roots, for one build variant.
//
// At >= 14.2 src/roots/static-roots.h is a 26-line dispatcher:
//     #if V8_STATIC_ROOTS_BOOL
//     #ifdef V8_ENABLE_WEBASSEMBLY
//     #ifdef V8_INTL_SUPPORT
//     #include "src/roots/static-roots-intl-wasm.h"
//     ...
// so the variant must be picked explicitly. Each variant header holds
//     struct StaticReadOnlyRoot { static constexpr Tagged_t kName = 0x...; };
//     static constexpr std::array<Tagged_t, N> StaticReadOnlyRootsPointerTable = {...};
// and the ordered table *is* READ_ONLY_ROOT_LIST in order, so its length is
// ReadOnlyRoots::kEntriesCount.
//
// The address formula a decoder needs (verified in
// scratch/recon/VERSION_PLUGGABILITY.md §0 and §4.1):
//     Tagged_t = (chunk_index << roPageSizeLog2) + chunk_offset + kHeapObjectTag
// which is why constants.json carries the RO page size and header size.

/** `kName -> Tagged_t` from the struct, and the ordered table. */
export function parseStaticRootsHeader(text) {
  const addresses = {};
  // `static constexpr Tagged_t kFoo = 0x1234;` -- clang-format may wrap the value
  for (const m of text.matchAll(/static\s+constexpr\s+Tagged_t\s+k([A-Za-z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*;/g)) {
    addresses[m[1]] = Number(m[2]);
  }
  const ti = text.indexOf('StaticReadOnlyRootsPointerTable');
  const declared = ti >= 0 ? /std::array<Tagged_t,\s*(\d+)>/.exec(text.slice(Math.max(0, ti - 120), ti)) : null;
  const tail = ti >= 0 ? text.slice(ti) : '';
  const order = [...tail.matchAll(/StaticReadOnlyRoot::k([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  return { addresses, order, declaredLength: declared ? Number(declared[1]) : null };
}

/**
 * @param {import('../fetch.mjs').V8Source} src
 * @param {string} headerPath  from config.staticRootsHeaderFor(variant)
 * @param {Array} readOnlyRoots  the derived read-only root list, in order
 */
export async function deriveStaticRoots(src, headerPath, readOnlyRoots) {
  const f = await src.require(headerPath);
  const { addresses, order, declaredLength } = parseStaticRootsHeader(f.text);

  // sentinels that are aliases rather than roots
  const sentinels = {};
  for (const k of ['FirstAllocatedRoot', 'LastAllocatedRoot']) {
    if (addresses[k] !== undefined) sentinels[k] = addresses[k];
  }

  // address -> root name, and the positional cross-check against the root list
  const byAddress = {};
  const orderedEntries = [];
  let agreement = 0;
  let firstDivergentIndex = null;
  for (let i = 0; i < order.length; i++) {
    const camel = order[i];
    const addr = addresses[camel];
    const root = readOnlyRoots[i];
    if (root && root.camelName === camel) agreement++;
    else if (firstDivergentIndex === null) firstDivergentIndex = i;
    orderedEntries.push({
      index: i,
      camelName: camel,
      address: addr ?? null,
      cppName: root && root.camelName === camel ? root.cppName : null,
      kind: root && root.camelName === camel ? root.kind : null,
    });
    if (addr !== undefined) {
      byAddress[addr] = {
        rootIndex: i,
        camelName: camel,
        cppName: root && root.camelName === camel ? root.cppName : null,
        kind: root && root.camelName === camel ? root.kind : null,
        ...(root && root.camelName === camel && root.value !== undefined ? { value: root.value } : {}),
      };
    }
  }

  return {
    header: headerPath,
    entriesCount: order.length,
    declaredLength,
    sentinels,
    orderedTable: orderedEntries,
    byCompressedAddress: byAddress,
    acceptance: {
      agreement: `${agreement}/${order.length}`,
      agreementCount: agreement,
      total: order.length,
      firstDivergentIndex,
    },
  };
}
