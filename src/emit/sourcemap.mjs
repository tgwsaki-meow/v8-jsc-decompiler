// src/emit/sourcemap.mjs
//
// A source map built from the REAL positions, plus ARCHITECTURE.md 3.5's
// monotonicity check.
//
// What is available and what is not. T7 puts `pos.sourcePosition` on every
// Stmt and Expr and the unit carries `startPosition`/`endPosition` -- all of
// them CHARACTER OFFSETS into the original source (ARCHITECTURE.md 8.1, from
// V8's SourcePositionTable). The original source TEXT is not available: a code
// cache stores a source hash and a length, never the source, so there is no
// way to turn an offset into a (line, column) pair.
//
// So the map is emitted in the one coordinate space the input actually
// supports: original line 1, original column = the character offset.
// `sourcesContent` is `null`, and `x_v8d_sourcePositionsAreCharacterOffsets`
// marks the convention so a consumer cannot mistake column 4821 for a real
// column. Inventing line numbers by guessing where the newlines were would be
// exactly the kind of plausible placeholder ARCHITECTURE.md 7 forbids.
//
// The mappings are generated from @babel/generator's own `rawMappings` when
// the caller asks it for a map, keyed by the `loc` this layer attached. The
// cheap half -- and the one worth having -- is the monotonicity check: a
// decompiled function's statements must appear in the same order as their
// source positions, and an inversion means two statements were reordered.
// ARCHITECTURE.md 3.5(c) calls it a cheap correctness assertion; it is run per
// function and reported, never used to reject anything.

/**
 * Attach `loc` to every node that carries a recorded position, so
 * @babel/generator emits a mapping for it.
 *
 * Original line 1, original column = the character offset (see above).
 */
export function applyPositions(positions) {
  let withPosition = 0;
  for (const p of positions) {
    if (p.sourcePosition === null || p.sourcePosition === undefined) continue;
    const point = { line: 1, column: p.sourcePosition };
    p.node.loc = { start: point, end: point, filename: undefined, identifierName: undefined };
    withPosition++;
  }
  return withPosition;
}

/**
 * ARCHITECTURE.md 3.5(c): the emitted statement order must agree with the
 * source order.
 *
 * Only statements T7 marked `isStatement` are compared -- a sub-expression's
 * position is not required to be monotone, and V8's own position table only
 * claims statement granularity. The result is counts, not a verdict.
 */
export function monotonicity(positions) {
  const seq = positions
    .filter((p) => p.isStatement && p.sourcePosition !== null && p.sourcePosition !== undefined)
    .map((p) => p.sourcePosition);
  let inversions = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) inversions++;
  return {
    statementsWithAPosition: seq.length,
    inversions,
    monotone: inversions === 0,
    first: seq.length ? seq[0] : null,
    last: seq.length ? seq[seq.length - 1] : null,
  };
}

/**
 * Finish the map @babel/generator produced.
 * @param {object|null} map  generator output `.map`
 * @param {string} sourceName
 */
export function finishMap(map, sourceName, extra = {}) {
  if (!map) return null;
  const out = {
    version: 3,
    file: extra.file ?? null,
    sources: [sourceName],
    sourcesContent: [null],
    names: map.names ?? [],
    mappings: map.mappings ?? '',
    // The convention, written into the map so nothing has to assume it.
    x_v8d_sourcePositionsAreCharacterOffsets: true,
    x_v8d_note: 'original line is always 1; original column is the character '
      + 'offset from V8\'s SourcePositionTable. A code cache does not carry the '
      + 'source text, so no line/column pair can be derived.',
    ...extra.fields,
  };
  return out;
}

export default { applyPositions, monotonicity, finishMap };
