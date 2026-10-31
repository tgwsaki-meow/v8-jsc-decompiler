// tools/profilegen/gen/bytecodes.mjs
//
// The Ignition opcode table and the operand-type table.
//
// src/interpreter/bytecodes.h declares
//     enum class Bytecode : uint8_t {
//       BYTECODE_LIST(DECLARE_BYTECODE, DECLARE_BYTECODE)
//       kLast = -1 BYTECODE_LIST(COUNT_BYTECODE, COUNT_BYTECODE),
//       kFirstShortStar = kStar15, kLastShortStar = kStar0
//     };
// so an opcode's byte value is its index in the fully expanded BYTECODE_LIST.
//
// Operand properties come from src/interpreter/bytecode-operands.h:
//     OPERAND_TYPE_LIST(V)      -> V(Name, OperandTypeInfo::kClass)
//     OPERAND_TYPE_INFO_LIST(V) -> V(Name, IsScalable, IsUnsigned, UnscaledSize)
//     OPERAND_SCALE_LIST(V)     -> V(Single, 1) V(Double, 2) V(Quadruple, 4)
//     enum class OperandSize { kNone = 0, kByte = 1, kShort = 2, kQuad = 4 }
// None of that is transcribed: the four OperandTypeInfo classes are read out of
// OPERAND_TYPE_INFO_LIST, so a fifth one would appear by itself.
//
// Decoding rule: size(op, scale) = scalable ? baseSize * scale : baseSize,
// with scale 1/2/4 selected by a Wide / ExtraWide prefix.

import { Cpp, collectCalls, evalIntExpr } from '../cpp.mjs';

export async function deriveOperands(src, defines) {
  const f = await src.require('src/interpreter/bytecode-operands.h');
  const cpp = new Cpp(defines);
  cpp.run(f.text, { label: 'bytecode-operands.h' });

  // OperandSize enum values
  const sizeEnum = {};
  const em = /enum class OperandSize\s*:\s*\w+\s*\{([\s\S]*?)\}/.exec(f.text);
  if (em) {
    for (const m of em[1].matchAll(/(k\w+)\s*=\s*([^,}]+)/g)) {
      const { value } = evalIntExpr(m[2], sizeEnum);
      sizeEnum[m[1]] = value;
    }
  }

  // the OperandTypeInfo classes: V(Name, IsScalable, IsUnsigned, UnscaledSize)
  const classes = {};
  for (const a of cpp.expandList('OPERAND_TYPE_INFO_LIST(V)', 'V')) {
    if (a.length < 4) continue;
    const name = 'k' + a[0].trim();
    const sizeTok = a[3].trim().replace(/^OperandSize::/, '');
    classes[name] = {
      scalable: a[1].trim() === 'true',
      unsigned: a[2].trim() === 'true',
      baseSize: sizeEnum[sizeTok] ?? evalIntExpr(a[3], sizeEnum).value,
    };
  }

  // OperandType -> OperandTypeInfo
  const types = {};
  const order = [];
  for (const a of cpp.expandList('OPERAND_TYPE_LIST(V)', 'V')) {
    if (a.length < 2) continue;
    const name = 'k' + a[0].trim();
    const info = a[1].trim().replace(/^OperandTypeInfo::/, '');
    const cls = classes[info];
    if (!cls) throw new Error(`unknown OperandTypeInfo ${info} for OperandType ${name}`);
    types[name] = {
      typeInfo: info,
      baseSize: cls.baseSize,
      scalable: cls.scalable,
      signed: !cls.unsigned,
    };
    order.push(name);
  }

  // OPERAND_SCALE_LIST
  const scales = {};
  for (const a of cpp.expandList('OPERAND_SCALE_LIST(V)', 'V')) {
    if (a.length < 2) continue;
    scales['k' + a[0].trim()] = evalIntExpr(a[1], {}).value;
  }

  // the register-operand sub-lists tell a decoder which types are registers
  const sub = {};
  for (const listName of ['REGISTER_INPUT_OPERAND_TYPE_LIST', 'REGISTER_OUTPUT_OPERAND_TYPE_LIST',
    'REGISTER_OPERAND_TYPE_LIST', 'SCALAR_OPERAND_TYPE_LIST', 'UNSIGNED_FIXED_SCALAR_OPERAND_TYPE_LIST',
    'UNSIGNED_SCALABLE_SCALAR_OPERAND_TYPE_LIST', 'SIGNED_SCALABLE_SCALAR_OPERAND_TYPE_LIST',
    'INVALID_OPERAND_TYPE_LIST']) {
    if (!cpp.macros.has(listName)) continue;
    sub[listName] = cpp.expandList(`${listName}(V)`, 'V').map((a) => 'k' + a[0].trim()).filter((x) => x !== 'k');
  }

  return {
    operandTypes: types,
    operandTypeOrder: order,
    operandTypeInfoClasses: classes,
    operandSizes: sizeEnum,
    operandScales: scales,
    registerOperandTypes: sub.REGISTER_OPERAND_TYPE_LIST ?? [],
    registerInputOperandTypes: sub.REGISTER_INPUT_OPERAND_TYPE_LIST ?? [],
    registerOutputOperandTypes: sub.REGISTER_OUTPUT_OPERAND_TYPE_LIST ?? [],
    subLists: sub,
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
  };
}

export async function deriveBytecodes(src, defines, operands) {
  const f = await src.require('src/interpreter/bytecodes.h');
  const cpp = new Cpp(defines);
  cpp.run(f.text, { label: 'bytecodes.h' });

  // BYTECODE_LIST takes (V, V_TSA); with V8_ENABLE_EXPERIMENTAL_TSA_BUILTINS
  // undefined the #else branch has already collapsed V_TSA to V, so passing V
  // twice is the shipping configuration.
  const calls = cpp.expandList('BYTECODE_LIST(V, V)', 'V');
  const entries = [];
  for (const a of calls) {
    if (a.length < 2) continue;
    if (!/^\w+$/.test(a[0]) || !/ImplicitRegisterUse::/.test(a[1])) continue;
    entries.push({
      name: a[0],
      implicitRegisterUse: a[1].replace(/.*ImplicitRegisterUse::/, '').trim(),
      operands: a.slice(2).map((x) => x.replace(/.*OperandType::/, '').trim()).filter(Boolean),
    });
  }
  entries.forEach((e, i) => { e.value = i; });

  const byName = new Map(entries.map((e) => [e.name, e]));

  // kFirstShortStar = kStarN, kLastShortStar = kStarM
  const enumBody = /enum class Bytecode\s*:\s*uint8_t\s*\{([\s\S]*?)\n\};/.exec(f.text);
  let shortStarRange = null;
  if (enumBody) {
    const first = /kFirstShortStar\s*=\s*k(\w+)/.exec(enumBody[1]);
    const last = /kLastShortStar\s*=\s*k(\w+)/.exec(enumBody[1]);
    if (first && last && byName.has(first[1]) && byName.has(last[1])) {
      shortStarRange = {
        firstName: first[1], lastName: last[1],
        first: byName.get(first[1]).value, last: byName.get(last[1]).value,
        count: byName.get(last[1]).value - byName.get(first[1]).value + 1,
      };
    }
  }

  const unknownOperandTypes = [];
  for (const e of entries) {
    for (const o of e.operands) if (!operands.operandTypes[o]) unknownOperandTypes.push(`${e.name}:${o}`);
  }

  const prefixes = {};
  for (const [scaleName, scale] of Object.entries(operands.operandScales)) {
    if (scale === 1) continue;
    const bc = scale === 2 ? 'Wide' : scale === 4 ? 'ExtraWide' : null;
    if (bc && byName.has(bc)) prefixes[bc] = { value: byName.get(bc).value, scale, scaleName };
  }

  return {
    totalOpcodes: entries.length,
    byValue: Object.fromEntries(entries.map((e) => [e.value, e])),
    byName: Object.fromEntries(entries.map((e) => [e.name, e.value])),
    shortStarRange,
    illegalValue: byName.has('Illegal') ? byName.get('Illegal').value : null,
    prefixes,
    unknownOperandTypes,
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
  };
}

/** The intrinsic table for InvokeIntrinsic (src/interpreter/interpreter-intrinsics.h). */
export async function deriveIntrinsics(src, defines) {
  const f = await src.require('src/interpreter/interpreter-intrinsics.h');
  const cpp = new Cpp(defines);
  cpp.run(f.text, { label: 'interpreter-intrinsics.h' });
  const list = cpp.expandList('INTRINSICS_LIST(V)', 'V');
  const byId = {};
  const byName = {};
  list.forEach((a, i) => {
    if (a.length < 3) return;
    const entry = { id: i, name: a[0].trim(), runtimeFunction: a[1].trim(), argCount: Number(a[2].trim()) };
    byId[i] = entry;
    byName[entry.name] = i;
  });
  return { count: Object.keys(byId).length, byId, byName };
}

/** The runtime function table for CallRuntime (src/runtime/runtime.h). */
export async function deriveRuntime(src, defines) {
  const f = await src.require('src/runtime/runtime.h');
  const cpp = new Cpp(defines);
  // NOTHING(...) is how FOR_EACH_INLINE_INTRINSIC suppresses the non-inline half
  cpp.define('NOTHING', '', ['...'], true);
  cpp.run(f.text, { label: 'runtime.h' });

  const runtime = cpp.expandList('FOR_EACH_INTRINSIC(F)', 'F');
  const inline_ = cpp.expandList('FOR_EACH_INLINE_INTRINSIC(I)', 'I');

  const byId = {};
  const byName = {};
  let id = 0;
  const push = (a, prefix) => {
    if (a.length < 3) return;
    const name = a[0].trim();
    const entry = {
      id,
      name: prefix + name,
      enumName: 'k' + prefix + name,
      nargs: Number(a[1].trim()),
      resultSize: Number(a[2].trim()),
      kind: prefix ? 'inline' : 'runtime',
    };
    byId[id] = entry;
    byName[entry.name] = id;
    id++;
  };
  for (const a of runtime) push(a, '');
  for (const a of inline_) push(a, 'Inline');

  // the sub-lists, for provenance: which #if gated which family
  const families = {};
  for (const n of [...cpp.macros.keys()].filter((k) => /^FOR_EACH_INTRINSIC_[A-Z0-9_]+$/.test(k))) {
    const def = cpp.macros.get(n);
    if (!def || !def.params || def.params.length !== 1) continue;
    try { families[n] = cpp.expandList(`${n}(F)`, 'F').length; } catch { /* ignore */ }
  }

  return {
    count: id,
    runtimeCount: runtime.length,
    inlineCount: inline_.length,
    byId,
    byName,
    families,
    unknownConditionIdentifiers: [...cpp.unknownInConditions].sort(),
  };
}
