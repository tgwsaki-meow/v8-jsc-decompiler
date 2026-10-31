// tools/profilegen/config.mjs
//
// The build configuration a profile is generated *for*.
//
// Everything here is a claim about how the target binary was compiled. Each
// claim is traced to the GN logic that produces it (see docs/PROFILEGEN.md for
// the full citation list), and the ones that are *observable* are falsified or
// confirmed by the root-order acceptance check, which has to reach
// N/N positional agreement with StaticReadOnlyRootsPointerTable.
//
// Target: the Electron/Chromium x64 release configuration that produced the
// corpus -- pointer compression on (kTaggedSize == 4), external code space on,
// sandbox on, static roots on, Intl and WebAssembly both compiled in.

export const VARIANTS = ['intl+wasm', 'intl+nowasm', 'nointl+wasm', 'nointl+nowasm'];

/** The static-roots header holding the table for a given variant. */
export function staticRootsHeaderFor(variant) {
  // src/roots/static-roots.h at >=14.2 is a 26-line dispatcher over exactly
  // these four files, nested #ifdef V8_ENABLE_WEBASSEMBLY / #ifdef V8_INTL_SUPPORT.
  const map = {
    'intl+wasm': 'src/roots/static-roots-intl-wasm.h',
    'nointl+wasm': 'src/roots/static-roots-nointl-wasm.h',
    'intl+nowasm': 'src/roots/static-roots-intl-nowasm.h',
    'nointl+nowasm': 'src/roots/static-roots-nointl-nowasm.h',
  };
  if (!map[variant]) throw new Error(`unknown variant ${variant}; expected one of ${VARIANTS.join(', ')}`);
  return map[variant];
}

/**
 * Resolve the GN build flags for the target configuration.
 *
 * The derivations marked (GN) are transcribed from BUILD.gn at the pinned tag;
 * the line numbers in docs/PROFILEGEN.md are for 14.4.258.16.
 */
export function resolveGnFlags({ variant = 'intl+wasm', taggedSize = 4, targetCpu = 'x64', targetOs = 'win', debug = false, scriptOrModuleLegacyLifetime = false } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  const pointerCompression = taggedSize === 4;
  const sharedCage = pointerCompression;                       // (GN) defaults to pointer compression
  const bigCpu = ['x64', 'arm64', 'loong64', 'riscv64'].includes(targetCpu);
  const externalCodeSpace = pointerCompression && sharedCage && bigCpu;   // (GN)
  const sandbox = sharedCage && externalCodeSpace && targetOs !== 'fuchsia'; // (GN)
  const staticRoots = pointerCompression && externalCodeSpace;            // (GN)
  return {
    v8_enable_i18n_support: variant.startsWith('intl'),
    v8_enable_webassembly: variant.endsWith('+wasm'),
    v8_enable_pointer_compression: pointerCompression,
    v8_enable_pointer_compression_shared_cage: sharedCage,
    v8_enable_external_code_space: externalCodeSpace,
    v8_enable_sandbox: sandbox,
    v8_enable_static_roots: staticRoots,
    v8_enable_short_builtin_calls: bigCpu,                                // (GN)
    v8_enable_swiss_name_dictionary: false,                               // (GN) default
    v8_enable_javascript_promise_hooks: false,                            // (GN) default
    v8_enable_continuation_preserved_embedder_data: true,                 // (GN) default
    v8_enable_undefined_double: false,                                    // (GN) = v8_fuzzilli
    v8_enable_experimental_tsa_builtins: false,                           // (GN) default
    v8_enable_drumbrake: false,                                           // (GN) default
    v8_enable_temporal_support: true,                                     // (GN) true unless build_with_node
    v8_scriptormodule_legacy_lifetime: scriptOrModuleLegacyLifetime,      // (GN) default false
    v8_enable_leaptiering: pointerCompression,
    debug,
    targetCpu,
    targetOs,
  };
}

/**
 * Build the C++ preprocessor defines map from the resolved GN flags.
 *
 * Only macros that can steer one of the generated tables are set. Any
 * identifier that shows up in a #if and is *not* here evaluates to 0 (the C
 * rule) and is reported in meta.json -> unresolved.unknownConditionIdentifiers
 * rather than quietly assumed.
 */
export function buildDefines(opts = {}) {
  const gn = resolveGnFlags(opts);
  const compress = gn.v8_enable_pointer_compression;
  const d = {
    __cplusplus: '201703L',

    // target
    V8_TARGET_ARCH_X64: gn.targetCpu === 'x64' ? 1 : null,
    V8_HOST_ARCH_X64: gn.targetCpu === 'x64' ? 1 : null,
    V8_TARGET_ARCH_64_BIT: 1,
    V8_HOST_ARCH_64_BIT: 1,
    V8_TARGET_LITTLE_ENDIAN: 1,

    // feature set
    V8_INTL_SUPPORT: gn.v8_enable_i18n_support ? 1 : null,
    V8_ENABLE_WEBASSEMBLY: gn.v8_enable_webassembly ? 1 : null,
    V8_COMPRESS_POINTERS: compress ? 1 : null,
    V8_COMPRESS_POINTERS_IN_SHARED_CAGE: gn.v8_enable_pointer_compression_shared_cage ? 1 : null,
    V8_31BIT_SMIS_ON_64BIT_ARCH: compress ? 1 : null,
    V8_EXTERNAL_CODE_SPACE: gn.v8_enable_external_code_space ? 1 : null,
    V8_ENABLE_SANDBOX: gn.v8_enable_sandbox ? 1 : null,
    V8_STATIC_ROOTS: gn.v8_enable_static_roots ? 1 : null,
    V8_SHORT_BUILTIN_CALLS: gn.v8_enable_short_builtin_calls ? 1 : null,
    V8_SHARED_RO_HEAP: 1,
    V8_ENABLE_LEAPTIERING: gn.v8_enable_leaptiering ? 1 : null,
    V8_ENABLE_CONTINUATION_PRESERVED_EMBEDDER_DATA: gn.v8_enable_continuation_preserved_embedder_data ? 1 : null,
    V8_ENABLE_TEMPORAL_SUPPORT: gn.v8_enable_temporal_support ? 1 : null,
    V8_SCRIPTORMODULE_LEGACY_LIFETIME: gn.v8_scriptormodule_legacy_lifetime ? 1 : null,

    // explicitly *not* defined (documents the decision; Cpp skips nulls)
    V8_ENABLE_SWISS_NAME_DICTIONARY: gn.v8_enable_swiss_name_dictionary ? 1 : null,
    V8_ENABLE_JAVASCRIPT_PROMISE_HOOKS: gn.v8_enable_javascript_promise_hooks ? 1 : null,
    V8_ENABLE_UNDEFINED_DOUBLE: gn.v8_enable_undefined_double ? 1 : null,
    V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS: gn.v8_enable_experimental_tsa_builtins ? 1 : null,
    V8_ENABLE_DRUMBRAKE: gn.v8_enable_drumbrake ? 1 : null,
    DEBUG: gn.debug ? 1 : null,
    V8_ENABLE_CHECKS: null,
    VERIFY_HEAP: null,
    OBJECT_PRINT: null,
    V8_RUNTIME_CALL_STATS: null,
    V8_ENABLE_ALLOCATION_TIMEOUT: null,
    V8_ENABLE_CONSERVATIVE_STACK_SCANNING: null,
    V8_ENABLE_WASM_SIMD256_REVEC: null,
    V8_ENABLE_ETW_STACK_WALKING: null,
    CPPGC_YOUNG_GENERATION: null,
  };
  if (gn.targetOs === 'win') { d.V8_TARGET_OS_WIN = 1; d.V8_OS_WIN = 1; d.V8_OS_WIN64 = 1; d.V8_CC_MSVC = 1; }
  else if (gn.targetOs === 'linux') { d.V8_TARGET_OS_LINUX = 1; d.V8_OS_LINUX = 1; d.V8_OS_POSIX = 1; }
  else if (gn.targetOs === 'mac') { d.V8_TARGET_OS_MACOS = 1; d.V8_OS_DARWIN = 1; d.V8_OS_POSIX = 1; }

  const defines = {};
  for (const [k, v] of Object.entries(d)) if (v !== null) defines[k] = v;
  return {
    defines,
    notDefined: Object.entries(d).filter(([, v]) => v === null).map(([k]) => k).sort(),
    gnFlags: gn,
    intl: gn.v8_enable_i18n_support,
    wasm: gn.v8_enable_webassembly,
    compress,
  };
}
