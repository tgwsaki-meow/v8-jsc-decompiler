// src/structure/jumps.mjs
//
// `break` / `continue` / labels.
//
// An edge that leaves the region being built is one of four things, and they
// are tried innermost-first so the minimal correct statement comes out:
//
//   the chain's own fall-out      nothing at all: control reaches that block
//                                 by falling off the end of this region
//   an enclosing loop's continue  `continue`, labelled when the loop is not
//     target                      the innermost one
//   an enclosing breakable's      `break`, labelled when it is not the
//     break target                innermost breakable (a loop or a `switch`)
//   an enclosing chain's          `break <label>` with the chain wrapped in
//     fall-out                    `{r:'labeled'}` -- a labelled block, which
//                                 is what source `label: { ... break label }`
//                                 compiles to and also what a jump to a join
//                                 an ancestor owns needs
//
// anything else is unstructurable, and says so rather than guessing.
//
// Innermost-first matters and is not just about shorter output. From a real
// listing of `outer: for(..){ inner: for(..){ if(..) continue outer; ... } }`,
// V8 puts the outer loop's update block at B9 and `continue outer` is a jump
// to B9 -- which is *also* the inner loop's follow, because the inner loop is
// the last statement of the outer body. Resolving innermost-first gives a
// plain `break`, which has exactly the same meaning as `continue outer` there
// and needs no label at all.
//
// Labels live in their own namespace in JavaScript, so `L7` as a label can
// never collide with `L7` as a variable; deriving the name from the block id
// keeps it stable across runs, which O2 (the round-trip fixpoint) requires.

/** The label a construct uses, allocated on first demand so unused ones never appear. */
export function labelFor(frame, labels) {
  if (frame.label) return frame.label;
  frame.label = frame.kind === 'chain' ? `L${frame.head}x${frame.id}` : `L${frame.head}`;
  labels.push({
    id: frame.label, forRegion: frame.kind, head: frame.head, usedBy: [],
  });
  frame.labelRecord = labels[labels.length - 1];
  return frame.label;
}

/**
 * The second pass: a **forward jump to a join an enclosing chain has not
 * reached yet**.
 *
 * This is the short-circuit condition, and it is the single most common shape
 * in the corpus that the four rules above cannot express. From a real listing
 * (`b_346background.jsc` #231):
 *
 *   B2  ... JumpIfToBooleanFalse -> B4     // if (!y) goto B4
 *   B3  ... JumpIfToBooleanFalse -> B5     // if (!z) goto B5, else B4
 *   B4  ... Jump -> B6
 *   B5  ...                                 // falls into B6
 *   B6  Return
 *
 * i.e. `if (y && !z) { B5 } else { B4 }`. B4 is the `else` body *and* an
 * immediate-dominator child of B2 with two in-edges, so it satisfies
 * Cifuentes' follow rule and is picked as the follow -- after which the `B5`
 * side has to reach B6, which lies past that follow. There is no nesting of
 * `if`/`else` that expresses this without either a compound condition (which
 * ARCHITECTURE.md 11.2's `Test` cannot carry -- it is one SSA value) or
 * emitting a block twice (which 11.3 invariant 1 forbids).
 *
 * A labelled block expresses it exactly, and both halves are already in
 * 11.2's vocabulary:
 *
 *   L: { B2; if (y && !z) { B5; break L; } B4; }
 *   B6
 *
 * So: the enclosing chain that is going to emit the target later wraps
 * everything from the current statement up to that target in `{r:'labeled'}`,
 * and the jump becomes `break <label>`. The chain records the request and
 * performs the wrap when it actually arrives at the target; a request that is
 * never satisfied fails the function into the honest fall-back rather than
 * producing a `break` to a label that ends in the wrong place.
 *
 * Two conditions, both necessary:
 *
 *   * the target is inside the frame's own region (`allowed`), and
 *   * the frame does not end before it. A chain stops at its fall-out, and
 *     `BytecodeGenerator` is a single pass over the AST that never reorders,
 *     so "ends before it" is `offset(target) >= offset(fallOut)`. Without
 *     this the innermost chain claims a target it is about to walk away
 *     from.
 *
 * @param {number} target
 * @param {Array} frames    innermost last
 * @param {Array} labels
 * @param {{offsetOf:(b:number)=>number, emitted:(b:number)=>boolean}} env
 */
export function resolveForwardJoin(target, frames, labels, env) {
  if (env.emitted(target)) return null;
  const claim = (f) => {
    let req = f.pendingJoins.get(target);
    if (!req) {
      const id = `J${f.head}x${f.id}t${target}`;
      req = { label: id, at: f.bodyLen(), target };
      f.pendingJoins.set(target, req);
      env.reserve(target, f);
      labels.push({ id, forRegion: 'labeledJoin', head: f.head, target, usedBy: [] });
      req.record = labels[labels.length - 1];
    }
    req.record.usedBy.push({ kind: 'break', target });
    return { region: { r: 'break', label: req.label }, kind: 'labelledJoin', frame: f };
  };

  // One owner per join. Picking the innermost eligible frame independently on
  // every jump gives two frames a request for the same block when the frame
  // stacks differ, and only one of them can wrap it -- so the first claim is
  // binding, and a later jump either reuses it or declines.
  const owner = env.ownerOf(target);
  if (owner !== undefined) return frames.includes(owner) ? claim(owner) : null;

  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.kind !== 'chain') continue;
    if (f.allowed && !f.allowed.has(target)) continue;
    if (f.fallOut !== null && f.fallOut !== undefined
      && env.offsetOf(target) >= env.offsetOf(f.fallOut)) continue;
    if (env.offsetOf(target) <= env.offsetOf(f.head)) continue;
    return claim(f);
  }
  return null;
}

/**
 * How to get to `target` from inside the region described by `frames`.
 *
 * @param {number} target
 * @param {Array} frames    innermost last; each is
 *        {kind:'loop'|'switch'|'try'|'chain', head, isLoop, isBreakable,
 *         breakTarget, continueTarget, fallOut, label}
 * @param {Array} labels    the function's label list, appended to on demand
 * @returns {{region: object|null, kind: string, frame: object}|null}
 */
export function resolveJump(target, frames, labels) {
  const innermostLoop = [...frames].reverse().find((f) => f.isLoop) ?? null;
  const innermostBreakable = [...frames].reverse().find((f) => f.isBreakable) ?? null;

  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.isLoop && f.continueTarget === target) {
      const label = f === innermostLoop ? null : labelFor(f, labels);
      if (label) f.labelRecord.usedBy.push({ kind: 'continue', target });
      return { region: { r: 'continue', label }, kind: 'continue', frame: f };
    }
    if (f.isBreakable && f.breakTarget === target && f.breakTarget !== null) {
      const label = f === innermostBreakable ? null : labelFor(f, labels);
      if (label) f.labelRecord.usedBy.push({ kind: 'break', target });
      return { region: { r: 'break', label }, kind: 'break', frame: f };
    }
    if (f.kind === 'chain' && f.fallOut === target) {
      // falling out of an ancestor chain: a labelled block is the only way to
      // say that from in here
      const label = labelFor(f, labels);
      f.labelRecord.usedBy.push({ kind: 'break', target });
      f.needsLabel = true;
      return { region: { r: 'break', label }, kind: 'labelledBreak', frame: f };
    }
  }
  return null;
}

export default { resolveJump, resolveForwardJoin, labelFor };
