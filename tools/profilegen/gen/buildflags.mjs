// tools/profilegen/gen/buildflags.mjs
//
// Derive Torque's BuildFlags table from source instead of transcribing it.
//
// src/torque/torque-parser.cc has
//     class BuildFlags : public base::ContextualClass<BuildFlags> {
//       BuildFlags() {
//         build_flags_["TAGGED_SIZE_8_BYTES"] = TargetArchitecture::TaggedSize() == 8;
//     #ifdef V8_INTL_SUPPORT
//         build_flags_["V8_INTL_SUPPORT"] = true;
//     #else
//         build_flags_["V8_INTL_SUPPORT"] = false;
//     #endif
//         ...
// and the torque binary is compiled with the same #ifdefs as V8 itself, so
// running our preprocessor over that constructor body with the C++ defines map
// yields the exact flag set the real build used. New flags appear automatically
// when a new tag adds them, which is the whole point -- 14.6 added
// V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS_WITHOUT_TQ_TO_TSA and a hardcoded table
// would have silently mis-filtered its conditional fields.

import { Cpp } from '../cpp.mjs';

/** The `#define FOO_BOOL true|false` style constants, straight out of globals.h. */
export async function derivePredicateMacros(src, defines) {
  const cpp = new Cpp(defines);
  for (const p of ['src/base/macros.h', 'src/base/build_config.h', 'src/common/globals.h']) {
    const f = await src.get(p, { optional: true });
    if (f.text) cpp.run(f.text, { label: p });
  }
  return cpp;
}

/**
 * @returns {{flags: Record<string, boolean>, unresolved: string[]}}
 */
export async function deriveTorqueBuildFlags(src, { defines, taggedSize }) {
  const cpp = await derivePredicateMacros(src, defines);
  const parser = await src.require('src/torque/torque-parser.cc');

  // isolate the BuildFlags constructor body, directives and all
  const text = parser.text;
  const at = text.indexOf('class BuildFlags');
  if (at < 0) throw new Error('torque-parser.cc: class BuildFlags not found');
  const ctor = text.indexOf('BuildFlags() {', at);
  if (ctor < 0) throw new Error('torque-parser.cc: BuildFlags() not found');
  let depth = 0, end = -1;
  for (let i = text.indexOf('{', ctor); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const body = text.slice(text.indexOf('{', ctor) + 1, end);

  const active = cpp.run(body, { label: 'torque-parser.cc BuildFlags()' });

  const flags = {};
  const unresolved = [];
  for (const m of active.matchAll(/build_flags_\[\s*"([^"]+)"\s*\]\s*=\s*([^;]+);/g)) {
    const name = m[1];
    const expr = m[2].replace(/\s+/g, ' ').trim();
    if (expr === 'true') { flags[name] = true; continue; }
    if (expr === 'false') { flags[name] = false; continue; }
    // TargetArchitecture::TaggedSize() is a runtime call, not a macro
    const normalised = expr.replace(/TargetArchitecture::TaggedSize\(\)/g, String(taggedSize));
    const before = new Set(cpp.unknownInConditions);
    let value;
    try { value = cpp.evalCondition(normalised); } catch { value = null; }
    const newUnknown = [...cpp.unknownInConditions].filter((u) => !before.has(u));
    if (value === null || newUnknown.length) { unresolved.push(`${name} = ${expr} (unknown: ${newUnknown.join(', ')})`); continue; }
    flags[name] = value;
  }
  return { flags, unresolved };
}
