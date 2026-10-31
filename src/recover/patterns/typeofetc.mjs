// src/recover/patterns/typeofetc.mjs
//
// `typeof`, `delete`, `in`, `instanceof`, `void`, and the nil comparisons.
//
// Inverts (src/interpreter/bytecode-generator.cc @ 14.4.258.16):
//   VisitTypeOf            :7242   VisitForTypeOfValue  :7230
//   VisitDelete            :7301
//   VisitUnaryOperation    :7274   VisitVoid            :7225
//   VisitCompareOperation  :7717
//   BuildLiteralCompareNil :7623   BuildLiteralStrictCompareBoolean :7645
//
// Each of these is ONE opcode, so expr.mjs transcribes them directly and there
// is no subgraph to match. This family exists for two reasons that are not
// cosmetic:
//
//  1. `TestTypeOf` carries a `kFlag8` whose meaning is an enum
//     (`TestTypeOfFlags::LiteralFlag`) that profiles/<tag>/*.json does not
//     export -- see src/recover/flags.mjs and docs/RECOVER.md's gap list. The
//     claim records which literal was decoded so a wrong table shows up as a
//     wrong claim rather than as a wrong string in the output.
//  2. `typeof x` where `x` is a free variable is `LdaGlobalInsideTypeof`, not
//     `LdaGlobal`: VisitForTypeOfValue uses the InsideTypeof form precisely so
//     the load does not throw a ReferenceError. Recording that distinction is
//     what lets T9 emit `typeof x === 'undefined'` for an undeclared `x`
//     instead of a load that would throw.

export function run(pc) {
  const ir = pc.ir;
  for (const v of ir.values) {
    if (v?.kind !== 'Op') continue;
    switch (v.op) {
      case 'TestTypeOf': {
        const e = pc.exprOf(v.id);
        const lit = e?.e === 'bin' && e.r?.e === 'lit' ? e.r.v : null;
        pc.claim({
          kind: 'typeof', blocks: [v.block], values: [v.id], instructions: [],
          confidence: lit === null ? 'shape' : 'exact',
          // VisitCompareOperation:7721 asks IsLiteralCompareTypeof:7671 and
          // emits CompareTypeOf(flag):7729 -- there is no
          // BuildLiteralCompareTypeof method in this version, the fold is
          // inline in the visitor.
          cites: ['VisitTypeOf:7242', 'VisitCompareOperation:7721', 'IsLiteralCompareTypeof:7671'],
          detail: lit === null ? 'TestTypeOfFlags::LiteralFlag out of range' : `typeof === '${lit}'`,
        });
        break;
      }
      case 'TypeOf':
        pc.claim({
          kind: 'typeof', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['VisitTypeOf:7242'], detail: 'TypeOf',
        });
        break;
      case 'LdaGlobalInsideTypeof':
      case 'LdaLookupGlobalSlotInsideTypeof':
      case 'LdaLookupContextSlotInsideTypeof':
      case 'LdaLookupContextSlotNoCellInsideTypeof':
        pc.claim({
          kind: 'typeof', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['VisitForTypeOfValue:7230'],
          detail: 'a free variable loaded inside typeof, so the load cannot throw',
        });
        break;
      case 'DeletePropertyStrict':
      case 'DeletePropertySloppy':
        pc.claim({
          kind: 'delete', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['VisitDelete:7301'],
          detail: v.op === 'DeletePropertyStrict' ? 'strict mode' : 'sloppy mode',
        });
        break;
      case 'TestIn':
        pc.claim({
          kind: 'in', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['VisitCompareOperation:7717'], detail: null,
        });
        break;
      case 'TestInstanceOf':
        pc.claim({
          kind: 'instanceof', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['VisitCompareOperation:7717'], detail: null,
        });
        break;
      case 'TestNull':
      case 'TestUndefined':
      case 'TestUndetectable':
        pc.claim({
          kind: 'compareNil', blocks: [v.block], values: [v.id], instructions: [],
          confidence: 'exact', cites: ['BuildLiteralCompareNil:7623'], detail: v.op,
        });
        break;
      default: break;
    }
  }
}

export default { name: 'typeofetc', run };
