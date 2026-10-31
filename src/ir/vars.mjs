// src/ir/vars.mjs
//
// The variable space the SSA form is built over, and the read/write set of one
// instruction.
//
// ARCHITECTURE.md 4.2: "variables = accumulator union every register". Spelt
// out, the frame (docs/DISASM.md section 5) has three kinds of slot and only
// the first two are ever assigned:
//
//   index >= 0                      the register file: r0 .. registerCount-1
//   <this>, a0 .. a(n-1)            the parameters, below the frame
//   <context>                       assigned by PushContext / PopContext /
//                                   SwitchOnGeneratorState
//   <closure>, <new.target>,
//   bytecode array / offset,
//   feedback vector, argument count the frame header: read-only
//
// So the variable set is  accumulator + context + parameters + register file,
// and the read-only header registers become entry values with exactly one
// definition each, which is what keeps "every use has exactly one reaching
// def" true for them without a phi.
//
// Every local starts out defined, too. InterpreterEntryTrampoline fills the
// whole register file with `undefined` before the first bytecode runs (and
// sets the accumulator to undefined), so an instruction that reads a register
// nothing has written reads undefined rather than garbage. Those entry
// definitions are materialised as FrameEntry values and the ones that are
// actually live at the entry are counted, because a large count would mean the
// model missed a definition somewhere.
//
// incomingNewTargetOrGeneratorRegister is one of those register-file slots and
// nothing else: V8 stores new.target (or the generator object) into it in the
// prologue. docs/DISASM.md section 9 is explicit that it is not its own
// register kind, so it is given an entry definition like any other local and
// two references to it unify on the same variable. Treating it as a separate
// kind is what would stop `ResumeGenerator <gen>` and
// `SuspendGenerator <gen>` naming the same thing.

export const VAR_ACCUMULATOR = 0;
export const VAR_CONTEXT = 1;

/**
 * @param {object} unit     a 8.1 FunctionUnit
 * @param {Array} instructions
 */
export function varSpace(unit, instructions) {
  // The adapter path can leave these null; fall back to the widest index the
  // code actually names, and say that is what happened.
  let parameterCount = unit.parameterCount;
  let registerCount = unit.registerCount;
  let derived = null;
  if (parameterCount === null || parameterCount === undefined
    || registerCount === null || registerCount === undefined) {
    let maxLocal = -1, maxParam = -1;
    for (const ins of instructions) {
      for (const o of ins.operands) {
        const regs = o.reg ? [o.reg] : (o.regs ?? null);
        if (!regs) continue;
        for (const r of regs) {
          if (r.k === 'local' && r.i > maxLocal) maxLocal = r.i;
          else if (r.k === 'param' && r.i > maxParam) maxParam = r.i;
        }
      }
    }
    derived = { maxLocal, maxParam };
    if (parameterCount === null || parameterCount === undefined) parameterCount = maxParam + 1;
    if (registerCount === null || registerCount === undefined) registerCount = maxLocal + 1;
  }
  const paramBase = 2;
  const localBase = paramBase + parameterCount;
  const count = localBase + registerCount;

  const names = new Array(count);
  names[VAR_ACCUMULATOR] = '<acc>';
  names[VAR_CONTEXT] = '<context>';
  for (let i = 0; i < parameterCount; i++) names[paramBase + i] = i === 0 ? '<this>' : `a${i - 1}`;
  for (let i = 0; i < registerCount; i++) names[localBase + i] = `r${i}`;

  /** register (8.3 tagged form) -> variable id, or -1 when it is not a variable. */
  const varOf = (r) => {
    if (!r) return -1;
    switch (r.k) {
      case 'acc': return VAR_ACCUMULATOR;
      case 'context': return VAR_CONTEXT;
      case 'param': return r.i >= 0 && r.i < parameterCount ? paramBase + r.i : -1;
      case 'local': return r.i >= 0 && r.i < registerCount ? localBase + r.i : -1;
      default: return -1;      // closure, new.target, feedback vector, ...
    }
  };
  const regOf = (v) => {
    if (v === VAR_ACCUMULATOR) return { k: 'acc' };
    if (v === VAR_CONTEXT) return { k: 'context' };
    if (v < localBase) return { k: 'param', i: v - paramBase };
    return { k: 'local', i: v - localBase };
  };

  return {
    count, paramBase, localBase, parameterCount, registerCount, derived,
    names, varOf, regOf,
    isLocal: (v) => v >= localBase,
    isParam: (v) => v >= paramBase && v < localBase,
    name: (v) => names[v] ?? `<var${v}>`,
  };
}

/**
 * The variables one instruction reads and writes, plus where each written
 * value comes from.
 *
 * Mechanical throughout: accumulator role from `implicitRegisterUse`, register
 * roles from the operand types, and the two implicit-context tables in
 * src/ir/opcode_effects.mjs for the handlers that touch the context register
 * without an operand naming it.
 *
 * @param {object} ins   a 8.2 Instruction
 * @param {object} sem   opcodeSemantics(profile)
 * @param {object} vs    varSpace(...)
 */
export function instructionVars(ins, sem, vs) {
  const s = sem.of(ins.opcode);
  const reads = [];
  const writes = [];
  const readRegs = [];
  const writeRegs = [];

  if (s.accumulator.read) { reads.push(VAR_ACCUMULATOR); readRegs.push({ k: 'acc' }); }

  for (let k = 0; k < ins.operands.length; k++) {
    const o = ins.operands[k];
    // src/disasm appends a synthetic kRegOut for a normalised short star; the
    // profile's operand list is one shorter, so fall back on the operand's own
    // type when the semantics table has no row at this index.
    const role = s.operands[k] ?? {
      type: o.type,
      reads: sem.registerReadTypes.has(o.type),
      writes: sem.registerWriteTypes.has(o.type),
      isRegister: sem.registerReadTypes.has(o.type) || sem.registerWriteTypes.has(o.type),
    };
    if (!role.isRegister) continue;
    const regs = o.reg ? [o.reg] : (o.regs ?? []);
    for (const r of regs) {
      if (role.reads) { reads.push(vs.varOf(r)); readRegs.push(r); }
      if (role.writes) { writes.push(vs.varOf(r)); writeRegs.push(r); }
    }
  }

  if (s.accumulator.write) { writes.push(VAR_ACCUMULATOR); writeRegs.push({ k: 'acc' }); }
  if (s.implicitContextRead) { reads.push(VAR_CONTEXT); readRegs.push({ k: 'context' }); }
  if (s.implicitContextWrite) { writes.push(VAR_CONTEXT); writeRegs.push({ k: 'context' }); }

  return { sem: s, reads, writes, readRegs, writeRegs };
}

export default { varSpace, instructionVars, VAR_ACCUMULATOR, VAR_CONTEXT };
