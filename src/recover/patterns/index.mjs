// src/recover/patterns/index.mjs
//
// The idiom engine: a fixed-priority driver plus the match/rewrite protocol.
//
// Every family in the table below is the inverse of a named
// `BytecodeGenerator::Visit<Node>` / `Build<Thing>` method at the pinned tag,
// and each family states which one in its own header; docs/RECOVER.md collects
// the citations into one table. A recogniser with no cited source method would
// be a guess, and the protocol makes that visible: `claim()` requires
// `cites`, and a claim with no `cites` is forced to `confidence:'shape'`.
//
// Priority is fixed and it matters where shapes overlap:
//
//   1  asyncgen   `await` / `yield` / `yield*`. First, because the resume-mode
//                 dispatch after a suspend is a `TestReferenceEqual` plus a
//                 conditional jump, which the logical family would otherwise
//                 claim.
//   2  classes    `DefineClass` and the super/home-object plumbing, which
//                 contains property stores the literal family would fold.
//   3  forof      the iterator protocol, which contains calls and a `try`.
//   4  forin      `ForInPrepare` .. `ForInStep`.
//   5  destructure the GetNamedProperty + JumpIfUndefined default-value shape,
//                 before logical claims the jump.
//   6  spread     `CallWithSpread` / `CreateArrayFromIterable` /
//                 `CreateRestParameter` / `%CopyDataProperties`.
//   7  literals   object / array boilerplate completion, templates, tagged
//                 templates.
//   8  accessor   `%DefineGetter/Setter/AccessorPropertyUnchecked` and
//                 computed keys.
//   9  optional   `?.` and `?.()`. Before logical: both branch on
//                 `JumpIfUndefinedOrNull`.
//  10  logical    `&&` `||` `??` and the ternary.
//  11  update     `++` / `--` (VisitCountOperation's ToNumeric+Inc dance).
//  12  typeofetc  typeof / delete / in / instanceof -- counted here, but
//                 transcribed directly in expr.mjs because each is one opcode.
//  13  misc       the remaining single-instruction desugarings.

import logical from './logical.mjs';
import optional from './optional.mjs';
import literals from './literals.mjs';
import forin from './forin.mjs';
import forof from './forof.mjs';
import destructure from './destructure.mjs';
import spread from './spread.mjs';
import classes from './classes.mjs';
import asyncgen from './asyncgen.mjs';
import accessor from './accessor.mjs';
import typeofetc from './typeofetc.mjs';
import update from './update.mjs';
import misc from './misc.mjs';

export const FAMILIES = Object.freeze([
  asyncgen, classes, forof, forin, destructure, spread, literals, accessor,
  optional, logical, update, typeofetc, misc,
]);

export function runPatterns(pc) {
  for (const f of FAMILIES) {
    const before = pc.patterns.length;
    try {
      f.run(pc);
    } catch (e) {
      pc.warn('patternFamilyThrew', { family: f.name, error: e.message, stack: e.stack?.split('\n')[1]?.trim() });
    }
    pc.stats.byFamily[f.name] = (pc.stats.byFamily[f.name] ?? 0) + (pc.patterns.length - before);
  }
}

export default { runPatterns, FAMILIES };
