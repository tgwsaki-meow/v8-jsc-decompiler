import fs from 'fs';
import path from 'path';
import { JSCDeserializer } from '../src/deserializer.js';
import { V8Profile } from '../src/profile.js';
import { Lifter } from '../src/lifter.js';
import { DataflowAnalyzer } from '../src/dataflow.js';
import { Relooper } from '../src/relooper.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const lifter = new Lifter(profile);

const res = deserializer.deserializeFile('./extracted_jsc/r_96064.jsc');
console.log('Total functions in r_96064:', res.functions.length);

for (let i = 0; i < res.functions.length; i++) {
  const fn = res.functions[i];
  const t0 = Date.now();
  const insts = lifter.disassemble(fn.bytecode.subarray(4), res.strings);
  const blocks = lifter.buildCFG(insts);
  const analyzer = new DataflowAnalyzer(res.strings);
  const relooper = new Relooper();
  const relooperBlocks = new Map();
  const blockAnalyses = new Map();

  for (const b of blocks) {
    const analysis = analyzer.analyzeBlock(b);
    blockAnalyses.set(b.id, analysis);
    const rBlock = relooper.addBlock(b.id, analysis.statements);
    relooperBlocks.set(b.id, rBlock);
  }

  for (const b of blocks) {
    const rBlock = relooperBlocks.get(b.id);
    const analysis = blockAnalyses.get(b.id);
    const condExpr = analysis?.exitCondition;

    if (b.branchTarget) {
      const targetBlock = relooperBlocks.get(b.branchTarget.id);
      if (targetBlock) rBlock.addBranch(targetBlock, condExpr);
    }
    if (b.fallthroughTarget) {
      const targetBlock = relooperBlocks.get(b.fallthroughTarget.id);
      if (targetBlock) rBlock.addBranch(targetBlock, null);
    }
  }

  const entryBlock = relooperBlocks.get(0);
  const stmts = relooper.structure(entryBlock);
  const el = Date.now() - t0;
  if (el > 50 || i < 5) {
    console.log(`Function ${i}: blocks=${blocks.length}, insts=${insts.length}, time=${el}ms`);
  }
}
