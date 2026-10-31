// The textual operand vocabulary of V8's bytecode listing.
//
// This is the one piece of the listing format that is needed in BOTH
// directions:
//
//   src/disasm/format.mjs           our FunctionUnit  --render-->  listing text
//   src/verify/bytecode_parser.mjs  V8's listing text --parse--->  structure
//
// It used to live only in src/verify/, which made src/disasm/ (a decompilation
// layer) import from src/verify/ (the oracle harness) -- the wrong direction,
// and the only edge that made the shipping pipeline look like it depended on
// the verification side. Nothing here spawns a process, reads a profile or
// knows a V8 version: it is string <-> plain object, and the renderer and the
// parser are inverses of each other (asserted by tools/disasm/selftest.mjs
// check L and by tools/oracle/selftest.mjs).
//
// Grammar, from BytecodeDecoder::Decode (src/interpreter/bytecode-decoder.cc):
//
//   r3                register
//   a1                parameter
//   r3-r5 / a0-a2     register range (kRegList; V8 prints ascending here even
//                     though the allocation is descending)
//   <context>         special register: context closure this new.target
//   FBV[7]            kFeedbackSlot
//   EmbeddedFeedback[0x1c]   kEmbeddedFeedback (14.6+ for the 6 compares)
//   #29               kFlag8 / kFlag16 / raw immediate printed with '#'
//   [2:<String: "x">] constant pool index + the engine's annotation
//   [-14]             signed immediate (jump deltas included)
//   [Array.isArray]   kRuntimeId / kIntrinsicId resolved to a name

/** Strip the incidental heap address from a printed heap-object value. */
export function stripAddress(s) {
  return s.replace(/\b0x[0-9a-fA-F]{6,}\s+(?=<)/g, '').trim();
}

/** Split an operand list on commas that are not nested in brackets or quotes. */
export function splitOperands(text) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '(' || c === '{' || c === '<') { depth++; cur += c; continue; }
    if (c === ']' || c === ')' || c === '}' || c === '>') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/**
 * Classify one operand's text.
 * Every kind round-trips through renderOperand().
 */
export function parseOperand(text) {
  let m;
  if ((m = /^r(\d+)-r(\d+)$/.exec(text))) return { kind: 'regRange', fromKind: 'reg', from: +m[1], to: +m[2], raw: text };
  if ((m = /^a(\d+)-a(\d+)$/.exec(text))) return { kind: 'regRange', fromKind: 'param', from: +m[1], to: +m[2], raw: text };
  if ((m = /^r(\d+)$/.exec(text))) return { kind: 'reg', index: +m[1], raw: text };
  if ((m = /^a(\d+)$/.exec(text))) return { kind: 'param', index: +m[1], raw: text };
  if ((m = /^<([a-z.]+)>$/.exec(text))) return { kind: 'specialReg', name: m[1], raw: text };
  if ((m = /^FBV\[(\d+)\]$/.exec(text))) return { kind: 'feedback', slot: +m[1], raw: text };
  if ((m = /^EmbeddedFeedback\[(0x[0-9a-fA-F]+|\d+)\]$/.exec(text))) return { kind: 'embeddedFeedback', slot: m[1], raw: text };
  if ((m = /^#(-?\d+)$/.exec(text))) return { kind: 'flag', value: +m[1], raw: text };
  if ((m = /^\[(\d+):([\s\S]*)\]$/.exec(text))) return { kind: 'constant', index: +m[1], value: m[2], raw: text };
  if ((m = /^\[(-?\d+)\]$/.exec(text))) return { kind: 'imm', value: +m[1], raw: text };
  if ((m = /^\[([A-Za-z_][\w.]*)\]$/.exec(text))) return { kind: 'name', name: m[1], raw: text };
  return { kind: 'other', text, raw: text };
}

/** The inverse of parseOperand(). */
export function renderOperand(op) {
  switch (op.kind) {
    case 'regRange': {
      const p = op.fromKind === 'param' ? 'a' : 'r';
      return `${p}${op.from}-${p}${op.to}`;
    }
    case 'reg': return `r${op.index}`;
    case 'param': return `a${op.index}`;
    case 'specialReg': return `<${op.name}>`;
    case 'feedback': return `FBV[${op.slot}]`;
    case 'embeddedFeedback': return `EmbeddedFeedback[${op.slot}]`;
    case 'flag': return `#${op.value}`;
    case 'constant': return `[${op.index}:${op.value}]`;
    case 'imm': return `[${op.value}]`;
    case 'name': return `[${op.name}]`;
    default: return op.text;
  }
}

export default { stripAddress, splitOperands, parseOperand, renderOperand };
