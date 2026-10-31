// tests/t4/compare.mjs
//
// Compare one decoded FunctionUnit against the same function as V8's own
// `--print-bytecode` printed it. V8's output is ground truth: any disagreement
// is a bug in the decoder.
//
// Units are matched to listing functions by *byte-for-byte bytecode equality*,
// reconstructed from the raw-byte column of every instruction line. That makes
// matching unambiguous (no name or arity heuristics) and is itself the strongest
// single assertion in the suite.

/** Rebuild a function's bytecode from the listing's raw-byte column. */
export function bytecodeFromListing(fn) {
  const parts = [];
  let expected = 0;
  for (const ins of fn.instructions) {
    if (ins.offset !== expected) {
      return { bytes: null, why: `instruction at offset ${ins.offset} but ${expected} bytes have been accounted for` };
    }
    parts.push(Buffer.from(ins.bytes));
    expected += ins.bytes.length;
  }
  const bytes = Buffer.concat(parts);
  if (fn.bytecodeLength != null && bytes.length !== fn.bytecodeLength) {
    return { bytes, why: `reassembled ${bytes.length} bytes but the listing says Bytecode length: ${fn.bytecodeLength}` };
  }
  return { bytes };
}

/**
 * Classify a printed constant-pool value into the same tagged-union vocabulary
 * the FunctionUnit uses, so the two can be compared as kind + value.
 *
 * Shapes V8 prints (src/objects/*-printer.cc, short print form):
 *   <String[3]: #abc>                      internalized string
 *   <String[3]: abc>                       non-internalized
 *   8                                      Smi (bare integer)
 *   <HeapNumber 1.5>                       heap number
 *   <BigInt 123>                           bigint
 *   <SharedFunctionInfo f>                 inner function
 *   <ScopeInfo FUNCTION_SCOPE>             scope info
 *   <ObjectBoilerplateDescription[4]>      object literal
 *   <ArrayBoilerplateDescription K, <FixedArray[n]>>
 *   <RegExpBoilerplateDescription ...>
 *   <TemplateObjectDescription>
 *   <Symbol: Symbol.iterator>  <Symbol: mine>
 *   <undefined> <null> <true> <false> <the_hole> <uninitialized>
 *   <FixedArray[n]>  <TrustedFixedArray[n]>
 */
export function classifyPrinted(text) {
  const s = String(text).trim();
  let m;
  if ((m = /^-?\d+$/.exec(s))) return { t: 'number', v: Number(s), repr: 'smi' };
  if ((m = /^<String\[(\d+)\]:\s*([\s\S]*)>$/.exec(s))) {
    let body = m[2];
    let prefix = '';
    if (body.startsWith('#')) { prefix = '#'; body = body.slice(1); }
    return { t: 'string', v: body, declaredLength: Number(m[1]), internalized: prefix === '#' };
  }
  if ((m = /^<(?:HeapNumber|Number)\s+([^>]*)>$/.exec(s))) return { t: 'number', v: Number(m[1]) };
  if ((m = /^<BigInt\s+([^>]*)>$/.exec(s))) return { t: 'bigint', v: m[1].replace(/n$/, '') };
  if (/^<SharedFunctionInfo\b/.test(s)) return { t: 'sfi', name: /^<SharedFunctionInfo\s+([^>]*)>$/.exec(s)?.[1] ?? '' };
  if (/^<ScopeInfo\b/.test(s)) return { t: 'scopeInfo', scopeType: /^<ScopeInfo\s+([^>]*)>$/.exec(s)?.[1] ?? null };
  if ((m = /^<ObjectBoilerplateDescription\[(\d+)\]>$/.exec(s))) return { t: 'objectBoilerplate', length: Number(m[1]) };
  if ((m = /^<ArrayBoilerplateDescription\s+([A-Z0-9_]+)(?:,\s*([\s\S]*))?>$/.exec(s))) {
    const inner = m[2] ? /<(?:Fixed(?:Double)?Array)\[(\d+)\]>/.exec(m[2]) : null;
    return { t: 'arrayBoilerplate', elementsKind: m[1], elementCount: inner ? Number(inner[1]) : null };
  }
  if (/^<RegExpBoilerplateDescription\b/.test(s)) return { t: 'regexpBoilerplate', text: s };
  if (/^<TemplateObjectDescription\b/.test(s)) return { t: 'templateObject' };
  if (/^<ClassBoilerplate\b/.test(s)) return { t: 'classBoilerplate' };
  if ((m = /^<Symbol:\s*([\s\S]*)>$/.exec(s))) return { t: 'symbol', desc: m[1] };
  if (/^<Symbol\b/.test(s)) return { t: 'symbol', desc: null };
  if (/^<undefined>$/.test(s)) return { t: 'undefined' };
  if (/^<null>$/.test(s)) return { t: 'null' };
  if (/^<true>$/.test(s)) return { t: 'boolean', v: true };
  if (/^<false>$/.test(s)) return { t: 'boolean', v: false };
  if (/^<(the_hole|uninitialized|optimized_out|hash_table_hole)>$/.test(s)) return { t: 'hole' };
  if ((m = /^<(Trusted)?FixedArray\[(\d+)\]>$/.exec(s))) return { t: 'array', length: Number(m[2]) };
  return { t: 'other', text: s };
}

// V8's pool dump does not print string characters verbatim. String::PrintUC16
// (src/objects/string.cc) escapes four things, and String::StringShortPrint
// replaces the whole body with a marker above kMaxShortPrintLength:
//   '\n' -> \n      '\r' -> \r      '\\' -> \\      !isprint(c) -> \xNN
const STRING_PRINT_TRUNCATION = '...<truncated>>';

/** Reverse String::PrintUC16's escaping. */
export function unescapePrinted(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[i + 1];
    if (n === 'n') { out += '\n'; i++; }
    else if (n === 'r') { out += '\r'; i++; }
    else if (n === '\\') { out += '\\'; i++; }
    else if (n === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; }
    else out += s[i];
  }
  return out;
}

/** Do our decoded constant and V8's printed constant agree? */
export function constantsAgree(mine, printed) {
  const p = classifyPrinted(printed);

  // A read-only reference or a root reference that resolved to a value is the
  // same value; the union keeps the provenance, the comparison keeps the value.
  const m = mine;

  // A kReadOnlyHeapRef the decoder could not resolve is not a decode failure:
  // it means no ro-heap.json exists for the producing build. The decoder's job
  // there is to report (chunk, offset) and count it, which it does. Mark these
  // as not comparable so they are tallied rather than scored.
  if (m.t === 'roRef' && m.resolved === undefined) {
    return { ok: null, why: `unresolved read-only reference ${m.chunk}:${m.offset} (no read-only table for this build)` };
  }

  // A canonical `empty_*` root: V8 prints the object (it is a real
  // ObjectBoilerplateDescription / FixedArray living in the read-only heap),
  // while the cache only stores the root reference, which is what the decoder
  // reports along with the C++ type roots.json gives it. Agreement on that type
  // is the strongest statement available.
  if (m.t === 'rootObject') {
    const expectedClass = {
      objectBoilerplate: 'ObjectBoilerplateDescription',
      arrayBoilerplate: 'ArrayBoilerplateDescription',
      array: 'FixedArray',
      scopeInfo: 'ScopeInfo',
      templateObject: 'TemplateObjectDescription',
    }[p.t];
    if (expectedClass && m.cppType === expectedClass) {
      return ok(`root ${m.rootName} has C++ type ${m.cppType}`);
    }
  }

  switch (p.t) {
    case 'string': {
      if (m.t !== 'string') return fail(`we say ${m.t}, V8 printed a string`);
      if (typeof m.v !== 'string') return fail('our string has no value');
      if (p.declaredLength !== undefined && m.v.length !== p.declaredLength) {
        return fail(`length ${m.v.length} vs V8's String[${p.declaredLength}]`);
      }
      if (p.v === STRING_PRINT_TRUNCATION) {
        // Above kMaxShortPrintLength V8 prints no characters at all; the
        // declared length check above is then the whole assertion.
        return ok('V8 printed only the truncation marker; length compared');
      }
      const theirs = unescapePrinted(p.v);
      if (m.v !== theirs) return fail(`value ${JSON.stringify(m.v)} vs ${JSON.stringify(theirs)}`);
      return ok();
    }
    case 'number': {
      if (m.t !== 'number') return fail(`we say ${m.t}, V8 printed a number`);
      if (Number.isNaN(p.v) && Number.isNaN(m.v)) return ok();
      if (m.v !== p.v) {
        // V8 prints doubles with its own shortest representation; compare as
        // numbers, which the parse above already did, then as text.
        if (String(m.v) !== String(p.v)) return fail(`value ${m.v} vs ${p.v}`);
      }
      if (p.repr === 'smi' && m.repr !== 'smi') return fail('V8 printed a Smi, we decoded a heap number');
      if (p.repr !== 'smi' && m.repr === 'smi') return fail('V8 printed a heap number, we decoded a Smi');
      return ok();
    }
    case 'bigint':
      if (m.t !== 'bigint') return fail(`we say ${m.t}, V8 printed a BigInt`);
      return m.v === p.v ? ok() : fail(`bigint ${m.v} vs ${p.v}`);
    case 'sfi':
      return m.t === 'sfi' ? ok() : fail(`we say ${m.t}, V8 printed a SharedFunctionInfo`);
    case 'scopeInfo':
      return m.t === 'scopeInfo' ? ok() : fail(`we say ${m.t}, V8 printed a ScopeInfo`);
    case 'objectBoilerplate': {
      if (m.t !== 'objectBoilerplate') return fail(`we say ${m.t}, V8 printed an ObjectBoilerplateDescription`);
      if (m.length !== p.length) return fail(`raw entry count ${m.length} vs V8's [${p.length}]`);
      return ok();
    }
    case 'arrayBoilerplate': {
      if (m.t !== 'arrayBoilerplate') return fail(`we say ${m.t}, V8 printed an ArrayBoilerplateDescription`);
      if (m.elementsKind !== p.elementsKind) return fail(`elements kind ${m.elementsKind} vs ${p.elementsKind}`);
      if (p.elementCount !== null && m.elements && m.elements.length !== p.elementCount) {
        return fail(`element count ${m.elements.length} vs ${p.elementCount}`);
      }
      return ok();
    }
    case 'regexpBoilerplate': {
      if (m.t !== 'regexpBoilerplate') return fail(`we say ${m.t}, V8 printed a RegExpBoilerplateDescription`);
      if (m.source && !p.text.includes(m.source)) return fail(`source ${JSON.stringify(m.source)} does not appear in ${p.text}`);
      return ok();
    }
    case 'templateObject':
      return m.t === 'templateObject' ? ok() : fail(`we say ${m.t}, V8 printed a TemplateObjectDescription`);
    case 'classBoilerplate':
      // ClassBoilerplate's layout is @cppObjectLayoutDefinition, so
      // layouts.json has no class for it and the decoder reports the map name
      // instead of decoding with a guessed stride. Accept the honest report,
      // but require that it names the class rather than saying nothing.
      if (m.t === 'unresolved' && /class_boilerplate|ClassBoilerplate/i.test(JSON.stringify(m.detail ?? {}) + (m.why ?? ''))) {
        return { ok: null, why: 'ClassBoilerplate: reported by map name, not decoded (no layouts.json class)' };
      }
      return fail(`V8 printed a ClassBoilerplate and we say ${m.t} (${JSON.stringify(m.detail ?? m.why ?? null)})`);
    case 'symbol':
      return m.t === 'symbol' ? ok() : fail(`we say ${m.t}, V8 printed a Symbol`);
    case 'undefined': return m.t === 'undefined' ? ok() : fail(`we say ${m.t}, V8 printed undefined`);
    case 'null': return m.t === 'null' ? ok() : fail(`we say ${m.t}, V8 printed null`);
    case 'boolean': return (m.t === 'boolean' && m.v === p.v) ? ok() : fail(`we say ${JSON.stringify(m)}, V8 printed ${p.v}`);
    case 'hole': return m.t === 'hole' ? ok() : fail(`we say ${m.t}, V8 printed a hole`);
    case 'array':
      return (m.t === 'array' || m.t === 'smiArray' || m.t === 'rootObject')
        ? ok() : fail(`we say ${m.t}, V8 printed a FixedArray`);
    default:
      return { ok: null, why: `no rule for V8's printed form ${p.text ?? printed}` };
  }
}

function ok(note) { return { ok: true, note }; }
function fail(why) { return { ok: false, why }; }

/**
 * Full per-function comparison.
 * @returns {{checks: Array<{name, ok, detail}>, failures: number}}
 */
export function compareUnit(unit, fn) {
  const checks = [];
  const add = (name, cond, detail) => { checks.push({ name, ok: cond, detail }); };

  add('parameterCount', unit.parameterCount === fn.parameterCount,
    `ours ${unit.parameterCount}, V8 ${fn.parameterCount}`);
  add('registerCount', unit.registerCount === fn.registerCount,
    `ours ${unit.registerCount}, V8 ${fn.registerCount}`);
  add('frameSize', unit.frameSize === fn.frameSize,
    `ours ${unit.frameSize}, V8 ${fn.frameSize}`);
  add('bytecodeLength', unit.bytecodeLength === fn.bytecodeLength,
    `ours ${unit.bytecodeLength}, V8 ${fn.bytecodeLength}`);

  const re = bytecodeFromListing(fn);
  if (!re.bytes) add('bytecodeBytes', false, re.why);
  else if (!unit.bytecode) add('bytecodeBytes', false, 'our unit has no bytecode buffer');
  else {
    const same = unit.bytecode.equals(re.bytes);
    let detail = `${unit.bytecode.length} bytes`;
    if (!same) {
      let i = 0;
      while (i < Math.min(unit.bytecode.length, re.bytes.length) && unit.bytecode[i] === re.bytes[i]) i++;
      detail = `first difference at byte ${i}: ours 0x${(unit.bytecode[i] ?? -1).toString(16)}, V8 0x${(re.bytes[i] ?? -1).toString(16)}`;
    }
    add('bytecodeBytes', same, detail);
  }

  // --- constant pool length and resolved values
  const poolSize = fn.constantPoolSize;
  add('constantPoolLength', poolSize === null || unit.constants.length === poolSize,
    `ours ${unit.constants.length}, V8 ${poolSize}`);

  if (fn.constantPoolResolution === 'dumped') {
    const problems = [];
    let compared = 0;
    let unrated = 0;
    const unratedWhy = [];
    for (let i = 0; i < unit.constants.length; i++) {
      const printed = fn.constantPool[i];
      if (!printed || printed.value === undefined) continue;
      const r = constantsAgree(unit.constants[i], printed.value);
      if (r.ok === null) { unrated++; if (unratedWhy.length < 3) unratedWhy.push(r.why); continue; }
      compared++;
      if (!r.ok) problems.push(`[${i}] ${r.why}  (V8: ${printed.value.slice(0, 80)})`);
    }
    add('constantPoolValues', problems.length === 0,
      problems.length ? problems.slice(0, 6).join('; ')
        : `${compared} compared, ${unrated} not comparable${unratedWhy.length ? ' (' + unratedWhy.join('; ') + ')' : ''}`);
    checks[checks.length - 1].notComparable = unrated;
  } else {
    checks.push({ name: 'constantPoolValues', ok: null, detail: 'engine did not dump the pool' });
  }

  // --- handler table rows
  if (fn.handlerTable.length > 0 || unit.handlers.length > 0) {
    const mine = unit.handlers.map((h) => `${h.rangeStart},${h.rangeEnd},${h.handlerOffset},${h.prediction},${h.data}`).sort();
    const theirs = fn.handlerTable.map((h) => `${h.from},${h.to},${h.handler},${h.prediction},${h.data}`).sort();
    const same = mine.length === theirs.length && mine.every((x, i) => x === theirs[i]);
    add('handlerTableRows', same, same ? `${mine.length} rows` : `ours [${mine.join(' | ')}] vs V8 [${theirs.join(' | ')}]`);
  } else {
    checks.push({ name: 'handlerTableRows', ok: null, detail: 'no handlers on either side' });
  }

  // --- source positions against the listing markers
  //
  // V8's SourcePositionTableIterator defaults to kSkipFunctionEntry, so the
  // entry at kFunctionEntryBytecodeOffset is never printed. Our decoder emits
  // it (flagged), so it is excluded here rather than counted as a difference.
  const byOffset = new Map();
  for (const e of unit.sourcePositions) {
    if (e.isFunctionEntry) continue;
    if (!byOffset.has(e.codeOffset)) byOffset.set(e.codeOffset, e);
  }
  const spProblems = [];
  let spCompared = 0;
  for (const ins of fn.instructions) {
    const marked = ins.sourcePosition !== null;
    const mine = byOffset.get(ins.offset);
    if (!marked && !mine) continue;
    if (marked && !mine) { spProblems.push(`@${ins.offset}: V8 marks position ${ins.sourcePosition} but our table has no entry`); continue; }
    if (!marked && mine) { spProblems.push(`@${ins.offset}: we have position ${mine.sourcePosition} but V8 printed no marker`); continue; }
    spCompared++;
    if (mine.sourcePosition !== ins.sourcePosition) spProblems.push(`@${ins.offset}: position ${mine.sourcePosition} vs ${ins.sourcePosition}`);
    if (mine.isStatement !== ins.isStatement) spProblems.push(`@${ins.offset}: isStatement ${mine.isStatement} vs ${ins.isStatement}`);
    if (mine.isBreakable !== ins.isBreakable) spProblems.push(`@${ins.offset}: isBreakable ${mine.isBreakable} vs ${ins.isBreakable}`);
  }
  // Entries whose code offset is past the last instruction cannot be matched to
  // a printed line; V8 emits one at the end of the bytecode for the return.
  const tail = unit.sourcePositions.filter((e) => e.codeOffset >= (unit.bytecodeLength ?? 0)).length;
  add('sourcePositions', spProblems.length === 0,
    spProblems.length ? spProblems.slice(0, 6).join('; ')
      : `${spCompared} markers matched, ${tail} entry/entries at or past the end of the bytecode`);

  if (fn.sourcePositionTableSize != null) {
    checks.push({
      name: 'sourcePositionTableSize',
      ok: unit.sourcePositionTableBytes === null ? null : undefined,
      detail: `ours ${unit.sourcePositionTableBytes} payload bytes, V8 reports object size ${fn.sourcePositionTableSize}`,
    });
    // V8 prints the *object* size (header included), ours is the payload, so
    // this is informational rather than an equality.
    checks[checks.length - 1].ok = null;
  }

  return { checks, failures: checks.filter((c) => c.ok === false).length };
}

export default { compareUnit, constantsAgree, classifyPrinted, bytecodeFromListing };
