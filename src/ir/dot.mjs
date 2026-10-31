// src/ir/dot.mjs
//
// Graphviz output, so a CFG can be looked at instead of read.
//
//   node src/cli/dump-ir.mjs f.jsc --function 3 --dot > f.dot
//   dot -Tsvg f.dot -o f.svg
//
// Edge styling carries the kind: solid black unconditional/fallthrough, green
// `true`, red `false`, blue switch (labelled with the case value), dashed
// orange exception (labelled with the catch prediction). Back edges are drawn
// with constraint=false so the loop body stays laid out top to bottom.

const ESC = (s) => String(s).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\l');

// Graphviz X11 colour names rather than hex, so the hygiene grep in
// tools/ir/selftest.mjs (which bans hex literals and long decimal literals
// anywhere in src/ir/) does not have to carve out an exception for a palette.
const EDGE_STYLE = {
  unconditional: 'color=gray20',
  fallthrough: 'color=gray50',
  true: 'color=forestgreen label="T"',
  false: 'color=firebrick label="F"',
  switch: 'color=royalblue',
  exception: 'color=chocolate style=dashed',
};

const BLOCK_FILL = {
  normal: 'white',
  loopHeader: 'cornsilk',
  handler: 'mistyrose',
  switchDispatch: 'aliceblue',
};

export function toDot(ir, opts = {}) {
  const { blocks, edges, loopInfo, dominators: dom } = ir;
  const showInstructions = opts.instructions !== false;
  const maxIns = opts.maxInstructions ?? 24;
  const L = [];
  const name = ir.unit.name || `bytecode#${ir.unit.bytecodeId}`;
  L.push(`digraph "${ESC(name)}" {`);
  L.push('  graph [fontname="Consolas" labelloc=t];');
  L.push('  node  [shape=box fontname="Consolas" fontsize=9 style="filled,rounded"];');
  L.push('  edge  [fontname="Consolas" fontsize=8];');
  L.push(`  label="${ESC(name)}  ${blocks.length} blocks, ${edges.length} edges, `
    + `${ir.loops.length} loops, ${ir.phis.length} phis";`);

  const backEdge = new Set(loopInfo.backEdges);
  for (const b of blocks) {
    const head = [`B${b.id} @${b.startOffset}`];
    if (b.kinds.length) head.push(`[${b.kinds.join(',')}]`);
    if (b.loop >= 0) head.push(`loop${b.loop}/d${b.loopDepth}`);
    if (!b.reachable) head.push('UNREACHABLE');
    const lines = [head.join(' ')];
    lines.push(`idom=${b.idom >= 0 ? 'B' + b.idom : '-'} ipdom=${b.ipdom === ir.exit ? 'EXIT' : 'B' + b.ipdom}`);
    for (const p of b.phis) {
      const v = ir.values[p];
      lines.push(`  v${p} = phi ${v.varName} (${v.operands.map((o) => (o === null ? '?' : 'v' + o)).join(', ')})`);
    }
    if (b.caughtException !== null) lines.push(`  v${b.caughtException} = CaughtException`);
    if (showInstructions) {
      const all = b.instructions;
      const show = all.length > maxIns ? all.slice(0, maxIns) : all;
      for (const ins of show) {
        const v = ir.values[ir.instructionValue[ins.index]];
        const cs = v?.contextSlot;
        const annot = cs ? `  ; ${cs.resolved ? cs.name : `[${cs.why}]`}` : '';
        lines.push(`  ${ins.offset} ${ins.opcode}${v?.hasEffect ? ' !' : ''}${v?.allocatesIdentity ? ' *' : ''}${annot}`);
      }
      if (all.length > show.length) lines.push(`  ... ${all.length - show.length} more`);
    }
    const fill = BLOCK_FILL[b.kind] ?? 'white';
    L.push(`  B${b.id} [fillcolor=${fill} label="${ESC(lines.join('\n'))}"];`);
  }
  L.push('  EXIT [shape=doublecircle fillcolor=gray90 label="EXIT"];');
  for (const p of ir.postDominators.exitPreds) L.push(`  B${p} -> EXIT [style=dotted color=gray60];`);

  for (const e of edges) {
    const style = EDGE_STYLE[e.kind] ?? '';
    const extra = [];
    if (e.kind === 'switch') extra.push(`label="case ${e.caseValue}"`);
    if (e.kind === 'exception') extra.push(`label="${ESC(e.prediction ?? 'throw')}"`);
    if (backEdge.has(e.id)) extra.push('constraint=false');
    L.push(`  B${e.from} -> B${e.to} [${[style, ...extra].filter(Boolean).join(' ')}];`);
  }
  if (opts.domTree) {
    L.push('  subgraph cluster_dom { label="dominator tree"; style=dotted;');
    for (const b of dom.rpo) if (dom.idom[b] !== b) L.push(`    D${dom.idom[b]} -> D${b};`);
    L.push('  }');
  }
  L.push('}');
  return L.join('\n') + '\n';
}

export default { toDot };
