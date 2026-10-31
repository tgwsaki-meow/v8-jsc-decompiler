// tests/t4/sources.mjs
//
// The acceptance corpus: JavaScript sources chosen so that between them they
// exercise every object class, every constant-pool union member and every
// ScopeInfo branch the front end claims to decode.
//
// Each entry declares what it is *for*, so a failure names a capability rather
// than a file. `sloppy: false` sources are compiled with a 'use strict'
// prologue; everything else is a classic sloppy script, which is what both
// `new vm.Script()` and a `.js` file in a commonjs directory produce.

function repeat(n, f, sep = '\n') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(f(i));
  return out.join(sep);
}

export const SOURCES = [
  {
    name: 'plain-functions',
    covers: ['function declaration', 'parameters', 'return', 'Smi and string constants'],
    src: `
function add(a, b) { return a + b; }
function greet(who) { return "hello " + who; }
function many(a, b, c, d, e) { return a * b - c / d + e % 7; }
add(1, 2); greet("x"); many(1, 2, 3, 4, 5);
`,
  },
  {
    name: 'nested-closures',
    covers: ['context allocation', 'ScopeInfo.context_local_names', 'outer_scope_info chain'],
    src: `
function outer(seed) {
  var counter = seed;
  var label = "c";
  function middle(step) {
    var scale = step * 2;
    function inner(extra) {
      counter += scale + extra;
      return label + counter;
    }
    return inner;
  }
  return middle;
}
outer(1)(2)(3);
`,
  },
  {
    name: 'generators',
    covers: ['SwitchOnGeneratorState', 'SuspendGenerator', 'FunctionKind kGeneratorFunction'],
    src: `
function* gen(n) {
  var total = 0;
  for (var i = 0; i < n; i++) { total += i; yield total; }
  return total;
}
function* delegating() { yield 1; yield* gen(3); yield 2; }
[...delegating()];
`,
  },
  {
    name: 'async',
    covers: ['FunctionKind kAsyncFunction', 'await desugaring handler prediction'],
    src: `
async function fetchish(x) {
  var a = await x;
  try { return await (a + 1); } finally { a = null; }
}
async function* agen(x) { yield await x; }
fetchish(1); agen(1);
`,
  },
  {
    name: 'class-full',
    covers: ['getter', 'setter', 'static block', 'private field', 'private method', 'classCtor', 'derived ctor'],
    src: `
class Base {
  #secret = 1;
  static tally = 0;
  static { Base.tally = 10; }
  constructor(v) { this.v = v; }
  get doubled() { return this.v * 2; }
  set doubled(x) { this.v = x / 2; }
  #hidden() { return this.#secret; }
  reveal() { return this.#hidden(); }
  static make(v) { return new Base(v); }
}
class Derived extends Base {
  constructor(v) { super(v + 1); }
  get doubled() { return super.doubled + 1; }
}
new Derived(1).reveal();
`,
  },
  {
    name: 'try-catch-finally',
    covers: ['HandlerTable rows', 'prediction CAUGHT', 'finally token dispatch'],
    src: `
function risky(x) {
  try {
    if (x < 0) throw new RangeError("neg");
    return x;
  } catch (e) {
    return -1;
  } finally {
    x = 0;
  }
}
function nested(x) {
  try { try { return x(); } finally { x = null; } }
  catch (e) { return e; }
}
function onlyFinally(x) { try { return x; } finally { } }
risky(1); nested(function () { return 1; }); onlyFinally(1);
`,
  },
  {
    name: 'switch',
    covers: ['SwitchOnSmiNoFeedback jump table in the constant pool', 'comparison-chain switch'],
    src: `
function dense(x) {
  switch (x) {
    case 0: return "a";
    case 1: return "b";
    case 2: return "c";
    case 3: return "d";
    case 4: return "e";
    case 5: return "f";
    case 6: return "g";
    case 7: return "h";
    default: return "z";
  }
}
function sparse(x) {
  switch (x) { case "p": return 1; case "q": return 2; default: return 3; }
}
dense(1); sparse("p");
`,
  },
  {
    name: 'for-in-for-of',
    covers: ['ForInPrepare/ForInNext/ForInStep', 'GetIterator', 'IteratorClose finally'],
    src: `
function keys(o) { var out = []; for (var k in o) out.push(k); return out; }
function vals(it) { var out = []; for (var v of it) out.push(v); return out; }
async function awaited(it) { var out = []; for await (var v of it) out.push(v); return out; }
keys({ a: 1 }); vals([1, 2]); awaited([1]);
`,
  },
  {
    name: 'destructuring',
    covers: ['destructuring with defaults', 'rest', 'nested patterns'],
    src: `
function f({ a = 1, b: { c = 2 } = {}, ...rest }, [x = 3, y = x + 1, ...tail] = []) {
  return a + c + x + y + tail.length + Object.keys(rest).length;
}
var { p = 1, q: qq = 2 } = { p: 9 };
var [u, , w = 4] = [1, 2];
f({ a: 1, b: { c: 2 }, z: 3 }, [1, 2, 3]);
`,
  },
  {
    name: 'template-literals',
    covers: ['GetTemplateObject', 'TemplateObjectDescription raw and cooked'],
    src: `
function plain(a, b) { return \`x\${a}y\${b}z\`; }
function tag(strings) { return strings.raw.join("|"); }
function tagged(a) { return tag\`line1\\n\${a}\\ttab\`; }
plain(1, 2); tagged(3);
`,
  },
  {
    name: 'regexps',
    covers: ['RegExpBoilerplateDescription', 'every flag letter'],
    src: `
var all = /a(b)c/dgimsuy;
var sets = /[\\p{L}]/v;
var plain = /^ab+c$/;
var esc = /\\/\\\\\\n/g;
function use(s) { return all.test(s) || sets.test(s) || plain.test(s) || esc.test(s); }
use("abc");
`,
  },
  {
    name: 'literals',
    covers: ['ObjectBoilerplateDescription', 'ArrayBoilerplateDescription', 'sparse array', 'computed keys', 'accessors in literals'],
    src: `
var sparse = [1, , 3, , , 6];
var nested = [[1, 2], { a: [3, { b: 4 }] }];
var k = "dyn";
var computed = { [k]: 1, ["x" + k]: 2, fixed: 3 };
var accessors = { get g() { return 1; }, set g(v) { this._v = v; }, m() { return 2; } };
var doubles = [1.5, 2.25, -0.5];
var mixed = [1, "two", true, null, undefined, 3.5];
var holey = { 0: "a", 1: "b", 10: "c" };
[sparse, nested, computed, accessors, doubles, mixed, holey];
`,
  },
  {
    name: 'with-statement',
    covers: ['WITH_SCOPE', 'sloppy_eval_can_extend_vars', 'dynamic lookup slots'],
    sloppy: true,
    src: `
function w(o) {
  var outside = 1;
  with (o) { return inside + outside; }
}
w({ inside: 2 });
`,
  },
  {
    name: 'direct-eval',
    covers: ['EVAL_SCOPE', 'sloppy_eval_can_extend_vars', 'dependent_code field'],
    sloppy: true,
    src: `
function e(x) {
  var local = x;
  return eval("local + 1");
}
function e2() { var a = 1; function inner() { return eval("a"); } return inner(); }
e(1); e2();
`,
  },
  {
    name: 'strict-mode',
    covers: ['SharedFunctionInfoFlags.is_strict', 'ScopeFlags.language_mode'],
    strict: true,
    src: `
function s(a) { return a + 1; }
var arrow = (a) => a * 2;
class C { m() { return 1; } }
s(1); arrow(2); new C().m();
`,
  },
  {
    name: 'sloppy-mode',
    covers: ['the sloppy counterpart of strict-mode, for the language_mode bit'],
    sloppy: true,
    src: `
function s(a) { return a + 1; }
function sloppyDelete(o, k) { return delete o[k]; }
function args() { return arguments.length; }
s(1); sloppyDelete({ a: 1 }, "a"); args(1, 2);
`,
  },
  {
    name: 'arrow-and-method-kinds',
    covers: ['FunctionKind arrow/method/async-arrow/concise-generator'],
    src: `
var a = (x) => x;
var aa = async (x) => x;
var o = {
  m() { return 1; },
  *g() { yield 1; },
  async am() { return 1; },
  async *ag() { yield 1; },
  get p() { return 1; },
  set p(v) { this.q = v; },
};
a(1); aa(1); o.m();
`,
  },
  {
    name: 'spread-rest',
    covers: ['CreateRestParameter', 'CallWithSpread', 'ConstructWithSpread', 'CreateArrayFromIterable'],
    src: `
function rest(a, ...others) { return a + others.length; }
function spreadCall(f, xs) { return f(...xs); }
function spreadNew(C, xs) { return new C(...xs); }
function spreadArray(xs) { return [0, ...xs, 1]; }
function spreadObject(o) { return { x: 0, ...o }; }
rest(1, 2, 3); spreadCall(rest, [1, 2]); spreadArray([1]); spreadObject({ y: 1 });
`,
  },
  {
    name: 'optional-chaining',
    covers: ['JumpIfUndefinedOrNull', 'nullish coalescing', 'logical assignment'],
    src: `
function oc(o) { return o?.a?.b?.(1) ?? o?.["k"] ?? 0; }
function la(o) { o.a ||= 1; o.b &&= 2; o.c ??= 3; return o; }
oc({}); la({});
`,
  },
  {
    name: 'labels-and-loops',
    covers: ['JumpLoop back edges', 'labeled break/continue', 'do-while', 'while', 'for'],
    src: `
function loops(n) {
  var t = 0;
  outer: for (var i = 0; i < n; i++) {
    inner: for (var j = 0; j < n; j++) {
      if (j === 2) continue outer;
      if (i === 3) break outer;
      t += j;
    }
  }
  var k = 0;
  while (k < n) { k++; }
  do { k--; } while (k > 0);
  for (;;) { break; }
  return t + k;
}
loops(5);
`,
  },
  {
    name: 'numbers-and-bigint',
    covers: ['HeapNumber constants', 'BigInt constants', 'Smi constants'],
    src: `
function nums() {
  return [0, 1, -1, 1073741823, 1073741824, 1.5, -0.0, 1e308, NaN, Infinity];
}
function bigs() { return [1n, -2n, 123456789012345678901234567890n]; }
nums(); bigs();
`,
  },
  {
    name: 'symbols',
    covers: ['Symbol constants in the pool', 'well-known symbol properties'],
    src: `
var s = Symbol("mine");
var o = { [s]: 1, [Symbol.iterator]: function () { return this; }, [Symbol.asyncIterator]: 2 };
function get(x) { return x[Symbol.toPrimitive]; }
get(o);
`,
  },
  {
    name: 'typeof-and-globals',
    covers: ['LdaGlobalInsideTypeof', 'TestTypeOf', 'global property loads'],
    src: `
function t(x) {
  return typeof x === "function" && typeof undeclaredGlobal === "undefined"
    && typeof Math.max === "function" && typeof 1n === "bigint";
}
function g() { return globalThis && Math.PI && JSON.stringify({}); }
t(t); g();
`,
  },
  {
    name: 'uncompiled-inner',
    covers: ['SFI with UncompiledData and no BytecodeArray (the lazy hole)'],
    lazy: true,
    src: `
function compiledNow() { return 1; }
function neverCalled(a, b) {
  var hidden = a + b;
  function deeper() { return hidden; }
  return deeper;
}
function alsoNeverCalled() { return neverCalled; }
compiledNow();
`,
  },
  {
    name: 'many-context-locals',
    covers: ['ScopeInfo context_local_names_hashtable (>= kScopeInfoMaxInlinedLocalNamesSize)'],
    src: `
function outerMany() {
${repeat(90, (i) => `  var v${i} = ${i};`)}
  return function captureAll() {
    return ${repeat(90, (i) => `v${i}`, ' + ')};
  };
}
outerMany()();
`,
  },
  {
    name: 'few-context-locals',
    covers: ['ScopeInfo inlined context_local_names, just under the threshold'],
    src: `
function outerFew() {
${repeat(70, (i) => `  var w${i} = ${i};`)}
  return function captureSome() {
    return ${repeat(70, (i) => `w${i}`, ' + ')};
  };
}
outerFew()();
`,
  },
  {
    name: 'wide-registers',
    covers: ['more than 256 registers, forcing Wide operands'],
    src: `
function wide(seed) {
${repeat(400, (i) => `  var r${i} = seed + ${i};`)}
  return ${repeat(400, (i) => `r${i}`, ' + ')};
}
wide(1);
`,
  },
  {
    name: 'extra-wide-jump',
    covers: ['a conditional whose body exceeds 65535 bytes of bytecode, forcing ExtraWide'],
    src: `
function extraWide(flag, o) {
  if (flag) {
${repeat(9000, (i) => `    o.p${i} = ${i};`)}
  }
  return o;
}
extraWide(false, {});
`,
  },
  {
    name: 'getters-setters-define',
    covers: ['DefineNamedOwnProperty', 'DefineKeyedOwnProperty', 'runtime DefineAccessor'],
    src: `
function build(k, v) {
  var o = {};
  Object.defineProperty(o, "x", { get: function () { return v; } });
  o[k] = v;
  o.fixed = v;
  return { ...o, get y() { return 1; }, set y(z) { v = z; } };
}
build("a", 1);
`,
  },
  {
    name: 'catch-param-patterns',
    covers: ['CATCH_SCOPE', 'destructured catch parameter', 'optional catch binding'],
    src: `
function c1(f) { try { f(); } catch ({ message, stack = "none" }) { return message + stack; } }
function c2(f) { try { f(); } catch { return "swallowed"; } }
function c3(f) { try { f(); } catch (e) { try { f(); } catch (e2) { return e2; } return e; } }
c1(function () { throw new Error("m"); }); c2(function () {}); c3(function () {});
`,
  },
  {
    name: 'block-scopes',
    covers: ['BLOCK_SCOPE', 'let/const VariableMode', 'TDZ initialization flag'],
    src: `
function blocks(n) {
  const base = 1;
  let acc = 0;
  { let inner = 2; const frozen = 3; acc += inner + frozen; }
  for (let i = 0; i < n; i++) { let captured = i; setTimeoutish(function () { return captured; }); }
  return acc + base;
}
function setTimeoutish(f) { return f; }
blocks(2);
`,
  },
];

/** The text actually handed to V8, with the mode prologue applied. */
export function sourceText(entry) {
  const body = entry.src.replace(/^\n/, '');
  return entry.strict ? `"use strict";\n${body}` : body;
}

export default { SOURCES, sourceText };
