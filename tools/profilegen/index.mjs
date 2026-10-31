#!/usr/bin/env node
// tools/profilegen/index.mjs
//
// Generate profiles/<tag>/ from pinned upstream V8 sources.
//
//   node tools/profilegen/index.mjs --tag 14.4.258.16 --variant intl+wasm \
//        --tagged-size 4 --out profiles/
//
// Options
//   --tag <a.b.c.d>           V8 tag to pin (required, may repeat)
//   --variant <v>             intl+wasm | intl+nowasm | nointl+wasm | nointl+nowasm
//   --tagged-size <4|8>       4 = pointer compression on
//   --out <dir>               output root (default profiles/)
//   --target-os <win|linux|mac>
//   --cache <dir>             source cache root (default .v8src-cache/)
//   --seed-dir <dir>          another cache laid out the same way, to avoid refetching
//   --scriptormodule-legacy-lifetime   define V8_SCRIPTORMODULE_LEGACY_LIFETIME
//   --offline                 fail instead of fetching
//   --quiet
//
// Nothing in here is version-specific: every table comes from the fetched
// sources. Anything that could not be derived lands in meta.json -> unresolved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V8Source, DEFAULT_CACHE_ROOT, refExists } from './fetch.mjs';
import { buildDefines, staticRootsHeaderFor, VARIANTS } from './config.mjs';
import { parseTq, orderClasses, torqueDefinedMapRootList, torqueFileList, buildFlags as fallbackBuildFlags } from './torque.mjs';
import { deriveTorqueBuildFlags } from './gen/buildflags.mjs';
import { deriveRoots, orderedStaticRootNames } from './gen/roots.mjs';
import { deriveStaticRoots } from './gen/static-roots.mjs';
import { deriveOperands, deriveBytecodes, deriveIntrinsics, deriveRuntime } from './gen/bytecodes.mjs';
import { deriveSerializerTags } from './gen/serializer-tags.mjs';
import { deriveConstants } from './gen/constants.mjs';
import { deriveLayouts, REQUIRED_BITFIELDS } from './gen/layouts.mjs';
import { deriveCppEnums } from './gen/cppenums.mjs';
import { deriveCppLayouts } from './gen/cpplayouts.mjs';
import { assertExpectations, ExpectationError } from './expectations.mjs';

// 1.1.0: the five gaps of ARCHITECTURE.md 9.6/10.7 are closed in the
// extractors, every extractor miss is recorded in meta.json -> unresolved with
// a source line, and a missing declared expectation fails generation.
export const GENERATOR_VERSION = '1.1.0';

/** Directories that hold .tq files; fetched as archives to spare gitiles. */
const TQ_DIRS = ['src/objects', 'src/builtins', 'src/ic', 'src/wasm', 'src/debug', 'test/torque', 'third_party/v8/builtins'];

function parseArgs(argv) {
  const out = {
    tags: [], variant: 'intl+wasm', taggedSize: 4, out: 'profiles',
    targetOs: 'win', cache: DEFAULT_CACHE_ROOT, seedDirs: [],
    scriptOrModuleLegacyLifetime: false, offline: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--tag': out.tags.push(argv[++i]); break;
      case '--variant': out.variant = argv[++i]; break;
      case '--tagged-size': out.taggedSize = Number(argv[++i]); break;
      case '--out': out.out = argv[++i]; break;
      case '--target-os': out.targetOs = argv[++i]; break;
      case '--cache': out.cache = argv[++i]; break;
      case '--seed-dir': out.seedDirs.push(argv[++i]); break;
      case '--scriptormodule-legacy-lifetime': out.scriptOrModuleLegacyLifetime = true; break;
      case '--offline': out.offline = true; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) out.tags.push(a);
        else throw new Error(`unknown argument ${a}`);
    }
  }
  if (!VARIANTS.includes(out.variant)) throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
  if (![4, 8].includes(out.taggedSize)) throw new Error('--tagged-size must be 4 or 8');
  return out;
}

const USAGE = `usage: node tools/profilegen/index.mjs --tag <a.b.c.d> [--variant intl+wasm]
       [--tagged-size 4|8] [--out profiles/] [--target-os win|linux|mac]
       [--cache .v8src-cache/] [--seed-dir <dir>] [--offline] [--quiet]
       [--scriptormodule-legacy-lifetime]`;

/**
 * Derive every table for one tag/variant. Returns the profile object graph.
 * Exported so selftest.mjs can run it without touching the filesystem layout.
 */
export async function generateProfile({
  tag, variant = 'intl+wasm', taggedSize = 4, targetOs = 'win',
  cache = DEFAULT_CACHE_ROOT, seedDirs = [], offline = false,
  scriptOrModuleLegacyLifetime = false, log = () => {},
}) {
  const src = new V8Source(tag, { cacheRoot: cache, offline, seedDirs });
  const cfg = buildDefines({ variant, taggedSize, targetOs, scriptOrModuleLegacyLifetime });
  const unresolved = {};

  log(`[${tag}] build config: ${variant}, kTaggedSize=${taggedSize}, targetOs=${targetOs}`);

  // ---- 1. Torque build flags, derived from torque-parser.cc -----------------
  let tqFlags;
  const flagInfo = await deriveTorqueBuildFlags(src, { defines: cfg.defines, taggedSize });
  tqFlags = flagInfo.flags;
  if (flagInfo.unresolved.length) {
    unresolved.torqueBuildFlags = flagInfo.unresolved;
    // fall back to the transcribed table for anything that did not resolve
    const fb = fallbackBuildFlags({ taggedSize, intl: cfg.intl, wasm: cfg.wasm, sandbox: cfg.gnFlags.v8_enable_sandbox });
    tqFlags = { ...fb, ...tqFlags };
  }
  log(`[${tag}] torque build flags: ${Object.keys(tqFlags).length} (${flagInfo.unresolved.length} unresolved)`);

  // ---- 2. the .tq universe --------------------------------------------------
  log(`[${tag}] priming .tq sources`);
  for (const d of TQ_DIRS) await src.primeDirectory(d, (p) => p.endsWith('.tq'));
  const gn = await src.require('BUILD.gn');
  const tqFiles = torqueFileList(gn.text, {
    intl: cfg.intl, wasm: cfg.wasm, temporal: cfg.gnFlags.v8_enable_temporal_support,
  });
  const allDecls = [];
  const unknownTqFlags = new Set();
  const missingTq = [];
  const tqSkipped = [];
  for (const f of tqFiles) {
    const r = await src.get(f, { optional: true });
    if (!r.text) { missingTq.push(f); continue; }
    allDecls.push(...parseTq(r.text, { file: f, flags: tqFlags, unknownFlags: unknownTqFlags, skipped: tqSkipped }));
  }
  if (missingTq.length) unresolved.missingTorqueFiles = missingTq;
  if (unknownTqFlags.size) unresolved.unknownTorqueFlags = [...unknownTqFlags];
  if (tqSkipped.length) {
    // Anything the Torque reader could not parse but that looks like a field or
    // an enum member. This is the list that was silently empty while three
    // ScopeInfo fields and 78 ContextSlot members were being dropped, so it is
    // reported with file, line and reason rather than counted.
    unresolved.torqueStatementsSkipped = {
      note: 'statements inside a Torque class / struct / bitfield / enum body that are shaped like '
        + 'a field or a member but did not parse. A dropped interior field shifts every later '
        + 'offset, so each one is a potential silent misdecode.',
      count: tqSkipped.length,
      entries: tqSkipped,
    };
  }
  const classDecls = allDecls.filter((d) => d.kind === 'class');
  const orderedClasses = orderClasses(allDecls);
  const torqueMapRoots = torqueDefinedMapRootList(orderedClasses);
  log(`[${tag}] torque: ${tqFiles.length} files, ${classDecls.length} classes, ${torqueMapRoots.length} map roots`);

  // ---- 3. constants (needed by layouts) ------------------------------------
  const constants = await deriveConstants(src, { defines: cfg.defines, taggedSize, gnFlags: cfg.gnFlags });
  if (constants.unresolvedGlobals.length) {
    unresolved.unresolvedGlobalConstants = {
      note: 'globals.h constexprs whose right-hand side we do not evaluate (sizeof/offsetof of C++ types, or arch reservation sizes). None of them feeds an emitted table; they are listed so the gap is visible.',
      names: constants.unresolvedGlobals,
    };
  }
  if (constants.readOnlyPage.note) unresolved.readOnlyPageHeader = constants.readOnlyPage.note;

  // ---- 4. opcodes + operands ------------------------------------------------
  const operands = await deriveOperands(src, cfg.defines);
  const bytecodes = await deriveBytecodes(src, cfg.defines, operands);
  if (bytecodes.unknownOperandTypes.length) unresolved.unknownOperandTypes = bytecodes.unknownOperandTypes;
  log(`[${tag}] bytecodes: ${bytecodes.totalOpcodes} opcodes, ${operands.operandTypeOrder.length} operand types`);

  // ---- 5. serializer tags ---------------------------------------------------
  const serializerTags = await deriveSerializerTags(src, cfg.defines);
  log(`[${tag}] serializer tags: ${serializerTags.count}, snapshot spaces ${serializerTags.kNumberOfSnapshotSpaces}`);

  // ---- 6. roots + static roots ---------------------------------------------
  const roots = await deriveRoots(src, { defines: cfg.defines, torqueMapRoots });
  const staticRootsHeader = staticRootsHeaderFor(variant);
  const staticRoots = await deriveStaticRoots(src, staticRootsHeader, roots.readOnly);
  log(`[${tag}] roots: ${roots.roots.length} total (${roots.readOnlyCount} read-only); static table ${staticRoots.entriesCount}; agreement ${staticRoots.acceptance.agreement}`);

  const residual = staticRoots.entriesCount - roots.readOnlyCount;
  if (staticRoots.acceptance.agreementCount !== staticRoots.entriesCount) {
    unresolved.unresolvedRoots = {
      derivedReadOnlyCount: roots.readOnlyCount,
      staticTableCount: staticRoots.entriesCount,
      residual,
      agreement: staticRoots.acceptance.agreement,
      firstDivergentIndex: staticRoots.acceptance.firstDivergentIndex,
      note: 'the derived read-only root order does not agree positionally with StaticReadOnlyRootsPointerTable; the table is emitted as derived and NOT padded',
    };
  }
  if (roots.unknownConditionIdentifiers.length) {
    unresolved.unknownConditionIdentifiers = {
      note: 'identifiers that appeared in a #if while expanding the root headers and are not in the defines map, so they evaluated to 0 (the C rule). All of these guard compiler-attribute macros in src/base/macros.h, not list content; the root-order acceptance check confirms the lists are unaffected.',
      names: roots.unknownConditionIdentifiers,
    };
  }

  // ---- 7. the enums Torque does not define, and the values it gets wrong ----
  const enumDecls = allDecls.filter((d) => d.kind === 'enum');
  const cppEnums = await deriveCppEnums(src, {
    defines: cfg.defines,
    torqueEnums: new Map(enumDecls.map((d) => [d.name, d])),
    constants: constants.globals,
  });
  if (cppEnums.unresolved.length) {
    unresolved.cppEnums = {
      note: 'C++ enums a decoder consumes that could not be extracted, or that disagree with the '
        + 'Torque declaration in a way this generator cannot explain. For an `extern enum` the C++ '
        + 'value is authoritative; a Torque member C++ does not define means one of the two reads '
        + 'is wrong.',
      entries: cppEnums.unresolved,
    };
  }
  if (cppEnums.disagreements.length) {
    // Expected for every `extern enum` -- Torque states only the names -- but
    // it is exactly the trap of ARCHITECTURE.md 9.6 gap 3, so it is recorded
    // with every member rather than summarised.
    unresolved.enumValueDisagreements = {
      note: 'members whose Torque declaration position is not their C++ value. The C++ value is '
        + 'authoritative and is what layouts.json -> enums.<X>.members carries; the Torque order '
        + 'is kept as enums.<X>.torqueDeclarationOrder. These are not errors: for an `extern enum` '
        + 'Torque declares names only. They are listed because reading one of them as a value is '
        + 'a wrong-but-plausible answer.',
      count: cppEnums.disagreements.length,
      byEnum: Object.fromEntries(
        [...new Set(cppEnums.disagreements.map((d) => d.enum))].map((e) => [
          e, cppEnums.disagreements.filter((d) => d.enum === e).length,
        ]),
      ),
      entries: cppEnums.disagreements,
    };
  }
  if (cppEnums.predicatesNotUnderstood.length) {
    unresolved.functionKindPredicates = {
      note: 'predicates in src/objects/function-kind.h whose body is not a disjunction of '
        + 'base::IsInRange / equality tests, so no ordinal range is emitted for them. They are '
        + 'left out rather than approximated.',
      entries: cppEnums.predicatesNotUnderstood.map((p) => ({
        predicate: p.predicate,
        source: 'src/objects/function-kind.h',
        line: null,
        reason: p.reason ?? 'body is not a disjunction of base::IsInRange / equality tests',
        body: p.body,
      })),
    };
  }

  // ---- 8. layouts -----------------------------------------------------------
  const layouts = await deriveLayouts(src, {
    defines: cfg.defines,
    sizes: constants.sizes,
    taggedSize,
    classDecls,
    bitfieldDecls: allDecls.filter((d) => d.kind === 'bitfield'),
    structDecls: allDecls.filter((d) => d.kind === 'struct' && !d.generic),
    enumDecls,
    generatesConstDecls: allDecls.filter((d) => d.kind === 'generates-const'),
    cppEnums: cppEnums.enums,
    functionKindGroups: cppEnums.functionKindGroups,
    globals: constants.globals,
  });

  // C++-declared layouts that no Torque class and no FIELD_LIST describes.
  const cppLayouts = await deriveCppLayouts(src, {
    defines: cfg.defines,
    sizes: constants.sizes,
    taggedSize,
    classes: layouts.classes,
  });
  layouts.cppLayouts = cppLayouts.cppLayouts;
  if (cppLayouts.unresolved.length) {
    unresolved.cppLayouts = {
      note: 'layouts declared in C++ rather than in Torque (FLEXIBLE_ARRAY_MEMBER, bitfield '
        + 'classes) that could not be derived.',
      entries: cppLayouts.unresolved,
    };
  }
  if (constants.unresolvedCodeCacheContent.length) {
    unresolved.codeCacheHeaderContent = {
      note: 'the content of a .jsc header word that could not be derived. Without these the '
        + 'header can be located but not checked.',
      entries: constants.unresolvedCodeCacheContent,
    };
  }
  if (layouts.missingClasses.length) unresolved.missingLayoutClasses = layouts.missingClasses;
  if (layouts.requiredBitfieldsMissing.length) unresolved.missingBitfields = layouts.requiredBitfieldsMissing;
  if (layouts.headerUnresolved.length) unresolved.fieldListUnresolvedSizes = layouts.headerUnresolved;
  const crossChecked = Object.entries(layouts.classes).filter(([, v]) => v.crossCheck && v.crossCheck.compared > 0);
  const crossCheckFailures = crossChecked.filter(([, v]) => !v.crossCheck.ok).map(([k, v]) => ({ class: k, ...v.crossCheck }));
  if (crossCheckFailures.length) unresolved.layoutCrossCheckFailures = crossCheckFailures;
  log(`[${tag}] layouts: ${Object.keys(layouts.classes).length} classes, ${Object.keys(layouts.bitfields).length} bitfield structs, ${crossChecked.length} cross-checked against FIELD_LIST`);

  log(`[${tag}] enums: ${Object.keys(layouts.enums).length} (${Object.keys(cppEnums.enums).length} with C++ values, `
    + `${cppEnums.disagreements.length} member(s) where the Torque order is not the C++ value); `
    + `${Object.keys(layouts.functionKindGroups).length} FunctionKind groups; `
    + `${Object.keys(layouts.cppLayouts).length} C++-only layouts`);

  // ---- 9. runtime + intrinsics ---------------------------------------------
  const runtime = await deriveRuntime(src, cfg.defines);
  const intrinsics = await deriveIntrinsics(src, cfg.defines);
  log(`[${tag}] runtime: ${runtime.count} function ids (${runtime.runtimeCount} + ${runtime.inlineCount} inline); intrinsics: ${intrinsics.count}`);

  // build-config decisions that source alone cannot settle
  const buildConfigUncertain = [];
  const scriptDropped = (layouts.classes.Script?.droppedFields ?? []);
  if (scriptDropped.length) {
    buildConfigUncertain.push({
      what: 'Script.script_or_modules',
      gatedOn: 'V8_SCRIPTORMODULE_LEGACY_LIFETIME',
      chosen: cfg.gnFlags.v8_scriptormodule_legacy_lifetime,
      why: 'BUILD.gn defaults v8_scriptormodule_legacy_lifetime to false, but an embedder (notably Node) can set it to true; V8 source cannot tell us which the target binary used. Pass --scriptormodule-legacy-lifetime to flip it.',
      effect: 'if wrong, every Script field after script_or_modules shifts by one tagged slot',
    });
  }
  if (buildConfigUncertain.length) unresolved.buildConfigUncertain = buildConfigUncertain;

  // ---- 10. the build identity (ARCHITECTURE.md 9.7) -------------------------
  // Two builds of the same V8 version are not interchangeable: with the sandbox
  // on, a TrustedPointer field is 4 bytes and the serializer emits
  // kIndirectPointerPrefix / kInitializeSelfIndirectPointer; with it off those
  // tags never appear and the slot is a full tagged word. A .jsc from the other
  // configuration therefore decodes into a plausible-looking wrong object graph
  // instead of failing, so the switches a reader must match travel with the
  // profile.
  const build = {
    sandbox: !!cfg.gnFlags.v8_enable_sandbox,
    pointerCompression: !!cfg.gnFlags.v8_enable_pointer_compression,
    externalCodeSpace: !!cfg.gnFlags.v8_enable_external_code_space,
    staticRoots: !!cfg.gnFlags.v8_enable_static_roots,
    taggedSize,
    variant,
    targetOs,
    targetCpu: cfg.gnFlags.targetCpu ?? null,
    intl: !!cfg.intl,
    wasm: !!cfg.wasm,
    debug: !!cfg.gnFlags.debug,
    trustedPointerSize: constants.sizes.kTrustedPointerSize,
    note: 'the switches a .jsc producer must share with this profile. A cache produced by a build '
      + 'that differs in `sandbox` or `pointerCompression` cannot be read with this profile: the '
      + 'trusted-pointer slot widths differ, so every object after the first trusted field is '
      + 'misread rather than refused. The header carries no field that states them, so a reader '
      + 'can only check them against what it knows about the producer.',
  };

  const graph = {
    tag, variant, taggedSize, targetOs,
    cfg, src, build,
    tqFlags, tqFiles,
    constants, operands, bytecodes, serializerTags,
    roots, staticRoots, staticRootsHeader, layouts, runtime, intrinsics,
    cppEnums,
    torqueMapRoots, orderedClasses,
    unresolved,
    acceptance: {
      roots: staticRoots.acceptance,
      layoutCrossChecks: Object.fromEntries(crossChecked.map(([k, v]) => [k, v.crossCheck])),
    },
  };

  // ---- 11. the declared expectations ---------------------------------------
  // Everything above can fail quietly: a parser that stops recognising a field
  // simply produces a shorter list. So the tables are checked against
  // expectations.mjs -- which states what every profile must contain and who
  // consumes it -- and a miss throws here, before anything is written.
  graph.expectations = assertExpectations(expectationView(graph), { tag });
  log(`[${tag}] expectations: ${graph.expectations.satisfied}/${graph.expectations.checked} declared entries present`);

  return graph;
}

/** The read-only view of a generated profile that expectations.mjs checks. */
export function expectationView(p) {
  return {
    layouts: p.layouts,
    constants: p.constants,
    serializerTags: p.serializerTags,
    bytecodes: p.bytecodes,
    operands: p.operands,
    roots: p.roots,
    runtime: p.runtime,
    intrinsics: p.intrinsics,
    cppEnums: p.cppEnums,
    meta: { build: p.build, taggedSize: p.taggedSize, variant: p.variant, tag: p.tag },
  };
}

/** Serialise a generated profile to `outRoot/<tag>/`. */
export function writeProfile(p, outRoot) {
  const dir = path.join(outRoot, p.tag);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');

  write('bytecodes.json', {
    v8Version: p.tag,
    totalOpcodes: p.bytecodes.totalOpcodes,
    shortStarRange: p.bytecodes.shortStarRange,
    illegalValue: p.bytecodes.illegalValue,
    prefixes: p.bytecodes.prefixes,
    byValue: p.bytecodes.byValue,
    byName: p.bytecodes.byName,
  });

  write('operands.json', {
    v8Version: p.tag,
    operandTypes: p.operands.operandTypes,
    operandTypeOrder: p.operands.operandTypeOrder,
    operandTypeInfoClasses: p.operands.operandTypeInfoClasses,
    operandSizes: p.operands.operandSizes,
    operandScales: p.operands.operandScales,
    registerOperandTypes: p.operands.registerOperandTypes,
    registerInputOperandTypes: p.operands.registerInputOperandTypes,
    registerOutputOperandTypes: p.operands.registerOutputOperandTypes,
    subLists: p.operands.subLists,
    sizeRule: 'size(type, scale) = scalable ? baseSize * scale : baseSize',
  });

  write('serializer-tags.json', {
    v8Version: p.tag,
    count: p.serializerTags.count,
    tags: p.serializerTags.tags,
    constants: p.serializerTags.constants,
    kNumberOfSnapshotSpaces: p.serializerTags.kNumberOfSnapshotSpaces,
    rangedTags: p.serializerTags.rangedTags,
    decodeRule: 'for a ranged tag: value = byte - base + minValue',
  });

  write('roots.json', {
    v8Version: p.tag,
    variant: p.variant,
    totalCount: p.roots.roots.length,
    readOnlyCount: p.roots.readOnlyCount,
    mutableCount: p.roots.mutableCount,
    strongMutableImmovableCount: p.roots.strongMutableImmovableCount,
    torqueDefinedMapRootCount: p.torqueMapRoots.length,
    intlOnlyRootCount: p.roots.intlOnlyCount,
    byIndex: Object.fromEntries(p.roots.roots.map((r) => [r.index, r])),
  });

  write('static-roots.json', {
    v8Version: p.tag,
    variant: p.variant,
    header: p.staticRoots.header,
    entriesCount: p.staticRoots.entriesCount,
    declaredLength: p.staticRoots.declaredLength,
    sentinels: p.staticRoots.sentinels,
    acceptance: p.staticRoots.acceptance,
    addressFormula: p.constants.readOnlyPage.addressFormula,
    orderedTable: p.staticRoots.orderedTable,
    byCompressedAddress: p.staticRoots.byCompressedAddress,
  });

  write('layouts.json', {
    v8Version: p.tag,
    taggedSize: p.taggedSize,
    sizes: p.constants.sizes,
    anchors: p.layouts.anchors,
    classes: p.layouts.classes,
    bitfields: p.layouts.bitfields,
    structs: p.layouts.structs,
    enums: p.layouts.enums,
    enumDisagreements: p.layouts.enumDisagreements,
    torqueConstants: p.layouts.torqueConstants,
    functionKindGroups: p.layouts.functionKindGroups,
    cppLayouts: p.layouts.cppLayouts,
    enumNote:
      '`enums.<X>.members` holds the authoritative values. `valueSource` says where they came '
      + "from: 'cpp' means the C++ definition was read and wins, which is required for an "
      + '`extern enum` because Torque then declares only that the names exist. '
      + '`torqueDeclarationOrder` keeps the Torque positions and `disagreements` lists every '
      + 'member where the two differ (`enumDisagreements` is the same list across all enums). '
      + "valueSource 'torque-declaration-order' with valuesAreDeclarationOrderOnly means no C++ "
      + 'extraction exists for that enum, so its ordinals are positions and not values. '
      + '`functionKindGroups` are the base::IsInRange predicates of '
      + 'src/objects/function-kind.h resolved to inclusive ordinal ranges. '
      + '`torqueConstants` maps a Torque `const X: constexpr T generates \'Y\'` to the C++ name '
      + 'and the value in constants.json, which is how a count expression written in terms of X '
      + 'can be evaluated. `cppLayouts` carries the layouts declared in C++ rather than in '
      + 'Torque (BigInt\'s FLEXIBLE_ARRAY_MEMBER, the hash-table prefix, SourcePosition::raw()).',
    layoutProgramNote:
      '`fields` holds only the fields the class itself declares, in declaration '
      + 'order, which is what Torque stores; `allFields` is the flattened '
      + "parent-first chain (Torque's ClassType::ComputeAllFields) and "
      + '`inheritanceChain` names the classes it came from. '
      + 'present === true: the field is always there. '
      + "present === 'conditional': it is there only when `condition` holds, and "
      + 'every later field offset is data-dependent (offset === null). '
      + 'indexed === true: a variable-length region of `count` elements of '
      + '`elementSize` bytes. `offset` is absolute (map word at 0); '
      + "`relativeOffset` is measured from the declaring class's parent size. "
      + '`droppedFields` lists fields the chosen build config removed, with the '
      + 'flag that gated them, because their absence shifts every later offset.',
  });

  write('runtime.json', {
    v8Version: p.tag,
    count: p.runtime.count,
    runtimeCount: p.runtime.runtimeCount,
    inlineCount: p.runtime.inlineCount,
    families: p.runtime.families,
    byId: p.runtime.byId,
    byName: p.runtime.byName,
    note: "CallRuntime's kRuntimeId operand is an index into this table",
  });

  write('intrinsics.json', {
    v8Version: p.tag,
    count: p.intrinsics.count,
    byId: p.intrinsics.byId,
    byName: p.intrinsics.byName,
    note: "InvokeIntrinsic's kIntrinsicId operand is an index into this table",
  });

  write('constants.json', {
    v8Version: p.tag,
    taggedSize: p.constants.taggedSize,
    sizes: p.constants.sizes,
    tagging: p.constants.tagging,
    readOnlyPage: p.constants.readOnlyPage,
    scopeInfo: p.constants.scopeInfo,
    handlerTable: p.constants.handlerTable,
    sourcePositionTable: p.constants.sourcePositionTable,
    codeCacheHeader: p.constants.codeCacheHeader,
    serializer: p.serializerTags.constants,
    globals: p.constants.globals,
    seededConstants: p.constants.seeded,
  });

  // meta last: it records the sha256 of every source actually consumed
  const meta = {
    generator: { name: 'tools/profilegen', version: GENERATOR_VERSION },
    generatedAt: new Date().toISOString(),
    v8Version: p.tag,
    variant: p.variant,
    taggedSize: p.taggedSize,
    targetOs: p.targetOs,
    build: p.build,
    gnFlags: p.cfg.gnFlags,
    cppDefines: p.cfg.defines,
    cppNotDefined: p.cfg.notDefined,
    torqueBuildFlags: p.tqFlags,
    torqueFileCount: p.tqFiles.length,
    counts: {
      opcodes: p.bytecodes.totalOpcodes,
      operandTypes: p.operands.operandTypeOrder.length,
      serializerTags: p.serializerTags.count,
      roots: p.roots.roots.length,
      readOnlyRoots: p.roots.readOnlyCount,
      staticRoots: p.staticRoots.entriesCount,
      torqueMapRoots: p.torqueMapRoots.length,
      layoutClasses: Object.keys(p.layouts.classes).length,
      bitfieldStructs: Object.keys(p.layouts.bitfields).length,
      runtimeFunctions: p.runtime.count,
      intrinsics: p.intrinsics.count,
      enums: Object.keys(p.layouts.enums).length,
      cppValuedEnums: Object.values(p.layouts.enums).filter((e) => e.valueSource === 'cpp').length,
      functionKindGroups: Object.keys(p.layouts.functionKindGroups).length,
      cppLayouts: Object.keys(p.layouts.cppLayouts).length,
      torqueConstants: Object.keys(p.layouts.torqueConstants).length,
    },
    acceptance: {
      ...p.acceptance,
      expectations: p.expectations ?? null,
    },
    unresolved: p.unresolved,
    sources: p.src.sources(),
  };
  write('meta.json', meta);
  return { dir, meta };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(String(e.message)); console.error(USAGE); process.exitCode = 2; return; }
  if (opts.help || !opts.tags.length) { console.log(USAGE); process.exitCode = opts.help ? 0 : 2; return; }

  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  for (const tag of opts.tags) {
    if (!opts.offline) {
      const e = await refExists(tag);
      if (!e.ok) { console.error(`tag ${tag} not found upstream (HTTP ${e.status})`); process.exitCode = 1; return; }
    }
    let p;
    try {
      p = await generateProfile({ ...opts, tag, log });
    } catch (e) {
      if (e instanceof ExpectationError) {
        console.error(`\nprofilegen FAILED for ${tag}: a declared expectation is not met.\n`);
        console.error(e.message);
        process.exitCode = 1;
        return;
      }
      throw e;
    }
    const { dir, meta } = writeProfile(p, opts.out);
    log(`[${tag}] wrote ${dir}  (${meta.sources.length} source files, ${Object.keys(meta.unresolved).length} unresolved keys)`);
    if (Object.keys(meta.unresolved).length) {
      for (const k of Object.keys(meta.unresolved)) log(`[${tag}]   unresolved: ${k}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
