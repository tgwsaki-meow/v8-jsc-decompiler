#!/usr/bin/env node
/**
 * Standalone Strict V8 14.4 Bytecode Decompiler
 * Strictly equivalent to V8 Ignition runtime semantics.
 * Fail-fast on any invalid state or missing opcode.
 */

import fs from 'fs';
import path from 'path';
import generateModule from '@babel/generator';
const generate = generateModule.default || generateModule;
import * as t from '@babel/types';

import { V8Profile } from './profile.js';
import { JSCDeserializer } from './deserializer.js';
import { Lifter } from './lifter.js';
import { DataflowAnalyzer } from './dataflow.js';
import { Relooper } from './relooper.js';

export class V8Decompiler {
  constructor(profilePath) {
    this.profile = new V8Profile(profilePath);
    this.deserializer = new JSCDeserializer(this.profile);
    this.lifter = new Lifter(this.profile);
    this.functionsById = new Map();
    this.fnCache = new Map();
  }

  decompileFunctionById(bytecodeId) {
    if (this.fnCache.has(bytecodeId)) {
      return this.fnCache.get(bytecodeId);
    }
    const fnObj = this.functionsById.get(bytecodeId);
    if (!fnObj) return null;
    const decl = this.decompileFunction(fnObj, fnObj.constants, fnObj.index);
    if (decl) {
      this.fnCache.set(bytecodeId, decl);
    }
    return decl;
  }

  decompileFunction(fnObj, constants, fnIndex = 0) {
    const insts = this.lifter.disassemble(fnObj.bytecode, constants);
    const blocks = this.lifter.buildCFG(insts, fnObj.handlers || []);
    if (blocks.length === 0) return null;

    const analyzer = new DataflowAnalyzer(constants, this.functionsById, this, this.profile);
    const relooper = new Relooper();
    const relooperBlocks = new Map();
    const blockAnalyses = new Map();
    const blockStates = new Map();
    blockStates.set(0, { acc: null, regs: new Map() });

    // Initialize catch handler blocks with caught error in accumulator
    const catchOffsets = new Set((fnObj.handlers || []).map(h => h.handlerOffset));
    for (const b of blocks) {
      if (catchOffsets.has(b.startOffset)) {
        blockStates.set(b.id, { acc: t.identifier('__caughtErr'), regs: new Map() });
      }
    }

    for (const b of blocks) {
      const state = blockStates.get(b.id) || { acc: null, regs: new Map() };
      const analysis = analyzer.analyzeBlock(b, state.acc, state.regs);
      blockAnalyses.set(b.id, analysis);

      // Propagate state to successors
      for (const succ of b.successors) {
        if (!blockStates.has(succ.id)) {
          blockStates.set(succ.id, { acc: analysis.exitAcc, regs: analysis.regs });
        }
      }
    }

    // Build Relooper blocks
    for (const b of blocks) {
      const analysis = blockAnalyses.get(b.id);
      const rBlock = relooper.addBlock(b.id, analysis.statements);
      relooperBlocks.set(b.id, rBlock);
    }

    // Connect branches strictly
    for (const b of blocks) {
      const rBlock = relooperBlocks.get(b.id);
      if (!rBlock) continue;
      const analysis = blockAnalyses.get(b.id);

      if (b.branchTarget) {
        const targetBlock = relooperBlocks.get(b.branchTarget.id);
        if (targetBlock) {
          if (!analysis.exitCondition) {
            throw new Error(`[V8Decompiler] MissingExitConditionError: Block ${b.id} at 0x${b.startOffset.toString(16)} branches to ${b.branchTarget.id} but produced no condition`);
          }
          rBlock.addBranch(targetBlock, analysis.exitCondition);
        }
      }
      if (b.fallthroughTarget) {
        const targetBlock = relooperBlocks.get(b.fallthroughTarget.id);
        if (targetBlock) {
          rBlock.addBranch(targetBlock, null);
        }
      } else if (b.successors.length === 1 && !b.branchTarget) {
        const targetBlock = relooperBlocks.get(b.successors[0].id);
        if (targetBlock) {
          rBlock.addBranch(targetBlock, null);
        }
      }
    }

    const entryBlock = relooperBlocks.get(0);
    const stmts = relooper.structure(entryBlock);

    // Strip redundant trailing return from function root body
    if (stmts.length > 0) {
      const lastStmt = stmts[stmts.length - 1];
      if (t.isReturnStatement(lastStmt) && (lastStmt.argument === null || t.isIdentifier(lastStmt.argument, { name: 'undefined' }))) {
        stmts.pop();
      }
    }

    // Build function params strictly from BytecodeArray parameterCount
    const params = [];
    const jsParamCount = fnObj.parameterCount !== undefined
      ? fnObj.parameterCount
      : Math.max(0, (fnObj.parameterSize || 1) - 1);
    for (let p = 0; p < jsParamCount; p++) {
      params.push(t.identifier(`a${p}`));
    }

    const isGenerator = insts.some(i => i.name === 'SuspendGenerator' || i.name === 'ResumeGenerator');
    const fnName = fnIndex === 0 ? 'main' : `func_${fnIndex}`;
    return t.functionDeclaration(
      t.identifier(fnName),
      params,
      t.blockStatement(stmts),
      isGenerator,
      false
    );
  }

  decompileFile(filePath) {
    this.fnCache.clear();
    const res = this.deserializer.deserializeFile(filePath);
    this.functionsById.clear();
    for (const fn of res.functions) {
      this.functionsById.set(fn.id, fn);
    }

    const chunks = [];
    chunks.push(`"[Decompiled from: ${path.basename(filePath)} | VersionHash: ${res.header.versionHash}]";`);

    if (res.functions.length > 0) {
      // 1. Decompile entrypoint function (main / function 0)
      const mainFn = res.functions[0];
      const mainDecl = this.decompileFunction(mainFn, mainFn.constants, 0);
      if (mainDecl) {
        this.fnCache.set(mainFn.id, mainDecl);
        chunks.push(generate(mainDecl, {
          comments: false,
          retainLines: false,
          compact: false
        }).code);
      }

      // 2. Only emit orphaned functions that were not referenced/inlined into closures
      for (let idx = 1; idx < res.functions.length; idx++) {
        const fn = res.functions[idx];
        if (!this.fnCache.has(fn.id)) {
          const fnDecl = this.decompileFunction(fn, fn.constants, idx);
          if (fnDecl) {
            this.fnCache.set(fn.id, fnDecl);
            chunks.push(generate(fnDecl, {
              comments: false,
              retainLines: false,
              compact: false
            }).code);
          }
        }
      }
    }

    return {
      code: chunks.join('\n\n'),
      header: res.header,
      totalFunctions: res.functions.length
    };
  }
}

// CLI entrypoint if run directly
if (process.argv[1] && process.argv[1].endsWith('decompiler.js')) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const filePath = args[0];
    const decompiler = new V8Decompiler();
    console.log(`Decompiling ${filePath}...`);
    const result = decompiler.decompileFile(filePath);
    console.log('\n================ DECOMPILED JAVASCRIPT ================\n');
    console.log(result.code);
    console.log('\n=======================================================\n');
  }
}
