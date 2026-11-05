// src/emit/holes.mjs
//
// How this layer says "I don't know", and how it counts saying it.
//
// ARCHITECTURE.md 7 and 11.3 invariant 6: every `{e:'hole'}`, `{s:'hole'}` and
// `{r:'unstructured'}` must be VISIBLE in the emitted text and COUNTED in the
// report. A plausible placeholder is forbidden -- correct-but-ugly is fine,
// silently-wrong is not.
//
// The rendering rules, and why each is what it is:
//
//   an expression hole   `__hole` with a leading `/* HOLE why: detail */`.
//                        NOT `undefined`, which is a known global and would
//                        make metric 5 (free identifiers that are real
//                        globals) read BETTER for a hole than for a recovered
//                        name. NOT a call to an invented function either: a
//                        hole must be assignable, because a hole can land in
//                        an assignment target. `__hole` is declared once per
//                        function that needs it (names.mjs), so 11.3's "no
//                        free identifier" is kept.
//
//   a statement hole     the same identifier as an expression statement, so
//                        the marker survives a reformat and a reparse.
//
//   a dropped statement  a block T8 `removed` for which T7 still produced
//                        statements. Rendering them would place code the
//                        structure tree has no slot for; dropping them
//                        silently is the one thing 7 forbids. So the count and
//                        the block id are emitted as a comment at the end of
//                        the function body and reported as
//                        `droppedStatementsOnRemovedBlocks`.
//
// `why` is never invented here: it is T7's own `why` (docs/RECOVER.md 6) or one
// of the codes this layer declares in EMIT_HOLE_WHY.

import * as t from '@babel/types';

/** The hole reasons this layer adds to T7's set, each with what it means. */
/** How much of a `why`/`detail`/`dump` triple survives into a comment. */
const MAX_HOLE_COMMENT = 220;

/** The hole reasons this layer adds to T7's set, each with what it means. */
export const EMIT_HOLE_WHY = Object.freeze({
  joinUnresolved: 'a Test/Target SSA value with no `exprs` entry (11.3 invariant 2)',
  unknownExprTag: 'an Expr tag outside 11.1 plus docs/RECOVER.md 5',
  unknownStmtTag: 'a Stmt tag outside 11.1',
  blockWithoutStatements: 'a {r:\'block\'} leaf T7 produced no statements for',
  templateObjectAsValue: 'a tagged template\'s raw/cooked pair survived to a value position',
  classMembersNotDecoded: '%DefineClass\'s args[0] is not a decoded ClassBoilerplate, so this '
    + 'class has no member list at all (docs/RECOVER.md 8.1)',
  // The member list IS decoded and one member still could not be placed. Each
  // reason is its own why, because they fail for different reasons and lumping
  // them together is what made the old single counter uninformative.
  classMemberKindNotSpellable: 'a ClassBoilerplate member whose ValueKind this layer cannot '
    + 'spell -- kAutoAccessor (`accessor x`) is the only one',
  classMemberKeyKindNotSpellable: 'a class member keyed by a Symbol, which has no source spelling',
  classMemberValueArgumentMissing: 'the boilerplate names an argument index the %DefineClass '
    + 'call does not have',
  classMemberKeyArgumentMissing: 'the boilerplate names a computed-key argument index the '
    + '%DefineClass call does not have',
  classMemberValueIsNotAClosure: 'a class member whose value reached this layer as something '
    + 'other than a `{e:fn}`, so there is no body to put in the class',
  classMemberAlreadyEmitted: 'a class member whose unit was already emitted elsewhere',
  classMemberWithoutAUnit: 'a class member naming an SFI this file does not carry',
  classAccessorIsAsyncOrAGenerator: 'a class getter or setter whose unit is async or a '
    + 'generator; `async get x(){}` and `get *x(){}` are both SyntaxErrors',
  classMemberNotPlaced: 'a class member src/heap or T7 refused, under a reason this layer does '
    + 'not have its own counter for',
  superOutsideAMethod: '`super` in a unit not emitted as a class method',
  awaitOutsideAnAsyncFunction: 'an {e:\'await\'} in a unit whose SFI is not async',
  yieldOutsideAGenerator: 'an {e:\'yield\'} in a unit whose SFI is not a generator',
  unitNotRecovered: 'recover() or structure() threw for this unit',
  contextBindingUnplaceable: 'a context slot this function reads belongs to a frame whose '
    + 'owning function could not be determined, so there is no scope to declare the binding '
    + 'in; declaring it locally would shadow the closure (scopes.mjs::SCOPE_REFUSAL_WHY)',
  updateTargetNotAnLVal: 'an {e:\'update\'} whose argument cannot be written',
  assignTargetNotAnLVal: 'an assignment target that is not an identifier, member or pattern',
  forUpdateNotAnExpression: 'a `for` update region that is not a single expression',
  unstructuredExitEdge: 'an unstructured region with an edge leaving it',
  unstructuredDispatchNotRecovered: 'a block of an unstructured region whose '
    + 'two-way terminator carries no recoverable predicate',
  tryWithoutAHandler: 'a `{r:\'try\'}` with neither a handler nor a finalizer region',
  switchCaseWithoutALabel: 'a `{r:\'switch\'}` case with neither a Test nor a caseValue',
  litKind: 'a `{e:\'lit\'}` carrying a value outside 11.1\'s list',
  exprTooDeepForTheEmitter: 'the conversion depth guard fired',
  closureWithoutAUnit: 'a `{e:\'fn\'}` naming an SFI this file does not carry',
  classWithoutAUnit: 'a `{e:\'class\'}` naming an SFI this file does not carry',
  accessorWithoutABody: 'an object accessor whose function unit could not be emitted',
  unknownPredicate: 'a `Test.predicate` outside src/structure/facts.mjs\'s set',
  unknownRegionKind: 'a Region kind outside 11.2 plus docs/STRUCTURE.md 9',
  noValue: 'a null/undefined where an Expr was required',
});

export const HOLE_IDENTIFIER = '__hole';

/** Attach a block comment that cannot be mistaken for recovered source. */
export function mark(node, text, position = 'leading') {
  return t.addComment(node, position, ` ${text} `, false);
}

function describe(why, detail, dump) {
  const bits = [String(why)];
  if (detail !== null && detail !== undefined && detail !== '') bits.push(String(detail));
  if (dump) bits.push(String(dump));
  return bits.join(' ').replace(/\*\//g, '* /').replace(/\s+/g, ' ').slice(0, MAX_HOLE_COMMENT);
}

/**
 * An expression-position hole.
 * @param {object} ctx the per-function emit context
 */
export function holeExpr(ctx, why, detail = null, dump = null) {
  ctx.countHole(why, 'expr');
  ctx.needHoleIdentifier();
  return mark(t.identifier(HOLE_IDENTIFIER), `HOLE ${describe(why, detail, dump)}`);
}

/** A statement-position hole. */
export function holeStmt(ctx, why, detail = null, dump = null) {
  ctx.countHole(why, 'stmt');
  ctx.needHoleIdentifier();
  const s = t.expressionStatement(t.identifier(HOLE_IDENTIFIER));
  return mark(s, `HOLE STATEMENT ${describe(why, detail, dump)}`);
}

/** A comment-only statement, for things that must be seen but not executed. */
export function noteStmt(text) {
  return mark(t.emptyStatement(), text);
}

export default { holeExpr, holeStmt, noteStmt, mark, EMIT_HOLE_WHY, HOLE_IDENTIFIER };
