import * as t from '@babel/types';
import { V8Profile } from './profile.js';

export class DataflowAnalyzer {
  constructor(constants = [], functionsById = new Map(), decompiler = null, profile = null) {
    this.constants = constants;
    this.functionsById = functionsById;
    this.decompiler = decompiler;
    this.profile = profile || decompiler?.profile || new V8Profile();
  }

  resolveReadOnlyHeapRef(ref) {
    const key = `${ref.chunkIndex}:${ref.chunkOffset}`;
    const fromProfile = this.profile?.getReadOnlyRef(ref.chunkIndex, ref.chunkOffset);
    if (fromProfile !== null && fromProfile !== undefined) {
      return fromProfile;
    }
    throw new Error(`[DataflowAnalyzer] UnknownReadOnlyHeapRefError: ReadOnlyHeapRef ${key} is unmapped. No heuristic fallback allowed.`);
  }

  getConstant(idx, contextDesc = 'constant') {
    if (idx < 0 || idx >= this.constants.length) {
      throw new Error(`[DataflowAnalyzer] ConstantPoolOutOfBoundsError: index ${idx} >= pool size ${this.constants.length} while resolving ${contextDesc}`);
    }
    const val = this.constants[idx];
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object' && val.type === 'ReadOnlyHeapRef') {
      return this.resolveReadOnlyHeapRef(val);
    }
    if (val && typeof val === 'object' && (val.type === 'RootArray' || val.type === 'RootArrayConstant')) {
      const rootIdx = val.type === 'RootArray' ? val.id : val.rootIndex;
      const rootEntry = this.profile?.getRoot(rootIdx);
      if (rootEntry) {
        if (rootEntry.type === 'string') return rootEntry.value;
        if (rootEntry.type === 'literal') return rootEntry.value;
        if (rootEntry.type === 'symbol') return rootEntry.value;
        if (rootEntry.type === 'identifier') return rootEntry.value;
      }
    }
    if (typeof val === 'boolean' || typeof val === 'number' || val === null || val === undefined) {
      return val;
    }
    throw new Error(`[DataflowAnalyzer] InvalidPropertyConstantError: Constant at index ${idx} for ${contextDesc} is not a valid string or ReadOnlyHeapRef: ${JSON.stringify(val)}`);
  }

  createNumberLiteral(val) {
    if (Number.isNaN(val)) return t.identifier('NaN');
    if (val === Infinity) return t.identifier('Infinity');
    if (val === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
    if (Object.is(val, -0)) return t.unaryExpression('-', t.numericLiteral(0));
    if (val < 0) return t.unaryExpression('-', t.numericLiteral(-val));
    return t.numericLiteral(val);
  }

  toASTLiteral(val) {
    if (val === undefined) return t.identifier('undefined');
    if (val === null) return t.nullLiteral();
    if (val === true) return t.booleanLiteral(true);
    if (val === false) return t.booleanLiteral(false);
    if (typeof val === 'number') return this.createNumberLiteral(val);
    if (typeof val === 'string') return t.stringLiteral(val);
    if (val === '__the_hole__') return t.identifier('__the_hole__');
    if (typeof val === 'object' && val !== null) {
      if (val.type === 'FunctionRef') {
        return this.resolveFunctionRef(val);
      }
      if (val.type === 'BytecodeArrayRef') {
        return t.identifier(`func_${val.id}`);
      }
      if (val.type === 'ReadOnlyHeapRef') {
        const resolved = this.resolveReadOnlyHeapRef(val);
        return t.stringLiteral(resolved);
      }
      if (val.type === 'HeapObjectRef') {
        return t.identifier(`__obj_${val.id}`);
      }
      if (val.type === 'RootArray' || val.type === 'RootArrayConstant') {
        const rootIdx = val.type === 'RootArray' ? val.id : val.rootIndex;
        const rootEntry = this.profile?.getRoot(rootIdx);
        if (rootEntry) {
          if (rootEntry.type === 'string') return t.stringLiteral(rootEntry.value);
          if (rootEntry.type === 'literal') {
            if (rootEntry.value === null) return t.nullLiteral();
            if (typeof rootEntry.value === 'boolean') return t.booleanLiteral(rootEntry.value);
            if (typeof rootEntry.value === 'number') return this.createNumberLiteral(rootEntry.value);
          }
          if (rootEntry.type === 'identifier') return this.createIdentifier(rootEntry.value);
          if (rootEntry.type === 'symbol') return this.createIdentifier(`Symbol_${rootEntry.value}`);
          if (rootEntry.type === 'map') return this.createIdentifier(rootEntry.value);
        }
      }
    }
    throw new Error(`[DataflowAnalyzer] UnhandledConstantLiteralError: Cannot convert constant to AST literal: ${JSON.stringify(val)}`);
  }

  resolveFunctionRef(fnRef) {
    if (this.decompiler) {
      const innerDecl = this.decompiler.decompileFunctionById(fnRef.bytecodeId);
      if (innerDecl) {
        return t.functionExpression(
          innerDecl.id,
          innerDecl.params,
          innerDecl.body,
          innerDecl.generator || false,
          innerDecl.async || false
        );
      }
    }
    return t.identifier(`func_${fnRef.bytecodeId}`);
  }

  decodeRegExpFlags(flagMask = 0) {
    let flags = '';
    if (flagMask & (1 << 0)) flags += 'g';
    if (flagMask & (1 << 1)) flags += 'i';
    if (flagMask & (1 << 2)) flags += 'm';
    if (flagMask & (1 << 5)) flags += 's';
    if (flagMask & (1 << 4)) flags += 'u';
    if (flagMask & (1 << 8)) flags += 'v';
    if (flagMask & (1 << 3)) flags += 'y';
    if (flagMask & (1 << 7)) flags += 'd';
    return flags;
  }

  createMember(objNode, propName) {
    const clonedObj = t.cloneNode(objNode);
    if (typeof propName === 'string') {
      if (t.isValidIdentifier(propName)) {
        return t.memberExpression(clonedObj, t.identifier(propName), false);
      } else {
        return t.memberExpression(clonedObj, t.stringLiteral(propName), true);
      }
    }
    if (typeof propName === 'boolean') {
      return t.memberExpression(clonedObj, t.booleanLiteral(propName), true);
    }
    if (typeof propName === 'number') {
      return t.memberExpression(clonedObj, this.createNumberLiteral(propName), true);
    }
    if (propName === null) {
      return t.memberExpression(clonedObj, t.nullLiteral(), true);
    }
    if (propName === undefined) {
      return t.memberExpression(clonedObj, t.identifier('undefined'), true);
    }
    if (t.isExpression(propName)) {
      return t.memberExpression(clonedObj, propName, true);
    }
    throw new Error(`[DataflowAnalyzer] InvalidMemberPropertyError: Property ${JSON.stringify(propName)} cannot be converted to member expression`);
  }

  createIdentifier(name) {
    if (name === null || name === undefined) {
      throw new Error(`[DataflowAnalyzer] NullIdentifierError: cannot create identifier from null or undefined`);
    }
    if (typeof name !== 'string') name = String(name);
    if (name === 'this') return t.thisExpression();
    if (!t.isValidIdentifier(name)) {
      throw new Error(`[DataflowAnalyzer] InvalidIdentifierError: '${name}' is not a valid ECMAScript identifier`);
    }
    return t.identifier(name);
  }

  getTypeofLiteral(flag) {
    const map = {
      0: 'number',
      1: 'string',
      2: 'symbol',
      3: 'boolean',
      4: 'bigint',
      5: 'undefined',
      6: 'function',
      7: 'object',
      8: 'other'
    };
    if (map[flag] === undefined) {
      throw new Error(`[DataflowAnalyzer] UnknownTypeofLiteralFlagError: TestTypeOf flag ${flag} is invalid`);
    }
    return map[flag];
  }

  analyzeBlock(block, initialAcc = null, initialRegs = new Map()) {
    let acc = initialAcc ? t.cloneNode(initialAcc) : null;
    const regs = new Map(initialRegs);
    const statements = [];
    let exitCondition = null;

    const readAcc = (inst) => {
      if (acc === null) {
        throw new Error(`[DataflowAnalyzer] UninitializedAccumulatorError: Instruction '${inst.name}' at 0x${inst.offset.toString(16)} read accumulator before write`);
      }
      return t.cloneNode(acc);
    };

    const writeAcc = (node) => {
      acc = node;
    };

    const readReg = (name, inst) => {
      if (name === 'this') return t.thisExpression();
      if (regs.has(name)) return t.cloneNode(regs.get(name));
      return this.createIdentifier(name);
    };

    const writeReg = (name, node) => {
      regs.set(name, t.cloneNode(node));
    };

    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i];
      const name = inst.name;
      const ops = inst.operandsRaw;
      const opsDec = inst.operandsDecoded;

      switch (name) {
        // --- 1. Load / Store Accumulator & Constants ---
        case 'LdaGlobal':
        case 'LdaGlobalInsideTypeof': {
          const propName = this.getConstant(ops[0], 'global');
          if (propName === 'global') {
            writeAcc(t.identifier('globalThis'));
          } else if (t.isValidIdentifier(propName)) {
            writeAcc(t.identifier(propName));
          } else {
            writeAcc(t.memberExpression(t.identifier('globalThis'), t.stringLiteral(propName), true));
          }
          break;
        }

        case 'StaGlobal': {
          const propName = this.getConstant(ops[0], 'global');
          const target = t.isValidIdentifier(propName) && propName !== 'global'
            ? t.identifier(propName)
            : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(propName), true);
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, readAcc(inst))));
          break;
        }

        case 'LdaLookupSlot':
        case 'LdaLookupContextSlotNoCell':
        case 'LdaLookupContextSlot':
        case 'LdaLookupGlobalSlot':
        case 'LdaLookupSlotInsideTypeof':
        case 'LdaLookupContextSlotNoCellInsideTypeof':
        case 'LdaLookupContextSlotInsideTypeof':
        case 'LdaLookupGlobalSlotInsideTypeof': {
          const propName = this.getConstant(ops[0], 'lookup');
          if (t.isValidIdentifier(propName)) {
            writeAcc(t.identifier(propName));
          } else {
            writeAcc(t.memberExpression(t.identifier('globalThis'), t.stringLiteral(propName), true));
          }
          break;
        }

        case 'StaLookupSlot': {
          const propName = this.getConstant(ops[0], 'lookup');
          const target = t.isValidIdentifier(propName)
            ? t.identifier(propName)
            : t.memberExpression(t.identifier('globalThis'), t.stringLiteral(propName), true);
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, readAcc(inst))));
          break;
        }

        case 'LdaConstant': {
          if (ops[0] >= this.constants.length) {
            throw new Error(`[DataflowAnalyzer] ConstantPoolOutOfBoundsError: index ${ops[0]} >= ${this.constants.length} at 0x${inst.offset.toString(16)}`);
          }
          const val = this.constants[ops[0]];
          writeAcc(this.toASTLiteral(val));
          break;
        }

        case 'LdaSmi': {
          writeAcc(this.createNumberLiteral(ops[0]));
          break;
        }

        case 'LdaZero': {
          writeAcc(t.numericLiteral(0));
          break;
        }

        case 'LdaTheHole': {
          writeAcc(t.identifier('__the_hole__'));
          break;
        }

        case 'LdaUndefined': {
          writeAcc(t.identifier('undefined'));
          break;
        }

        case 'LdaNull': {
          writeAcc(t.nullLiteral());
          break;
        }

        case 'LdaTrue': {
          writeAcc(t.booleanLiteral(true));
          break;
        }

        case 'LdaFalse': {
          writeAcc(t.booleanLiteral(false));
          break;
        }

        case 'Ldar': {
          writeAcc(readReg(opsDec[0], inst));
          break;
        }

        case 'Star':
        case 'Star0': case 'Star1': case 'Star2': case 'Star3':
        case 'Star4': case 'Star5': case 'Star6': case 'Star7':
        case 'Star8': case 'Star9': case 'Star10': case 'Star11':
        case 'Star12': case 'Star13': case 'Star14': case 'Star15': {
          const regName = name === 'Star' ? opsDec[0] : `r${name.slice(4)}`;
          const currentAcc = readAcc(inst);
          if (t.isCallExpression(currentAcc) || t.isNewExpression(currentAcc) || t.isBinaryExpression(currentAcc)) {
            const idNode = regName === 'this' ? t.identifier('_this') : this.createIdentifier(regName);
            statements.push(t.expressionStatement(t.assignmentExpression('=', idNode, t.cloneNode(currentAcc))));
            writeReg(regName, idNode);
            writeAcc(idNode);
          } else {
            writeReg(regName, currentAcc);
          }
          break;
        }

        case 'Mov': {
          const src = opsDec[0];
          const dst = opsDec[1];
          writeReg(dst, readReg(src, inst));
          break;
        }

        // --- 2. Context Operations ---
        case 'PushContext': {
          writeReg(opsDec[0], t.identifier('ctx'));
          break;
        }

        case 'PopContext': {
          break;
        }

        case 'CreateFunctionContext':
        case 'CreateFunctionContextWithCells':
        case 'CreateBlockContext':
        case 'CreateCatchContext':
        case 'CreateEvalContext':
        case 'CreateWithContext': {
          writeAcc(t.objectExpression([]));
          break;
        }

        case 'LdaImmutableCurrentContextSlot':
        case 'LdaCurrentContextSlotNoCell':
        case 'LdaCurrentContextSlot': {
          writeAcc(t.memberExpression(t.identifier('ctx'), t.identifier(`slot_${ops[0]}`)));
          break;
        }

        case 'LdaImmutableContextSlot':
        case 'LdaContextSlotNoCell':
        case 'LdaContextSlot': {
          const depth = ops[1] || 0;
          writeAcc(t.memberExpression(t.identifier(`ctx_d${depth}`), t.identifier(`slot_${ops[0]}`)));
          break;
        }

        case 'StaCurrentContextSlotNoCell':
        case 'StaCurrentContextSlot': {
          const target = t.memberExpression(t.identifier('ctx'), t.identifier(`slot_${ops[0]}`));
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, readAcc(inst))));
          break;
        }

        case 'StaContextSlotNoCell':
        case 'StaContextSlot': {
          const depth = ops[1] || 0;
          const target = t.memberExpression(t.identifier(`ctx_d${depth}`), t.identifier(`slot_${ops[0]}`));
          statements.push(t.expressionStatement(t.assignmentExpression('=', target, readAcc(inst))));
          break;
        }

        // --- 3. Property Accesses ---
        case 'GetNamedProperty':
        case 'LdaNamedProperty':
        case 'GetNamedPropertyFromSuper': {
          const objNode = readReg(opsDec[0], inst);
          const propName = this.getConstant(ops[1], 'property');
          writeAcc(this.createMember(objNode, propName));
          break;
        }

        case 'SetNamedProperty':
        case 'StaNamedProperty': {
          const objNode = readReg(opsDec[0], inst);
          const propName = this.getConstant(ops[1], 'property');
          const assignExpr = t.assignmentExpression('=', this.createMember(objNode, propName), readAcc(inst));
          statements.push(t.expressionStatement(assignExpr));
          break;
        }

        case 'DefineNamedOwnProperty': {
          const objReg = opsDec[0];
          const objNode = readReg(objReg, inst);
          const propName = this.getConstant(ops[1], 'property');
          const val = readAcc(inst);
          if (t.isObjectExpression(objNode)) {
            const keyNode = t.isValidIdentifier(propName) ? t.identifier(propName) : t.stringLiteral(propName);
            objNode.properties.push(t.objectProperty(keyNode, val));
            writeReg(objReg, objNode);
          } else {
            const assignExpr = t.assignmentExpression('=', this.createMember(objNode, propName), val);
            statements.push(t.expressionStatement(assignExpr));
          }
          break;
        }

        case 'GetKeyedProperty':
        case 'LdaKeyedProperty':
        case 'GetEnumeratedKeyedProperty': {
          const objNode = readReg(opsDec[0], inst);
          writeAcc(t.memberExpression(objNode, readAcc(inst), true));
          break;
        }

        case 'SetKeyedProperty':
        case 'StaKeyedProperty': {
          const objNode = readReg(opsDec[0], inst);
          const keyNode = readReg(opsDec[1], inst);
          const assignExpr = t.assignmentExpression('=', t.memberExpression(objNode, keyNode, true), readAcc(inst));
          statements.push(t.expressionStatement(assignExpr));
          break;
        }

        case 'DefineKeyedOwnProperty':
        case 'DefineKeyedOwnPropertyInLiteral': {
          const objReg = opsDec[0];
          const keyReg = opsDec[1];
          const objNode = readReg(objReg, inst);
          const keyNode = readReg(keyReg, inst);
          const val = readAcc(inst);
          if (t.isObjectExpression(objNode)) {
            const isComputed = !(t.isStringLiteral(keyNode) || t.isNumericLiteral(keyNode));
            objNode.properties.push(t.objectProperty(keyNode, val, isComputed));
            writeReg(objReg, objNode);
          } else {
            statements.push(t.expressionStatement(t.assignmentExpression('=', t.memberExpression(objNode, keyNode, true), val)));
          }
          break;
        }

        case 'DeletePropertySloppy':
        case 'DeletePropertyStrict': {
          const objNode = readReg(opsDec[0], inst);
          writeAcc(t.unaryExpression('delete', t.memberExpression(objNode, readAcc(inst), true)));
          break;
        }

        // --- 4. Object & Array Literals ---
        case 'CreateArrayLiteral': {
          const bp = this.constants[ops[0]];
          if (bp && typeof bp === 'object' && bp.type === 'ArrayBoilerplate') {
            writeAcc(t.arrayExpression(bp.elements.map(e => this.toASTLiteral(e))));
          } else {
            writeAcc(t.arrayExpression([]));
          }
          break;
        }

        case 'CreateEmptyArrayLiteral':
        case 'CreateArrayFromIterable': {
          writeAcc(t.arrayExpression([]));
          break;
        }

        case 'CreateEmptyObjectLiteral':
        case 'CreateObjectLiteral':
        case 'CloneObject': {
          writeAcc(t.objectExpression([]));
          break;
        }

        case 'CreateRegExpLiteral': {
          const rawPattern = this.getConstant(ops[0], 'pattern');
          const pattern = (typeof rawPattern === 'string' && rawPattern.length > 0) ? rawPattern : '(?:)';
          const flagMask = ops[2] !== undefined ? ops[2] : 0;
          const flags = this.decodeRegExpFlags(flagMask);
          writeAcc(t.regExpLiteral(pattern, flags));
          break;
        }

        case 'CreateMappedArguments':
        case 'CreateUnmappedArguments':
        case 'CreateRestParameter': {
          writeAcc(t.identifier('arguments'));
          break;
        }

        case 'StaInArrayLiteral': {
          const arrReg = opsDec[0];
          const arrNode = readReg(arrReg, inst);
          const val = readAcc(inst);
          if (t.isArrayExpression(arrNode)) {
            arrNode.elements.push(val);
            writeReg(arrReg, arrNode);
          } else {
            const indexNode = readReg(opsDec[1], inst);
            statements.push(t.expressionStatement(t.assignmentExpression('=', t.memberExpression(arrNode, indexNode, true), val)));
          }
          break;
        }

        case 'GetTemplateObject': {
          writeAcc(this.toASTLiteral(this.constants[ops[0]]));
          break;
        }

        // --- 5. Closures ---
        case 'CreateClosure': {
          const constVal = this.constants[ops[0]];
          if (!constVal || typeof constVal !== 'object' || constVal.type !== 'FunctionRef') {
            throw new Error(`[DataflowAnalyzer] InvalidClosureTargetError: CreateClosure target at 0x${inst.offset.toString(16)} (constant #${ops[0]}) is not a FunctionRef: ${JSON.stringify(constVal)}`);
          }
          writeAcc(this.resolveFunctionRef(constVal));
          break;
        }

        // --- 6. Function Calls & Construct ---
        case 'CallUndefinedReceiver0': {
          const callee = readReg(opsDec[0], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), []);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallUndefinedReceiver1': {
          const callee = readReg(opsDec[0], inst);
          const arg0 = readReg(opsDec[1], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), [arg0]);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallUndefinedReceiver2': {
          const callee = readReg(opsDec[0], inst);
          const arg0 = readReg(opsDec[1], inst);
          const arg1 = readReg(opsDec[2], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), [arg0, arg1]);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallUndefinedReceiver':
        case 'CallNoFeedback': {
          const callee = readReg(opsDec[0], inst);
          const startRaw = ops[1];
          const count = ops[2];
          const args = [];
          if (typeof count === 'number' && count > 0 && count <= 32) {
            for (let k = 0; k < count; k++) {
              const regName = this.profile.decodeRegister(startRaw - k, 1);
              args.push(readReg(regName, inst));
            }
          }
          const callExpr = t.callExpression(t.cloneNode(callee), args);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallAnyReceiver': {
          const callee = readReg(opsDec[0], inst);
          const startRaw = ops[1];
          const count = ops[2];
          const args = [];
          if (typeof count === 'number' && count > 1 && count <= 32) {
            for (let k = 1; k < count; k++) {
              const regName = this.profile.decodeRegister(startRaw - k, 1);
              args.push(readReg(regName, inst));
            }
          }
          const callExpr = t.callExpression(t.cloneNode(callee), args);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallProperty0': {
          const callee = readReg(opsDec[0], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), []);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallProperty1': {
          const callee = readReg(opsDec[0], inst);
          const arg0 = readReg(opsDec[2], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), [arg0]);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallProperty2': {
          const callee = readReg(opsDec[0], inst);
          const arg0 = readReg(opsDec[2], inst);
          const arg1 = readReg(opsDec[3], inst);
          const callExpr = t.callExpression(t.cloneNode(callee), [arg0, arg1]);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallProperty': {
          const callee = readReg(opsDec[0], inst);
          const startRaw = ops[1];
          const count = ops[2];
          const args = [];
          if (typeof count === 'number' && count > 1 && count <= 32) {
            for (let k = 1; k < count; k++) {
              const regName = this.profile.decodeRegister(startRaw - k, 1);
              args.push(readReg(regName, inst));
            }
          }
          const callExpr = t.callExpression(t.cloneNode(callee), args);
          writeAcc(callExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(callExpr)));
          }
          break;
        }

        case 'CallRuntime':
        case 'CallRuntimeForPair':
        case 'CallJSRuntime': {
          const runtimeId = ops[0];
          const startRaw = ops[1];
          const count = ops[2];
          const args = [];
          if (typeof count === 'number' && count > 0 && count <= 32) {
            for (let k = 0; k < count; k++) {
              const regName = this.profile.decodeRegister(startRaw - k, 1);
              args.push(readReg(regName, inst));
            }
          }
          const callExpr = t.callExpression(t.identifier(`__runtime_${runtimeId}`), args);
          writeAcc(callExpr);
          break;
        }

        case 'CallWithSpread': {
          const callee = readReg(opsDec[0], inst);
          writeAcc(t.callExpression(t.cloneNode(callee), [t.spreadElement(readReg(opsDec[1], inst))]));
          break;
        }

        case 'Construct':
        case 'ConstructWithSpread':
        case 'ConstructForwardAllArgs':
        case 'FindNonDefaultConstructorOrConstruct': {
          const callee = readReg(opsDec[0], inst);
          const startRaw = ops[1];
          const count = ops[2];
          const args = [];
          if (typeof count === 'number' && count > 0 && count <= 32) {
            for (let k = 0; k < count; k++) {
              const regName = this.profile.decodeRegister(startRaw - k, 1);
              args.push(readReg(regName, inst));
            }
          }
          const newExpr = t.newExpression(t.cloneNode(callee), args);
          writeAcc(newExpr);
          const nextInst = block.instructions[i + 1]?.name;
          if (!nextInst || (!nextInst.startsWith('Star') && !nextInst.startsWith('JumpIf') && nextInst !== 'Return')) {
            statements.push(t.expressionStatement(t.cloneNode(newExpr)));
          }
          break;
        }

        case 'InvokeIntrinsic': {
          const intrinsicId = ops[0];
          writeAcc(t.callExpression(t.identifier(`__intrinsic_${intrinsicId}`), []));
          break;
        }

        // --- 7. Arithmetic & Bitwise Operations ---
        case 'Add':
        case 'Add_StringConstant_Internalize': {
          writeAcc(t.binaryExpression('+', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'AddSmi': {
          writeAcc(t.binaryExpression('+', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Sub': {
          writeAcc(t.binaryExpression('-', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'SubSmi': {
          writeAcc(t.binaryExpression('-', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Mul': {
          writeAcc(t.binaryExpression('*', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'MulSmi': {
          writeAcc(t.binaryExpression('*', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Div': {
          writeAcc(t.binaryExpression('/', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'DivSmi': {
          writeAcc(t.binaryExpression('/', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Mod': {
          writeAcc(t.binaryExpression('%', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'ModSmi': {
          writeAcc(t.binaryExpression('%', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Exp': {
          writeAcc(t.binaryExpression('**', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'ExpSmi': {
          writeAcc(t.binaryExpression('**', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'BitwiseOr': {
          writeAcc(t.binaryExpression('|', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'BitwiseOrSmi': {
          writeAcc(t.binaryExpression('|', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'BitwiseXor': {
          writeAcc(t.binaryExpression('^', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'BitwiseXorSmi': {
          writeAcc(t.binaryExpression('^', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'BitwiseAnd': {
          writeAcc(t.binaryExpression('&', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'BitwiseAndSmi': {
          writeAcc(t.binaryExpression('&', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'ShiftLeft': {
          writeAcc(t.binaryExpression('<<', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'ShiftLeftSmi': {
          writeAcc(t.binaryExpression('<<', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'ShiftRight': {
          writeAcc(t.binaryExpression('>>', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'ShiftRightSmi': {
          writeAcc(t.binaryExpression('>>', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'ShiftRightLogical': {
          writeAcc(t.binaryExpression('>>>', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'ShiftRightLogicalSmi': {
          writeAcc(t.binaryExpression('>>>', readAcc(inst), this.createNumberLiteral(ops[0])));
          break;
        }

        case 'Inc': {
          writeAcc(t.binaryExpression('+', readAcc(inst), t.numericLiteral(1)));
          break;
        }

        case 'Dec': {
          writeAcc(t.binaryExpression('-', readAcc(inst), t.numericLiteral(1)));
          break;
        }

        case 'Negate': {
          writeAcc(t.unaryExpression('-', readAcc(inst)));
          break;
        }

        case 'BitwiseNot': {
          writeAcc(t.unaryExpression('~', readAcc(inst)));
          break;
        }

        case 'ToBoolean': {
          writeAcc(t.unaryExpression('!', t.unaryExpression('!', readAcc(inst))));
          break;
        }

        case 'ToBooleanLogicalNot':
        case 'LogicalNot': {
          writeAcc(t.unaryExpression('!', readAcc(inst)));
          break;
        }

        case 'TypeOf': {
          writeAcc(t.unaryExpression('typeof', readAcc(inst)));
          break;
        }

        case 'ToString': {
          writeAcc(t.callExpression(t.identifier('String'), [readAcc(inst)]));
          break;
        }

        case 'ToNumber':
        case 'ToNumeric': {
          writeAcc(t.callExpression(t.identifier('Number'), [readAcc(inst)]));
          break;
        }

        case 'ToObject': {
          writeAcc(t.callExpression(t.identifier('Object'), [readAcc(inst)]));
          break;
        }

        case 'ToName': {
          writeAcc(readAcc(inst));
          break;
        }

        // --- 8. Tests & Comparisons ---
        case 'TestNull': {
          writeAcc(t.binaryExpression('===', readAcc(inst), t.nullLiteral()));
          break;
        }

        case 'TestUndefined': {
          writeAcc(t.binaryExpression('===', readAcc(inst), t.identifier('undefined')));
          break;
        }

        case 'TestUndetectable': {
          writeAcc(t.binaryExpression('==', readAcc(inst), t.nullLiteral()));
          break;
        }

        case 'TestEqualStrict':
        case 'TestReferenceEqual': {
          writeAcc(t.binaryExpression('===', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestEqual': {
          writeAcc(t.binaryExpression('==', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestLessThan': {
          writeAcc(t.binaryExpression('<', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestGreaterThan': {
          writeAcc(t.binaryExpression('>', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestLessThanOrEqual': {
          writeAcc(t.binaryExpression('<=', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestGreaterThanOrEqual': {
          writeAcc(t.binaryExpression('>=', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestInstanceOf': {
          writeAcc(t.binaryExpression('instanceof', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestIn': {
          writeAcc(t.binaryExpression('in', readReg(opsDec[0], inst), readAcc(inst)));
          break;
        }

        case 'TestTypeOf': {
          const typeStr = this.getTypeofLiteral(ops[0]);
          writeAcc(t.binaryExpression('===', t.unaryExpression('typeof', readAcc(inst)), t.stringLiteral(typeStr)));
          break;
        }

        // --- 9. Branches & Jumps ---
        case 'JumpIfToBooleanTrue':
        case 'JumpIfTrue':
        case 'JumpIfTrueConstant':
        case 'JumpIfToBooleanTrueConstant': {
          exitCondition = readAcc(inst);
          break;
        }

        case 'JumpIfToBooleanFalse':
        case 'JumpIfFalse':
        case 'JumpIfFalseConstant':
        case 'JumpIfToBooleanFalseConstant': {
          exitCondition = t.unaryExpression('!', readAcc(inst));
          break;
        }

        case 'JumpIfNull':
        case 'JumpIfNullConstant': {
          exitCondition = t.binaryExpression('===', readAcc(inst), t.nullLiteral());
          break;
        }

        case 'JumpIfNotNull':
        case 'JumpIfNotNullConstant': {
          exitCondition = t.binaryExpression('!==', readAcc(inst), t.nullLiteral());
          break;
        }

        case 'JumpIfUndefined':
        case 'JumpIfUndefinedConstant': {
          exitCondition = t.binaryExpression('===', readAcc(inst), t.identifier('undefined'));
          break;
        }

        case 'JumpIfNotUndefined':
        case 'JumpIfNotUndefinedConstant': {
          exitCondition = t.binaryExpression('!==', readAcc(inst), t.identifier('undefined'));
          break;
        }

        case 'JumpIfUndefinedOrNull':
        case 'JumpIfUndefinedOrNullConstant': {
          exitCondition = t.binaryExpression('==', readAcc(inst), t.nullLiteral());
          break;
        }

        case 'JumpIfJSReceiver':
        case 'JumpIfJSReceiverConstant': {
          exitCondition = t.binaryExpression('!==', t.unaryExpression('typeof', readAcc(inst)), t.stringLiteral('object'));
          break;
        }

        case 'JumpIfForInDone':
        case 'JumpIfForInDoneConstant': {
          const idxNode = readReg(opsDec[1], inst);
          const lenNode = readReg(opsDec[2], inst);
          exitCondition = t.binaryExpression('>=', idxNode, lenNode);
          break;
        }

        case 'Jump':
        case 'JumpLoop':
        case 'JumpConstant': {
          break;
        }

        case 'SwitchOnSmiNoFeedback': {
          break;
        }

        // --- 10. Iteration / For-In / For-Of ---
        case 'ForInEnumerate': {
          const objNode = readReg(opsDec[0], inst);
          writeAcc(objNode);
          break;
        }

        case 'ForInPrepare': {
          const startRaw = ops[0];
          const cacheArrayReg = this.profile.decodeRegister(startRaw - 1, 1);
          const cacheLenReg = this.profile.decodeRegister(startRaw - 2, 1);
          const objNode = readAcc(inst);
          const keysExpr = t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('keys')), [objNode]);
          const arrId = this.createIdentifier(cacheArrayReg);
          statements.push(t.expressionStatement(t.assignmentExpression('=', arrId, keysExpr)));
          writeReg(cacheArrayReg, arrId);
          const lenId = this.createIdentifier(cacheLenReg);
          const lenExpr = t.memberExpression(arrId, t.identifier('length'));
          statements.push(t.expressionStatement(t.assignmentExpression('=', lenId, lenExpr)));
          writeReg(cacheLenReg, lenId);
          writeAcc(lenId);
          break;
        }

        case 'ForInStep': {
          const idxReg = opsDec[0];
          const targetId = this.createIdentifier(idxReg);
          statements.push(t.expressionStatement(t.updateExpression('++', targetId)));
          writeReg(idxReg, targetId);
          writeAcc(targetId);
          break;
        }

        case 'ForInNext': {
          const objNode = readReg(opsDec[0], inst);
          const idxNode = readReg(opsDec[1], inst);
          const startRaw = ops[2];
          const cacheArrayReg = this.profile.decodeRegister(startRaw, 1);
          const cacheArrayNode = readReg(cacheArrayReg, inst);
          const keyNode = t.memberExpression(cacheArrayNode, idxNode, true);
          writeAcc(keyNode);
          break;
        }

        case 'ForOfNext': {
          const iterNode = readReg(opsDec[0], inst);
          const nextFnNode = readReg(opsDec[1], inst);
          const nextCall = t.callExpression(t.memberExpression(nextFnNode, t.identifier('call')), [iterNode]);
          writeAcc(nextCall);
          break;
        }

        case 'GetIterator': {
          const objNode = readReg(opsDec[0], inst);
          const iterExpr = t.callExpression(
            t.memberExpression(objNode, t.memberExpression(t.identifier('Symbol'), t.identifier('iterator')), true),
            []
          );
          writeAcc(iterExpr);
          break;
        }

        // --- 11. Generators & Async ---
        case 'SuspendGenerator': {
          statements.push(t.expressionStatement(t.yieldExpression(readAcc(inst))));
          break;
        }

        case 'ResumeGenerator': {
          writeAcc(t.identifier('__resumeVal'));
          break;
        }

        case 'SwitchOnGeneratorState': {
          break;
        }

        // --- 12. Exceptions & Termination ---
        case 'Return': {
          const acc = readAcc(inst);
          if (t.isIdentifier(acc, { name: 'undefined' })) {
            statements.push(t.returnStatement(null));
          } else {
            statements.push(t.returnStatement(acc));
          }
          break;
        }

        case 'Throw':
        case 'ReThrow': {
          statements.push(t.throwStatement(readAcc(inst)));
          break;
        }

        case 'Abort': {
          statements.push(t.throwStatement(t.newExpression(t.identifier('Error'), [t.stringLiteral('Abort')])));
          break;
        }

        case 'ThrowReferenceErrorIfHole':
        case 'ThrowIfNotSuperConstructor':
        case 'ThrowSuperAlreadyCalledIfNotHole':
        case 'ThrowSuperNotCalledIfHole':
        case 'FindNonDefaultConstructorOrConstruct':
        case 'SetPendingMessage':
        case 'IncBlockCounter':
        case 'Debugger':
        case 'DebugBreak0':
        case 'DebugBreak1':
        case 'DebugBreak2':
        case 'DebugBreak3':
        case 'DebugBreak4':
        case 'DebugBreak5':
        case 'DebugBreak6':
        case 'DebugBreakWide':
        case 'DebugBreakExtraWide':
        case 'ExtraWide':
        case 'Wide': {
          // Diagnostic / debugging / internal assertions
          break;
        }

        default: {
          throw new Error(`[DataflowAnalyzer] UnsupportedBytecodeError: Opcode '${name}' (0x${(inst.hex || inst.value.toString(16))}) at offset 0x${inst.offset.toString(16)} is unhandled in dataflow analysis`);
        }
      }
    }

    return {
      statements,
      exitAcc: acc,
      exitCondition,
      regs
    };
  }
}
