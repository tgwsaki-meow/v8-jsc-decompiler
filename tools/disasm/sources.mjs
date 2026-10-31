// tools/disasm/sources.mjs
//
// The oracle corpus for src/disasm/: JavaScript sources chosen so that between
// them they exercise every decoding rule the disassembler implements.
//
// They are plain sloppy classic scripts, because that is what both sides of the
// comparison see: `new vm.Script(src).createCachedData()` compiles a classic
// script, and tools/oracle/engines.mjs pins its work directory to
// {"type":"commonjs"} so the listing engine does too. A module or a strict
// wrapper would change the emitted bytecode and turn an engine difference into
// a bogus disassembler bug.
//
// `want` lists the decoding features each source is here to cover; the
// self-test asserts that every feature in the union is actually observed, so a
// source that silently stops exercising its feature (a V8 change, a typo) is
// reported rather than quietly passing.

/** Build a source with a loop body big enough to force a given jump width. */
function bigLoop(bodyStatements) {
  const body = [];
  for (let i = 0; i < bodyStatements; i++) body.push(`  t = t + ${i % 7} | 0;`);
  return `function f(n) {
  var t = 0;
  do {
${body.join('\n')}
    n = n - 1;
  } while (n > 0);
  return t;
}
f(2);
`;
}

/** Many distinct locals, to push register operands past one signed byte. */
function manyRegisters(count) {
  const decl = [];
  const use = [];
  for (let i = 0; i < count; i++) {
    decl.push(`  var v${i} = ${i};`);
    use.push(`v${i}`);
  }
  // Summing them all in one expression keeps every local live at once, so the
  // register allocator cannot reuse slots.
  return `function f() {
${decl.join('\n')}
  return ${use.join(' + ')};
}
f();
`;
}

/** Many distinct constants, which is what widens a *forward* jump operand. */
function manyConstants(count) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`  o["k${i}"] = "v${i}";`);
  return `function f(c) {
  var o = {};
${lines.join('\n')}
  if (c) { o.a = 1; } else { o.b = 2; }
  return o;
}
f(1);
`;
}

export const SOURCES = [
  {
    name: 'empty',
    want: ['return'],
    source: `function f() {}\nf();\n`,
  },
  {
    name: 'arith',
    want: ['smiOps', 'feedbackSlot'],
    source: `function f(a, b) {
  var x = a + b, y = a - b, z = a * b, w = a / b, m = a % b, e = a ** b;
  var i = a | b, j = a & b, k = a ^ b, l = a << b, n = a >> b, o = a >>> b;
  var p = -a, q = ~a, r = !a, s = +a;
  x += 1; y -= 2; z *= 3; w /= 4; m %= 5; i |= 6; j &= 7; k ^= 8; l <<= 1; n >>= 1;
  return x + y + z + w + m + e + i + j + k + l + n + o + p + q + r + s;
}
f(3, 4);
`,
  },
  {
    name: 'compare',
    want: ['compareOps'],
    source: `function f(a, b) {
  return (a == b) + (a === b) + (a != b) + (a !== b) + (a < b) + (a > b)
       + (a <= b) + (a >= b) + (a in Object(b)) + (b instanceof Object);
}
f(1, 1);
`,
  },
  {
    name: 'if_else',
    want: ['forwardJump', 'conditionalJump'],
    source: `function f(a) {
  if (a > 0) { return 'pos'; } else if (a < 0) { return 'neg'; } else { return 'zero'; }
}
f(1);
`,
  },
  {
    name: 'ternary_logical',
    want: ['forwardJump', 'toBooleanJump'],
    source: `function f(a, b, c) {
  var x = a ? b : c;
  var y = a && b || c;
  var z = a ?? b;
  return x + y + z;
}
f(1, 2, 3);
`,
  },
  {
    name: 'logical_assign',
    want: ['forwardJump'],
    source: `function f(o) {
  o.a ||= 1;
  o.b &&= 2;
  o.c ??= 3;
  return o;
}
f({});
`,
  },
  {
    name: 'while_loop',
    want: ['jumpLoop'],
    source: `function f(n) {
  var t = 0;
  while (n > 0) { t += n; n--; }
  return t;
}
f(3);
`,
  },
  {
    name: 'do_while',
    want: ['jumpLoop'],
    source: `function f(n) {
  var t = 0;
  do { t += n; n--; } while (n > 0);
  return t;
}
f(3);
`,
  },
  {
    name: 'for_loop',
    want: ['jumpLoop'],
    source: `function f(n) {
  var t = 0;
  for (var i = 0; i < n; i++) { if (i === 2) continue; if (i === 7) break; t += i; }
  return t;
}
f(10);
`,
  },
  {
    name: 'for_in',
    want: ['jumpLoop', 'forInPrepare', 'regOutTriple'],
    source: `function f(o) {
  var t = '';
  for (var k in o) { t += k; }
  return t;
}
f({a: 1, b: 2});
`,
  },
  {
    name: 'for_of',
    want: ['jumpLoop', 'getIterator', 'handlerTable'],
    source: `function f(a) {
  var t = 0;
  for (var v of a) { t += v; }
  return t;
}
f([1, 2, 3]);
`,
  },
  {
    name: 'for_of_break',
    want: ['jumpLoop', 'handlerTable'],
    source: `function f(a) {
  for (var v of a) { if (v > 1) break; }
  return v;
}
f([1, 2, 3]);
`,
  },
  {
    name: 'labeled_break_continue',
    want: ['jumpLoop', 'forwardJump'],
    source: `function f(n) {
  var t = 0;
  outer:
  for (var i = 0; i < n; i++) {
    inner:
    for (var j = 0; j < n; j++) {
      if (j === 1) continue inner;
      if (j === 3) continue outer;
      if (i === 4) break outer;
      if (j === 5) break inner;
      t += i * j;
    }
  }
  return t;
}
f(6);
`,
  },
  {
    name: 'switch_jumptable',
    want: ['jumpTable', 'switchOnSmiNoFeedback'],
    source: `function f(a) {
  switch (a) {
    case 0: return 'a';
    case 1: return 'b';
    case 2: return 'c';
    case 3: return 'd';
    case 4: return 'e';
    case 5: return 'f';
    case 6: return 'g';
    case 7: return 'h';
    case 8: return 'i';
    case 9: return 'j';
    default: return 'z';
  }
}
f(3);
`,
  },
  {
    name: 'switch_jumptable_fallthrough',
    want: ['jumpTable'],
    source: `function f(a) {
  var t = 0;
  switch (a) {
    case 10: t += 1;
    case 11: t += 2; break;
    case 12: t += 3;
    case 13:
    case 14: t += 4; break;
    case 15: t += 5;
    case 16: t += 6;
    case 17: t += 7; break;
    case 18: t += 8; break;
    case 19: t += 9; break;
    default: t -= 1;
  }
  return t;
}
f(12);
`,
  },
  {
    name: 'switch_negative_base',
    want: ['jumpTable'],
    source: `function f(a) {
  switch (a) {
    case -4: return 1;
    case -3: return 2;
    case -2: return 3;
    case -1: return 4;
    case 0: return 5;
    case 1: return 6;
    case 2: return 7;
    default: return 0;
  }
}
f(-2);
`,
  },
  {
    name: 'switch_strings',
    want: ['forwardJump'],
    source: `function f(a) {
  switch (a) {
    case 'x': return 1;
    case 'y': return 2;
    case 'z': return 3;
    default: return 0;
  }
}
f('y');
`,
  },
  {
    name: 'try_catch',
    want: ['handlerTable'],
    source: `function f(a) {
  try { if (a) throw new Error('x'); return 1; }
  catch (e) { return e.message; }
}
f(1);
`,
  },
  {
    name: 'try_finally',
    want: ['handlerTable', 'jumpTable'],
    source: `function f(a) {
  var t = 0;
  for (var i = 0; i < 3; i++) {
    try {
      if (a === 1) return 'r';
      if (a === 2) break;
      if (a === 3) continue;
      if (a === 4) throw new Error('e');
      t += 1;
    } finally {
      t += 10;
    }
  }
  return t;
}
f(0);
`,
  },
  {
    name: 'try_catch_finally_nested',
    want: ['handlerTable'],
    source: `function f(a) {
  try {
    try { throw new Error('inner'); }
    catch (e) { if (a) throw e; return 'caught'; }
    finally { a = a + 1; }
  } catch (e2) { return 'outer:' + e2.message; }
  finally { a = a + 2; }
}
f(1);
`,
  },
  {
    name: 'generator',
    want: ['switchOnGeneratorState', 'jumpTable', 'suspendGenerator', 'resumeGenerator', 'regOutList'],
    source: `function* g(n) {
  var t = 0;
  yield 1;
  for (var i = 0; i < n; i++) { t += yield i; }
  try { yield 'in try'; } finally { yield 'in finally'; }
  return t;
}
var it = g(2); it.next(); it.next(); it.next();
`,
  },
  {
    name: 'generator_delegate',
    want: ['switchOnGeneratorState', 'jumpTable', 'handlerTable'],
    source: `function* inner() { yield 1; yield 2; }
function* outer() { yield* inner(); yield 3; }
var it = outer(); it.next(); it.next(); it.next();
`,
  },
  {
    name: 'async_fn',
    want: ['switchOnGeneratorState', 'jumpTable', 'intrinsic', 'handlerTable'],
    source: `async function f(p) {
  try { var a = await p; return a + 1; }
  catch (e) { return -1; }
  finally { globalThis.__x = 1; }
}
f(Promise.resolve(1));
`,
  },
  {
    name: 'async_generator',
    want: ['switchOnGeneratorState', 'jumpTable', 'intrinsic'],
    source: `async function* f(a) { for (var v of a) { yield await v; } }
f([1, 2]).next();
`,
  },
  {
    name: 'async_for_await',
    want: ['switchOnGeneratorState', 'jumpTable', 'handlerTable'],
    source: `async function f(a) { var t = 0; for await (var v of a) { t += v; } return t; }
f([1, 2]);
`,
  },
  {
    name: 'optional_chaining',
    want: ['jumpIfUndefinedOrNull', 'forwardJump'],
    source: `function f(a) {
  return a?.b?.c ?? a?.["d"] ?? a?.e?.(1, 2) ?? a?.f?.g?.h;
}
f({});
`,
  },
  {
    name: 'destructuring',
    want: ['handlerTable', 'getIterator'],
    source: `function f(o, a) {
  var {x, y: {z} = {z: 1}, ...rest} = o;
  var [p, , q = 5, ...tail] = a;
  ({x} = o);
  return x + z + p + q + rest.n + tail.length;
}
f({x: 1, y: {z: 2}, n: 3}, [1, 2, 3, 4]);
`,
  },
  {
    name: 'spread_rest',
    want: ['callWithSpread', 'regList'],
    source: `function g() { return arguments.length; }
function f(a, ...rest) {
  var arr = [1, ...a, 2];
  var o = {p: 1, ...a};
  return g(...arr, ...rest) + arr.length + o.p + new Date(...arr).getTime();
}
f([1, 2], 3, 4);
`,
  },
  {
    name: 'classes',
    // DefineClass is a runtime function, not a bytecode, so it is observed
    // through a kRuntimeId operand.
    want: ['defineClass', 'getSuperConstructor', 'regOutPair'],
    source: `class A {
  #p = 1;
  static s = 2;
  static { A.t = 3; }
  constructor(x) { this.x = x; }
  get v() { return this.#p; }
  set v(n) { this.#p = n; }
  m() { return this.x; }
  static sm() { return 1; }
}
class B extends A {
  constructor(x) { super(x + 1); }
  m() { return super.m() + 1; }
  ['computed' + 1]() { return 2; }
}
new B(1).m();
`,
  },
  {
    name: 'template_literals',
    want: ['getTemplateObject'],
    source: `function tag(s) { return s.raw.length; }
function f(a) { return tag\`x\${a}y\` + \`plain\${a}\` + String.raw\`r\${a}\`; }
f(1);
`,
  },
  {
    name: 'literals',
    want: ['createObjectLiteral', 'createArrayLiteral', 'flag8'],
    source: `function f(k, v) {
  var o = {a: 1, b: 'two', 3: true, [k]: v, get g() { return 1; }, set g(x) {}, m() { return 2; }, __proto__: null};
  var a = [1, 2, , 4, 'five', [6, [7]], {n: 8}];
  return o.a + a.length;
}
f('k', 1);
`,
  },
  {
    name: 'regexp_typeof_delete',
    want: ['createRegExpLiteral', 'testTypeOf', 'flag16'],
    source: `function f(s, o) {
  var re = /a(b)c/gi;
  var t = typeof s === 'string' && typeof o === 'object' && typeof undefinedGlobalXyz === 'undefined';
  delete o.a;
  delete o['b'];
  return re.test(s) + t + ('c' in o) + void 0;
}
f('abc', {a: 1, b: 2});
`,
  },
  {
    name: 'closures_context',
    want: ['contextSlot', 'createClosure', 'createBlockContext'],
    source: `function outer(a) {
  let b = a + 1;
  const c = a + 2;
  function mid(d) {
    let e = b + d;
    {
      let f = e + c;
      return function inner() { return a + b + c + d + e + f; };
    }
  }
  return mid(1)();
}
outer(1);
`,
  },
  {
    name: 'with_eval',
    want: ['lookupSlot'],
    // `eval('1+1')` makes V8 compile a second script at run time. That script
    // is printed but is not part of the cached top-level script, so in `cache`
    // mode exactly one listed function legitimately has no counterpart.
    allowUnpaired: 1,
    source: `function f(o, s) {
  var r = 0;
  with (o) { r = a + b; }
  r += eval(s);
  return r;
}
f({a: 1, b: 2}, '1+1');
`,
  },
  {
    name: 'strict_mode',
    want: ['deleteStrict'],
    source: `function f(o) {
  'use strict';
  var x = delete o.a;
  return x + (o.b = 1);
}
f({a: 1});
`,
  },
  {
    name: 'bigint_exp',
    // Not 'bigint': neither input side classifies a BigInt constant as
    // {t:'bigint'} -- adapter_legacy cannot read the BigInt object layout and
    // the listing prints it as an opaque <BigInt ...>. Both report
    // {t:'unresolved'}, which 8.1 requires rather than a guess. Noted in
    // docs/DISASM.md under "known gaps".
    want: ['smiOps'],
    source: `function f(a) { return (2n ** 64n) + BigInt(a) + (a ** 2); }
f(3);
`,
  },
  {
    name: 'runtime_calls',
    want: ['callRuntime'],
    source: `function f(o, k) {
  var a = {...o};
  for (var x in o) { if (x === k) { delete o[x]; } }
  return Object.keys(a).length + (o instanceof Object);
}
f({a: 1}, 'a');
`,
  },
  {
    name: 'calls_all_shapes',
    want: ['regList', 'callProperty', 'construct'],
    source: `function g(a, b, c) { return a + b + c; }
function f(o) {
  return g(1, 2, 3) + o.m(1, 2) + o['m'](1) + new o.C(1, 2, 3).v + (0, o.m)(1) + g.call(null, 1, 2, 3) + g.apply(null, [1, 2, 3]);
}
f({m: function () { return 1; }, C: function (a) { this.v = a; }});
`,
  },
  {
    name: 'wide_registers',
    want: ['wide', 'wideRegister'],
    source: manyRegisters(320),
  },
  {
    name: 'wide_constants',
    want: ['wide'],
    source: manyConstants(320),
  },
  {
    name: 'extrawide_loop',
    // A do/while whose body is well over 65535 bytes of bytecode, so the
    // backward JumpLoop delta needs a 32-bit operand:
    // BytecodeArrayWriter::EmitJumpLoop picks the scale from the delta.
    want: ['wide', 'extraWide', 'jumpLoop'],
    // ~9000 statements is ~115 kB of bytecode, comfortably past the 65535 a
    // 16-bit JumpLoop delta can hold, without making the listing unwieldy.
    source: bigLoop(9000),
    big: true,
  },
];

/** Every feature any source claims to cover. */
export const WANTED = [...new Set(SOURCES.flatMap((s) => s.want))].sort();

export default { SOURCES, WANTED };
