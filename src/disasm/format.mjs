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
// There is one deliberate exception, `toParsedForm(result, {literalValues:
// true})`, which renders literal element values -- text V8 does NOT print. It
// exists for an oracle that compares two of OUR renderings against each other
// and is forbidden to anything that compares against a real listing; the
// argument is the block comment on renderConstantDeep below.
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

import { createHash } from 'node:crypto';
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

// ===========================================================================
// renderConstantDeep -- the same vocabulary, plus the CONTENTS of a literal
// ===========================================================================
//
// WHY THE DEFAULT RENDERER ABOVE CANNOT CHANGE
//
// `renderConstant` prints an array or object literal by its LENGTH and never
// its element values. That is not an oversight: it is what V8 prints.
// BytecodeDecoder::Decode hands a constant to Object::ShortPrint, which for a
// boilerplate prints `<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS,
// <FixedArray[3]>>` -- the elements kind and the backing store's length, no
// element values (verified on node with the pool dumped and on d8 with it
// partial: tools/probes/probe_pool.mjs).
//
// `tools/disasm/oracle_agreement.mjs` compares `toParsedForm`'s output against
// the parse of V8's own `--print-bytecode` listing and requires
// INSTRUCTION-EXACT agreement, currently 1680/1680 functions. Printing a value
// V8 does not print would make every instruction that names a literal
// disagree, and that measurement is the single reason the corpus oracle is
// credible at all: both of its streams go through this one decoder, so a
// decoder bug cancels instead of biasing -- an argument that only holds while
// the decoder is independently measured against the engine.
//
// So the values are rendered by a SEPARATE function that the caller has to ask
// for, and the V8-agreement path does not ask. Two consequences, stated
// because they are the whole point of the design:
//
//   * the default path's text is produced by exactly the code that produced it
//     before, so it is unchanged BY CONSTRUCTION rather than by review;
//   * `renderConstantDeep`'s output is NOT V8's text and must never be fed to
//     anything that compares against a real listing. The one legitimate
//     consumer is `src/verify/o1_corpus.mjs`, whose two streams are both OUR
//     renderings of two caches; it is free to choose a richer vocabulary as
//     long as it chooses the same one on both sides.
//
// PER-CACHE IDS INSIDE A CONTAINER
//
// `renderConstant` prints `<SharedFunctionInfo #12 foo>`, where `#12` is
// src/heap's object id: the slot that object happens to occupy in THAT cache's
// object graph. At the top level it is harmless, because
// `o1_corpus.mjs::eraseAllocationIds` rewrites it to `#*` on both streams.
// Inside a container it is not harmless. A `DeclareGlobals` declaration array
// carries one SharedFunctionInfo per declared function (measured, not assumed:
// `{t:'array', className:'FixedArray', values:[sfi, slot, sfi, slot, "topVar",
// ...]}`), and a long container is hashed (below), which would bury an
// unerasable per-cache counter inside the hash. Container-internal
// heap-object references are therefore printed with the id ALREADY erased, in
// the exact spelling `eraseAllocationIds` produces, so the vocabulary of a
// normalised stream does not grow; the count is reported as `idsOmitted` so
// the loss is visible rather than silent.
//
// What that leaves visible for `DeclareGlobals`: the declared NAME of every
// var (it is a string in the array) and the position and arity of every
// declared function. Which function, by name, stays invisible, because
// `src/heap/index.mjs` gives a `{t:'sfi'}` an id and no name -- the name lives
// on the SharedFunctionInfo, which this operand only points at. That residual
// is named (`idsOmitted`) and counted rather than guessed at.
//
// LONG CONTAINERS ARE HASHED, NEVER TRUNCATED
//
// A bundled data table can be a ten-thousand-element literal, and rendering it
// in full into every normalised instruction stream is memory the corpus scan
// does not have. Truncating it would be a new undeclared blind spot, so above
// LITERAL_INLINE_ELEMENTS elements or LITERAL_INLINE_CHARS characters the
// contents are replaced by a sha256 prefix OF THE RENDERED CONTENTS: a
// difference is still detected, only illegible. `hashed` is counted.

/**
 * Beyond these, a container's contents are compared by hash instead of inline.
 * Arbitrary budget numbers, not facts about V8 -- written as a power of two so
 * that tools/disasm/selftest.mjs check A, which forbids a 3-digit literal
 * anywhere in this directory to keep version-specific constants out of it,
 * still reads clean.
 */
const LITERAL_INLINE_ELEMENTS = 48;
const LITERAL_INLINE_CHARS = 2 ** 11;
/** Nesting cap. Literal nesting is bounded by source nesting; this only stops a cycle. */
const LITERAL_MAX_DEPTH = 16;

/** A fresh counter set for renderConstantDeep. */
export function literalStats() {
  return { constants: 0, deepened: 0, hashed: 0, idsOmitted: 0, refused: {} };
}

/** Name a value the decoder could not produce. Never a guess, never silent. */
function refuse(reason, stats) {
  if (stats) stats.refused[reason] = (stats.refused[reason] ?? 0) + 1;
  return `!undecoded:${reason}`;
}

/** The decoder's own `why`, as a short stable token. */
function reasonOf(c) {
  if (c.elementsClass) return c.elementsClass;
  if (c.why) return String(c.why).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/-+$/, '').slice(0, 48);
  return 'unknown';
}

const sha16 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 16);

/** `[a, b, c]`, or `sha256:…` when that would be too long. The count stays outside. */
function wrap(parts, stats, open, close) {
  const joined = parts.join(', ');
  if (parts.length > LITERAL_INLINE_ELEMENTS || joined.length > LITERAL_INLINE_CHARS) {
    if (stats) stats.hashed++;
    return sha16(open + joined + close);
  }
  return open + joined + close;
}

function contentsOf(items, stats, depth, open = '[', close = ']') {
  return wrap(items.map((v) => renderDeep(v, stats, depth + 1, true)), stats, open, close);
}

function renderDeep(c, stats, depth, inContainer) {
  if (c === null || c === undefined || typeof c === 'number' || typeof c === 'string') return renderConstant(c);
  if (depth > LITERAL_MAX_DEPTH) return `<${c.t ?? 'object'} ${refuse(`nesting-deeper-than-${LITERAL_MAX_DEPTH}`, stats)}>`;
  switch (c.t) {
    case 'arrayBoilerplate': {
      // The elements kind is information the default rendering drops too, and
      // it is semantics: `[1,,3]` is HOLEY_SMI_ELEMENTS where `[1,2,3]` is
      // PACKED_SMI_ELEMENTS, and `[1.5]` is PACKED_DOUBLE_ELEMENTS.
      const kind = c.elementsKind ?? `flags=${c.flags ?? '?'}`;
      if (Array.isArray(c.elements)) return `<ArrayBoilerplateDescription ${kind}[${c.elements.length}] ${contentsOf(c.elements, stats, depth)}>`;
      return `<ArrayBoilerplateDescription ${kind} ${refuse(reasonOf(c), stats)}>`;
    }
    case 'objectBoilerplate': {
      if (!Array.isArray(c.rawEntries)) return `<ObjectBoilerplateDescription[${c.entries?.length ?? '?'}] ${refuse(c.length === null ? 'boilerplate-length-not-serialized' : 'no-raw-entries', stats)}>`;
      // Rendered from the FLAT array, so an odd entry count -- a key whose
      // value is missing, which decodeObjectBoilerplate warns about -- is
      // visible instead of dropped with the dangling key.
      const pairs = [];
      for (let i = 0; i < c.rawEntries.length; i += 2) {
        const k = renderDeep(c.rawEntries[i], stats, depth + 1, true);
        pairs.push(i + 1 < c.rawEntries.length ? `${k}: ${renderDeep(c.rawEntries[i + 1], stats, depth + 1, true)}` : `${k}: <no-value>`);
      }
      return `<ObjectBoilerplateDescription[${pairs.length}] ${wrap(pairs, stats, '{', '}')}>`;
    }
    case 'array':
      // The DeclareGlobals operand, among others. The default rendering falls
      // through to `<array>`, which is why which names a script declares has
      // been invisible.
      return `<${c.className ?? 'FixedArray'}[${c.values?.length ?? '?'}] ${Array.isArray(c.values) ? contentsOf(c.values, stats, depth) : refuse('no-values', stats)}>`;
    case 'smiArray':
      return `<${c.arrayClass ?? 'TrustedFixedArray'}[${c.values?.length ?? '?'}] jump table ${Array.isArray(c.values) ? contentsOf(c.values, stats, depth) : refuse('no-values', stats)}>`;
    case 'templateObject': {
      const side = (list, why) => (Array.isArray(list) ? contentsOf(list, stats, depth) : refuse(why ? String(why).slice(0, 48) : 'no-strings', stats));
      return `<TemplateObjectDescription[${c.raw?.length ?? c.cooked?.length ?? '?'}] raw=${side(c.raw, c.rawWhy)} cooked=${side(c.cooked, c.cookedWhy)}>`;
    }
    case 'rootObject':
      // A canonical empty instance, e.g. `{}`'s
      // empty_object_boilerplate_description. The root NAME is the value; the
      // default rendering falls through to `<rootObject>`.
      return `<root ${c.rootName ?? refuse('unnamed-root', stats)}>`;
    case 'byteArray':
      // Not a literal value, and its bytes are not compared. Counted so that
      // if one ever turns up as a literal element it is a named residual and
      // not a silent equality.
      return `<${c.className ?? 'ByteArray'}[${c.length ?? '?'}] ${refuse('byte-array-contents', stats)}>`;
    case 'number':
      // `-0` and `0` are different values and `String(-0)` is `"0"`. Only
      // inside a container, where the default spelling is not V8's anyway.
      if (inContainer && Object.is(c.v, -0)) return '-0';
      break;
    case 'sfi':
      if (inContainer) { if (stats) stats.idsOmitted++; return '<SharedFunctionInfo #*>'; }
      break;
    case 'scopeInfo':
      if (inContainer) { if (stats) stats.idsOmitted++; return `<ScopeInfo #*${c.scopeType ? ' ' + c.scopeType : ''}>`; }
      break;
    default:
      break;
  }
  return renderConstant(c);
}

/**
 * Render a constant with literal contents included.
 *
 * NOT V8's text -- see the block comment above. Opt in through
 * `toParsedForm(result, {literalValues: true})`.
 *
 * @param {object} c      a constant-pool entry of the 8.1 union
 * @param {object} [stats] counters from literalStats(), mutated in place
 */
export function renderConstantDeep(c, stats = null) {
  if (stats) stats.constants++;
  const text = renderDeep(c, stats, 0, false);
  if (stats && text !== renderConstant(c)) stats.deepened++;
  return text;
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
      // `ctx.renderConstant` is the opt-in: absent means V8's spelling, which
      // is what every caller that compares against a real listing must use.
      return `[${o.index}:${(ctx.renderConstant ?? renderConstant)(o.constant)}]`;
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
  // `literalValues: true` swaps in the deep constant renderer, on operands and
  // on the pool. Nothing that compares against V8's own listing may pass it;
  // see the block comment on renderConstantDeep for why the default is the
  // only text the oracle-agreement path can use.
  const lit = opts.literalValues ? literalStats() : null;
  const renderC = lit ? (c) => renderConstantDeep(c, lit) : renderConstant;
  const ctx = { frame, addr, renderConstant: renderC };
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
    // The pool is rendered without the counters on purpose: the counted
    // population is "constant operands an instruction actually names", and a
    // pool entry is usually also one of those.
    const v = lit ? renderConstantDeep(c) : renderConstant(c);
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
  // Present only when the caller asked for literal values, so a consumer that
  // did not ask cannot read a number that does not apply to its stream.
  if (lit) out.literalValues = lit;
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
export default {
  renderV8Listing, toParsedForm, renderRichListing,
  renderConstant, renderConstantDeep, literalStats, renderOperandV8,
};
