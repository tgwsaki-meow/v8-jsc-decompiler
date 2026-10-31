// src/disasm/format.mjs
//
// Two renderings of a disassembly, both shaped so they can be compared against
// V8's own `--print-bytecode` listing:
//
//   renderV8Listing()  text in V8's exact column layout, so a human can diff
//                      the two files side by side and so that the listing
//                      parser used on V8's output can parse OUR listing too.
//   toParsedForm()     the structure that parser produces, built by rendering
//                      each operand to the text V8 would print and handing it
//                      to the shared parseOperand() in src/listing/operands.mjs.
//                      Classification therefore cannot drift from the parser's.
//
// Both the renderer here and the parser in src/verify/bytecode_parser.mjs sit
// on src/listing/operands.mjs. This file must NOT import from src/verify/:
// src/verify/ is the oracle harness, which may spawn a real V8, and no
// decompilation layer is allowed to depend on it (ARCHITECTURE.md 11.0).
//
// Column layout, from BytecodeArray::Disassemble (src/objects/bytecode-array.cc)
// and BytecodeDecoder::Decode (src/interpreter/bytecode-decoder.cc):
//
//   <5-wide srcpos>" S> "   or 9 spaces when the instruction has no position
//   <address> " @ " <4-wide offset> " : "
//   <2-hex-digit byte + space> * n, padded with "   " to kMaxOperands+1 columns
//   <Mnemonic>[.Wide|.ExtraWide] [" " operand ", " operand ...]
//   [" (" <address> " @ " <target> ")"]            when IsJump
//   [" { " <case> ": @" <target> ", " ... " }"]    when IsSwitch
//
// The address column is incidental (it is the runtime address of the bytecode
// byte) and the parser discards it; we print a synthetic base so the column
// exists and lines up.

import { parseOperand, splitOperands } from '../listing/operands.mjs';

/**
 * Escape a string constant the way V8's String::PrintUC16 does: newline,
 * carriage return and backslash get short escapes, other control characters
 * get \xNNNN. Only used for the human-readable rendering of a constant; the
 * oracle compares constant-pool INDICES, so this never has to be byte-exact.
 */
export function escapeV8String(s) {
  return String(s).replace(/[\\\n\r\p{Cc}\p{Cf}]/gu, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    return '\\x' + ch.codePointAt(0).toString(16).padStart(4, '0');
  });
}

/** Render a 8.1 constant-pool entry the way V8's Brief()/PrintUC16 would. */
export function renderConstant(c) {
  if (c === undefined) return '<missing>';
  if (c === null) return '<null slot>';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'string') return `"${escapeV8String(c)}"`;
  switch (c.t) {
    case 'string': return `"${escapeV8String(c.v)}"`;
    case 'number': return String(c.v);
    case 'bigint': return `${c.v}n`;
    case 'boolean': return c.v ? '<true>' : '<false>';
    case 'null': return '<null>';
    case 'undefined': return '<undefined>';
    case 'hole': return '<the_hole>';
    case 'symbol': return `<Symbol: ${c.desc ?? ''}>`;
    case 'sfi': return `<SharedFunctionInfo #${c.sfiId}${c.name ? ' ' + c.name : ''}>`;
    case 'scopeInfo': return `<ScopeInfo #${c.scopeInfoId}${c.scopeType ? ' ' + c.scopeType : ''}>`;
    case 'objectBoilerplate': return `<ObjectBoilerplateDescription[${c.entries?.length ?? '?'}]>`;
    case 'arrayBoilerplate': return `<ArrayBoilerplateDescription[${c.elements?.length ?? '?'}]>`;
    case 'regexpBoilerplate': return `<RegExpBoilerplateDescription /${c.source}/${c.flags ?? ''}>`;
    case 'templateObject': return `<TemplateObjectDescription[${c.raw?.length ?? '?'}]>`;
    case 'smiArray': return `<TrustedFixedArray[${c.values?.length ?? '?'}] jump table>`;
    case 'roRef': return c.resolved ? `<${c.resolved}>` : `<read-only ref ${c.chunk}:${c.offset}>`;
    case 'unresolved': return `<UNRESOLVED ${c.why}${c.detail ? ': ' + c.detail : ''}>`;
    default: return `<${c.t ?? 'object'}>`;
  }
}

/** A register range as V8 prints it: `first-last`, `r0-r0` when empty. */
function renderRange(frame, regs) {
  if (!regs || regs.length === 0) {
    // RegisterList::first_register()/last_register() both return Register(0)
    // for an empty list (src/interpreter/bytecode-register.h).
    const z = frame.toString(frame.fromIndex(0));
    return `${z}-${z}`;
  }
  return `${frame.toString(regs[0])}-${frame.toString(regs[regs.length - 1])}`;
}

/**
 * One operand as the text V8 prints. Returns null for operands V8 folds away
 * (kRegCount) or synthesises from the opcode (the short-star register).
 */
export function renderOperandV8(o, ctx) {
  const { frame } = ctx;
  if (o.fromOpcode) return null;          // short-star register: not in V8's text
  switch (o.type) {
    case 'kRegCount': return null;        // consumed by the preceding *List
    case 'kReg': case 'kRegOut': case 'kRegInOut':
      return frame.toString(o.reg);
    case 'kRegList': case 'kRegOutList':
    case 'kRegPair': case 'kRegOutPair': case 'kRegOutTriple':
      return renderRange(frame, o.regs);
    case 'kConstantPoolIndex':
      return `[${o.index}:${renderConstant(o.constant)}]`;
    case 'kFeedbackSlot':
      return `FBV[${o.slot}]`;
    case 'kEmbeddedFeedback':
      return `EmbeddedFeedback[0x${o.slot.toString(16)}]`;
    case 'kContextSlot': case 'kCoverageSlot':
      return `[${o.slot}]`;
    case 'kUImm': case 'kImm':
      return `[${o.value}]`;
    case 'kFlag8': case 'kFlag16':
      // BytecodeDecoder prints flags in hex with no 0x prefix.
      return `#${o.value.toString(16)}`;
    case 'kRuntimeId':
      return `[${o.name ?? `runtime#${o.id}`}]`;
    case 'kIntrinsicId':
      // V8 prints the *inline runtime* name, i.e. "_" + the intrinsic name.
      return `[${o.printedName ?? o.name ?? `intrinsic#${o.id}`}]`;
    case 'kNativeContextIndex':
      // V8 names these from NATIVE_CONTEXT_FIELDS, which the profile does not
      // carry; see docs/DISASM.md "known gaps". The placeholder is shaped like
      // the name V8 prints so that it classifies the same way.
      return `[nativeContextIndex_${o.index}]`;
    case 'kAbortReason':
      // Likewise GetAbortReason(), from src/codegen/bailout-reason.h.
      return `[abortReason_${o.reason}]`;
    default:
      return `[${o.value}]`;
  }
}

/** The semantic tail of an instruction line: mnemonic + operands + annotations. */
export function renderInstructionTail(ins, ctx) {
  const mnemonic = ins.rawOpcode + (ins.prefix ? '.' + ins.prefix : '');
  const texts = [];
  for (const o of ins.operands) {
    const t = renderOperandV8(o, ctx);
    if (t !== null) texts.push(t);
  }
  let s = mnemonic;
  if (texts.length) s += ' ' + texts.join(', ');
  if (ins.jumpTarget !== null) s += ` (${ctx.addr(ins.jumpTarget)} @ ${ins.jumpTarget})`;
  if (ins.jumpTable) {
    s += ' {' + ins.jumpTable.map((e) => ` ${e.caseValue}: @${e.target ?? '?'}`).join(',') + ' }';
  }
  return s;
}

// V8 prints the runtime address of each bytecode byte. We have no address, so
// a synthetic base keeps the column present and aligned; the parser discards
// it and the comparison never looks at it. The value is arbitrary -- just big
// enough to look like a pointer.
const DEFAULT_BASE = 2 ** 32;

function makeAddr(base) {
  return (off) => '0x' + (base + off).toString(16);
}

/**
 * Bytecodes::kMaxOperands + 1 -- the width, in byte columns, that
 * BytecodeDecoder::Decode pads the hex column to. Derived from the profile so
 * it is not a literal; falls back to the widest opcode actually present.
 */
function hexColumns(result, opts) {
  if (opts.maxOperands !== undefined) return opts.maxOperands + 1;
  const byValue = result.profile?.tables?.bytecodes?.byValue;
  if (!byValue) return 1;
  let max = 0;
  for (const op of Object.values(byValue)) if (op.operands.length > max) max = op.operands.length;
  return max + 1;
}

/**
 * V8-shaped listing text for one disassembled function.
 * @param {object} result  the return value of disassemble()
 * @param {{base?: number, hex?: boolean, maxOperands?: number}} [opts]
 */
export function renderV8Listing(result, opts = {}) {
  const { unit, instructions, frame } = result;
  const base = opts.base ?? DEFAULT_BASE;
  const addr = makeAddr(base);
  const ctx = { frame, addr };
  const columns = hexColumns(result, opts);
  const name = unit.name || '';
  const L = [];
  // The SharedFunctionInfo address is incidental; the parser's header regex
  // wants one, so reuse the synthetic base.
  L.push(`[generated bytecode for function: ${name} (${addr(0)} <SharedFunctionInfo${name ? ' ' + name : ''}>)]`);
  L.push(`Bytecode length: ${unit.bytecode.length}`);
  L.push(`Parameter count ${unit.parameterCount}`);
  L.push(`Register count ${unit.registerCount}`);
  L.push(`Frame size ${unit.frameSize}`);
  for (const ins of instructions) {
    let line = '';
    if (ins.sourcePosition !== null) {
      line += String(ins.sourcePosition).padStart(5);
      line += ins.isBreakable ? (ins.isStatement ? ' S> ' : ' E> ') : (ins.isStatement ? ' s> ' : ' e> ');
    } else {
      line += '         ';
    }
    line += `${addr(ins.offset)} @ ${String(ins.offset).padStart(4)} : `;
    const bytes = [];
    for (let i = 0; i < ins.length; i++) bytes.push(unit.bytecode[ins.offset + i].toString(16).padStart(2, '0'));
    line += bytes.map((b) => b + ' ').join('');
    for (let i = ins.length; i < columns; i++) line += '   ';
    line += renderInstructionTail(ins, ctx);
    L.push(line);
  }
  L.push(`Constant pool (size = ${(unit.constants ?? []).length})`);
  const handlers = unit.handlers ?? [];
  L.push(`Handler Table (size = ${unit.handlerTableSize ?? handlers.length * 16})`);
  if (handlers.length) {
    L.push('   from   to       hdlr (prediction,   data)');
    for (const h of handlers) {
      L.push(`  (${String(h.rangeStart).padStart(4)}, ${String(h.rangeEnd).padStart(3)})  ->  ${String(h.handlerOffset).padStart(4)}`
        + ` (prediction=${h.prediction}, data=${h.data})`);
    }
  }
  L.push(`Source Position Table (size = ${unit.sourcePositionTableSize ?? 0})`);
  return L.join('\n') + '\n';
}

/**
 * Build the structure src/verify/bytecode_parser.mjs produces, so that
 * normalize.mjs / compare.mjs can be applied to our side unchanged.
 */
export function toParsedForm(result, opts = {}) {
  const { unit, instructions, frame } = result;
  const base = opts.base ?? DEFAULT_BASE;
  const addr = makeAddr(base);
  const ctx = { frame, addr };
  const out = {
    name: unit.name || '',
    headerName: unit.name || '',
    bytecodeLength: unit.bytecode.length,
    parameterCount: unit.parameterCount ?? null,
    registerCount: unit.registerCount ?? null,
    frameSize: unit.frameSize ?? null,
    instructions: [],
    constantPool: [],
    constantPoolSize: (unit.constants ?? []).length,
    constantPoolResolution: 'dumped',
    handlerTable: (unit.handlers ?? []).map((h) => ({
      from: h.rangeStart, to: h.rangeEnd, handler: h.handlerOffset,
      prediction: h.prediction, data: h.data,
    })),
    handlerTableSize: unit.handlerTableSize ?? (unit.handlers ?? []).length * 16,
    sourcePositionTableSize: unit.sourcePositionTableSize ?? null,
  };
  (unit.constants ?? []).forEach((c, i) => {
    const v = renderConstant(c);
    out.constantPool[i] = { index: i, value: v, raw: v };
  });
  for (const ins of instructions) {
    const operandTexts = [];
    for (const o of ins.operands) {
      const t = renderOperandV8(o, ctx);
      if (t !== null) operandTexts.push(t);
    }
    const bytes = [];
    for (let i = 0; i < ins.length; i++) bytes.push(unit.bytecode[ins.offset + i]);
    out.instructions.push({
      raw: null,
      sourcePosition: ins.sourcePosition,
      isStatement: ins.isStatement,
      isExpression: ins.sourcePosition !== null && !ins.isStatement,
      isBreakable: ins.isBreakable,
      address: addr(ins.offset),
      offset: ins.offset,
      bytes,
      // V8 prints the short-star opcode itself, with no operand; normalize.mjs
      // expands it. Keep the raw name so both sides go through that expansion.
      opcode: ins.rawOpcode,
      scale: ins.prefix,
      operands: operandTexts.map(parseOperand),
      jumpTarget: ins.jumpTarget,
      jumpTable: ins.jumpTable ? ins.jumpTable.map((e) => ({ caseValue: e.caseValue, target: e.target })) : null,
      operandText: operandTexts.join(', '),
    });
  }
  return out;
}

/** A compact, information-dense listing for humans reading our own output. */
export function renderRichListing(result, opts = {}) {
  const { unit, instructions, frame, stats } = result;
  const ctx = { frame, addr: makeAddr(opts.base ?? DEFAULT_BASE) };
  const L = [];
  L.push(`function ${unit.name || '<anonymous>'}  `
    + `sfi=${unit.sfiId ?? '?'} bytecode=${unit.bytecodeId ?? '?'} literalId=${unit.functionLiteralId ?? '?'}`);
  L.push(`  kind=${unit.kind ?? '?'}${unit.isGenerator ? ' generator' : ''}${unit.isAsync ? ' async' : ''}`
    + `${unit.isStrict ? ' strict' : ''}  source=[${unit.startPosition ?? '?'},${unit.endPosition ?? '?'})`);
  L.push(`  bytecode ${unit.bytecode.length}B  params ${unit.parameterCount} (incl. receiver)  registers ${unit.registerCount}`
    + `  frame ${unit.frameSize}  maxArguments ${unit.maxArguments}`);
  L.push(`  constants ${(unit.constants ?? []).length}  handlers ${(unit.handlers ?? []).length}`
    + `  sourcePositions ${stats.sourcePositionsAttached}/${stats.sourcePositionsTotal}`);
  L.push(`  instructions ${stats.instructions}  jumps ${stats.jumps}  jumpTables ${stats.jumpTables}`
    + ` (${stats.jumpTableEntries} entries)  prefixed ${stats.prefixed}  maxScale ${stats.maxScale}`);
  const targets = new Set();
  for (const ins of instructions) {
    if (ins.jumpTarget !== null) targets.add(ins.jumpTarget);
    if (ins.jumpTable) for (const e of ins.jumpTable) if (e.target !== null) targets.add(e.target);
  }
  for (const ins of instructions) {
    const mark = targets.has(ins.offset) ? '>' : ' ';
    const pos = ins.sourcePosition !== null
      ? `${String(ins.sourcePosition).padStart(6)}${ins.isStatement ? 'S' : 'E'}${ins.isBreakable ? '>' : ' '}`
      : '        ';
    const texts = [];
    for (const o of ins.operands) {
      const t = renderOperandV8(o, ctx);
      if (t !== null) texts.push(t);
    }
    let line = `${pos}${mark}${String(ins.offset).padStart(6)}: ${ins.opcode}${ins.prefix ? '.' + ins.prefix : ''}`;
    if (texts.length) line += ' ' + texts.join(', ');
    if (ins.jumpTarget !== null) line += `  -> @${ins.jumpTarget}`;
    if (ins.jumpTable) line += `  -> { ${ins.jumpTable.map((e) => `${e.caseValue}: @${e.target ?? '?'}`).join(', ')} }`;
    L.push(line);
  }
  if ((unit.handlers ?? []).length) {
    L.push('  handler table:');
    for (const h of unit.handlers) {
      L.push(`    [${h.rangeStart},${h.rangeEnd}) -> ${h.handlerOffset}  prediction=${h.prediction}`
        + ` wasUsed=${h.wasUsed} data=${h.data}`);
    }
  }
  if ((unit.constants ?? []).length && opts.constants !== false) {
    L.push('  constant pool:');
    unit.constants.forEach((c, i) => L.push(`    ${String(i).padStart(4)}: ${renderConstant(c)}`));
  }
  if (result.warnings.length) {
    L.push('  warnings:');
    for (const w of result.warnings) L.push(`    ${w.code} @${w.offset ?? '?'}: ${w.message ?? ''}`);
  }
  return L.join('\n') + '\n';
}

export { splitOperands };
export default { renderV8Listing, toParsedForm, renderRichListing, renderConstant, renderOperandV8 };
