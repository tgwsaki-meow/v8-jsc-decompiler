import fs from 'fs';
import path from 'path';
import * as t from '@babel/types';
import generateModule from '@babel/generator';
const generate = generateModule.default || generateModule;

import { V8Profile } from '../src/profile.js';
import { JSCDeserializer } from '../src/deserializer.js';
import { Lifter } from '../src/lifter.js';
import { Relooper } from '../src/relooper.js';

const profile = new V8Profile('./rules/v8-14.4.258.16.json');
const deserializer = new JSCDeserializer(profile);
const lifter = new Lifter(profile);

// 1. Correct register decoder
lifter.decodeRegister = function(operand) {
  let signedVal = operand;
  if (signedVal >= 128) signedVal -= 256;

  if (signedVal <= -7) {
    return `r${-7 - signedVal}`;
  }
  if (signedVal === 2) return 'this';
  if (signedVal >= 3) return `arg${signedVal - 3}`;
  if (signedVal === -1) return '<context>';
  if (signedVal === -2) return '<closure>';
  return `reg_${signedVal}`;
};

// 2. Comprehensive Dataflow Analyzer
class EnhancedDataflowAnalyzer {
  constructor(constants = []) {
    this.constants = constants;
  }

  getConstant(idx, fallbackName = 'unknown') {
    if (this.constants && idx < this.constants.length) {
      const val = this.constants[idx];
      if (typeof val === 'string') return val;
      return String(val);
    }
    return `${fallbackName}_${idx}`;
  }

  createMember(objNode, propName) {
    const clonedObj = t.cloneNode(objNode);
    if (t.isValidIdentifier(propName)) {
      return t.memberExpression(clonedObj, t.identifier(propName), false);
    } else {
      return t.memberExpression(clonedObj, t.stringLiteral(propName), true);
    }
  }

  createId(name) {
    if (t.isValidIdentifier(name)) return t.identifier(name);
    const sanitized = name.replace(/[^a-zA-Z0-9_$]/g, '_');
    if (/^[0-9]/.test(sanitized) || !t.isValidIdentifier(sanitized)) {
      return t.identifier(`_${sanitized}`);
    }
    return t.identifier(sanitized);
  }

  analyzeBlock(block) {
    let acc = t.identifier('undefined');
    const regs = new Map();
    const statements = [];
    let exitCondition = null;

    const getReg = (name) => {
      if (regs.has(name)) return t.cloneNode(regs.get(name));
      return this.createId(name);
    };

    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i];
      const name = inst.name;
      const ops = inst.operandsRaw;
      const opsDec = inst.operandsDecoded;

      switch (name) {
        case 'LdaGlobal': {
          const propName = this.getConstant(ops[0], 'global');
          acc = this.createId(propName === 'global' ? 'globalThis' : propName);
          break;
        }

        case 'LdaConstant': {
          const val = this.constants[ops[0]] ?? null;
          if (typeof val === 'string') acc = t.stringLiteral(val);
          else if (typeof val === 'number') acc = t.numericLiteral(val);
          else if (val === null) acc = t.nullLiteral();
          else acc = t.stringLiteral(String(val));
          break;
        }

        case 'LdaSmi':
          acc = t.numericLiteral(ops[0]);
          break;

        case 'LdaZero':
          acc = t.numericLiteral(0);
          break;

        case 'LdaUndefined':
          acc = t.identifier('undefined');
          break;

        case 'LdaNull':
          acc = t.nullLiteral();
          break;

        case 'LdaTrue':
          acc = t.booleanLiteral(true);
          break;

        case 'LdaFalse':
          acc = t.booleanLiteral(false);
          break;

        case 'Ldar':
          acc = getReg(opsDec[0]);
          break;

        case 'Star':
          regs.set(opsDec[0], t.cloneNode(acc));
          break;

        case 'Star0': case 'Star1': case 'Star2': case 'Star3':
        case 'Star4': case 'Star5': case 'Star6': case 'Star7':
        case 'Star8': case 'Star9': case 'Star10': case 'Star11':
        case 'Star12': case 'Star13': case 'Star14': case 'Star15': {
          const regName = `r${name.slice(4)}`;
          regs.set(regName, t.cloneNode(acc));
          break;
        }

        case 'Mov': {
          const src = opsDec[0];
          const dst = opsDec[1];
          regs.set(dst, getReg(src));
          break;
        }

        case 'LdaImmutableCurrentContextSlot':
        case 'LdaCurrentContextSlotNoCell':
        case 'LdaCurrentContextSlot': {
          acc = t.memberExpression(t.identifier('ctx'), t.identifier(`slot_${ops[0]}`));
          break;
        }

        case 'LdaImmutableContextSlot':
        case 'LdaContextSlot': {
          acc = t.memberExpression(t.identifier(`ctx_d${ops[1]}`), t.identifier(`slot_${ops[0]}`));
          break;
        }

        case 'StaCurrentContextSlotNoCell':
        case 'StaCurrentContextSlot': {
          const target = t.memberExpression(t.identifier('ctx'), t.identifier(`slot_${ops[0]}`));
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, t.cloneNode(acc))));
          break;
        }

        case 'StaContextSlot': {
          const target = t.memberExpression(t.identifier(`ctx_d${ops[1]}`), t.identifier(`slot_${ops[0]}`));
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, t.cloneNode(acc))));
          break;
        }

        case 'GetNamedProperty':
        case 'LdaNamedProperty': {
          const objNode = getReg(opsDec[0]);
          const propName = this.getConstant(ops[1], 'prop');
          acc = this.createMember(objNode, propName);
          break;
        }

        case 'SetNamedProperty':
        case 'StaNamedProperty':
        case 'DefineNamedOwnProperty': {
          const objNode = getReg(opsDec[0]);
          const propName = this.getConstant(ops[1], 'prop');
          const assignExpr = t.assignmentExpression('=', this.createMember(objNode, propName), t.cloneNode(acc));
          statements.push(t.expressionStatement(assignExpr));
          break;
        }

        case 'GetKeyedProperty':
        case 'LdaKeyedProperty': {
          const objNode = getReg(opsDec[0]);
          acc = t.memberExpression(objNode, t.cloneNode(acc), true);
          break;
        }

        case 'SetKeyedProperty':
        case 'StaKeyedProperty': {
          const objNode = getReg(opsDec[0]);
          const keyNode = getReg(opsDec[1]);
          const assignExpr = t.assignmentExpression('=', t.memberExpression(objNode, keyNode, true), t.cloneNode(acc));
          statements.push(t.expressionStatement(assignExpr));
          break;
        }

        case 'CallUndefinedReceiver':
        case 'CallUndefinedReceiver0':
        case 'CallUndefinedReceiver1':
        case 'CallUndefinedReceiver2': {
          const callee = getReg(opsDec[0]);
          const args = [];
          if (name === 'CallUndefinedReceiver1') {
            args.push(getReg(opsDec[1]));
          } else if (name === 'CallUndefinedReceiver2') {
            args.push(getReg(opsDec[1]));
            args.push(getReg(opsDec[2]));
          }
          acc = t.callExpression(t.cloneNode(callee), args);
          statements.push(t.expressionStatement(acc));
          break;
        }

        case 'CallProperty':
        case 'CallProperty0':
        case 'CallProperty1':
        case 'CallProperty2': {
          const callee = getReg(opsDec[0]);
          const args = [];
          if (name === 'CallProperty1') {
            args.push(getReg(opsDec[2]));
          } else if (name === 'CallProperty2') {
            args.push(getReg(opsDec[2]));
            args.push(getReg(opsDec[3]));
          }
          acc = t.callExpression(t.cloneNode(callee), args);
          statements.push(t.expressionStatement(acc));
          break;
        }

        case 'Construct':
        case 'ConstructWithSpread': {
          const callee = getReg(opsDec[0]);
          acc = t.newExpression(t.cloneNode(callee), []);
          statements.push(t.expressionStatement(acc));
          break;
        }

        case 'Throw': {
          statements.push(t.throwStatement(t.cloneNode(acc)));
          break;
        }

        case 'TestEqualStrict': {
          const other = getReg(opsDec[0]);
          acc = t.binaryExpression('===', t.cloneNode(acc), other);
          break;
        }

        case 'TestEqual': {
          const other = getReg(opsDec[0]);
          acc = t.binaryExpression('==', t.cloneNode(acc), other);
          break;
        }

        case 'TestReferenceEqual': {
          const other = getReg(opsDec[0]);
          acc = t.binaryExpression('===', t.cloneNode(acc), other);
          break;
        }

        case 'JumpIfToBooleanTrue':
        case 'JumpIfTrue': {
          exitCondition = t.cloneNode(acc);
          break;
        }

        case 'JumpIfToBooleanFalse':
        case 'JumpIfFalse': {
          exitCondition = t.unaryExpression('!', t.cloneNode(acc));
          break;
        }

        case 'JumpIfNull': {
          exitCondition = t.binaryExpression('===', t.cloneNode(acc), t.nullLiteral());
          break;
        }

        case 'JumpIfNotNull': {
          exitCondition = t.binaryExpression('!==', t.cloneNode(acc), t.nullLiteral());
          break;
        }

        case 'JumpIfUndefined': {
          exitCondition = t.binaryExpression('===', t.cloneNode(acc), t.identifier('undefined'));
          break;
        }

        case 'JumpIfNotUndefined': {
          exitCondition = t.binaryExpression('!==', t.cloneNode(acc), t.identifier('undefined'));
          break;
        }

        case 'CreateClosure': {
          acc = t.functionExpression(null, [], t.blockStatement([]));
          break;
        }

        case 'CreateEmptyArrayLiteral':
        case 'CreateArrayLiteral':
          acc = t.arrayExpression([]);
          break;

        case 'CreateEmptyObjectLiteral':
        case 'CreateObjectLiteral':
          acc = t.objectExpression([]);
          break;

        case 'Return': {
          if (!t.isIdentifier(acc, { name: 'undefined' })) {
            statements.push(t.returnStatement(t.cloneNode(acc)));
          }
          break;
        }

        default:
          break;
      }
    }

    return { statements, exitAcc: acc, exitCondition, regs };
  }
}

// 3. Test on functions 2 to 6
const res = deserializer.deserializeFile('./extracted_jsc/p_preload_chatwin.jsc');

for (let fnIndex = 2; fnIndex <= 6; fnIndex++) {
  const fnObj = res.functions[fnIndex];
  // subarray(4) for the +12 header offset
  const insts = lifter.disassemble(fnObj.bytecode.subarray(4), res.strings);
  const blocks = lifter.buildCFG(insts);

  const analyzer = new EnhancedDataflowAnalyzer(res.strings);
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
    const condExpr = analysis?.exitCondition || t.identifier('condition');

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

  const params = [];
  for (let p = 0; p < (fnObj.paramSize || 0); p++) {
    params.push(t.identifier(`arg${p}`));
  }

  const fnDecl = t.functionDeclaration(
    t.identifier(`func_${fnIndex}`),
    params,
    t.blockStatement(stmts)
  );

  const code = generate(fnDecl).code;
  console.log(`\n================ RECONSTRUCTED func_${fnIndex} ================`);
  console.log(code);
}
