// Comparator for two normalised bytecode streams.
//
// Reports, per function:
//   exactMatch            normalised streams are identical
//   opcodeSimilarity      Dice coefficient over the LCS of the opcode sequences
//   instructionSimilarity same, over whole normalised instructions
//   prefixMatch           how many leading instructions are identical
//   firstDivergence       index + the two sides with surrounding context
//
// The LCS-based score is used rather than position-by-position equality so that
// a single inserted instruction costs one unit instead of destroying the rest
// of the alignment.

/** Longest common subsequence length, with O(n*m) time and O(min) space. */
export function lcsLength(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[b.length];
}

const dice = (lcs, n, m) => (n + m === 0 ? 1 : (2 * lcs) / (n + m));

export function compareFunctions(a, b, { context = 4 } = {}) {
  const ai = a.perInstruction, bi = b.perInstruction;
  let prefix = 0;
  while (prefix < ai.length && prefix < bi.length && ai[prefix] === bi[prefix]) prefix++;

  // Handler tables are only comparable when both engines actually listed the
  // entries (a release d8 prints the size but not the rows). When they are not
  // comparable, fall back to comparing the declared table size, which both
  // engines always print.
  const handlersComparable = a.handlersListed && b.handlersListed;
  const handlerMatch = handlersComparable
    ? a.handlerStream === b.handlerStream
    : a.handlerTableSize === b.handlerTableSize;

  const exactMatch = ai.length === bi.length && prefix === ai.length && handlerMatch;

  const opLcs = lcsLength(a.opcodes, b.opcodes);
  const inLcs = ai.length === bi.length && prefix === ai.length ? ai.length : lcsLength(ai, bi);

  let firstDivergence = null;
  if (!exactMatch) {
    const idx = prefix;
    firstDivergence = {
      index: idx,
      left: ai[idx] ?? '<end of stream>',
      right: bi[idx] ?? '<end of stream>',
      leftContext: ai.slice(Math.max(0, idx - context), idx + context + 1),
      rightContext: bi.slice(Math.max(0, idx - context), idx + context + 1),
    };
  }

  return {
    name: a.name === b.name ? a.name : `${a.name} vs ${b.name}`,
    exactMatch,
    instructionCounts: [ai.length, bi.length],
    parameterCounts: [a.parameterCount, b.parameterCount],
    opcodeSimilarity: dice(opLcs, a.opcodes.length, b.opcodes.length),
    instructionSimilarity: dice(inLcs, ai.length, bi.length),
    prefixMatch: prefix,
    handlerMatch,
    handlersComparable,
    handlerTableSizes: [a.handlerTableSize, b.handlerTableSize],
    constantPoolResolution: [a.constantPoolResolution, b.constantPoolResolution],
    unresolvedConstantOperands: [a.unresolvedConstantOperands, b.unresolvedConstantOperands],
    firstDivergence,
  };
}

/**
 * Compare two whole dumps by matching functions on name, then on position for
 * the leftovers (anonymous functions all share the empty name).
 */
export function compareDumps(leftFns, rightFns, opts = {}) {
  const used = new Set();
  const pairs = [];
  const leftOnly = [], rightOnly = [];

  const byName = new Map();
  rightFns.forEach((f, i) => {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(i);
  });

  for (const lf of leftFns) {
    const candidates = byName.get(lf.name);
    const j = candidates?.find((k) => !used.has(k));
    if (j === undefined) { leftOnly.push(lf.name); continue; }
    used.add(j);
    pairs.push(compareFunctions(lf, rightFns[j], opts));
  }
  rightFns.forEach((f, i) => { if (!used.has(i)) rightOnly.push(f.name); });

  const n = pairs.length;
  const mean = (sel) => (n === 0 ? 0 : pairs.reduce((a, p) => a + sel(p), 0) / n);
  return {
    functions: pairs,
    exact: pairs.filter((p) => p.exactMatch).length,
    total: n,
    leftOnly, rightOnly,
    meanOpcodeSimilarity: mean((p) => p.opcodeSimilarity),
    meanInstructionSimilarity: mean((p) => p.instructionSimilarity),
  };
}
