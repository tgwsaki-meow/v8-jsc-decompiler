// Small, self-contained sources used by the O1 oracle self-test.
//
// Pairs matter:
//   *_a / *_b  -> semantically identical, different identifier names
//                 (must normalise to EQUAL streams)
//   anything else -> distinct programs (must normalise to UNEQUAL streams)

export const SNIPPETS = [
  {
    name: 'sum_loop_a',
    filter: 'f',
    source: `function f(arr, n) { let s = 0; for (let i = 0; i < n; i++) s += arr[i]; return s; }
f([1,2,3], 3);`,
  },
  {
    name: 'sum_loop_b',
    filter: 'f',
    source: `function f(theArray, count) { let total = 0; for (let index = 0; index < count; index++) total += theArray[index]; return total; }
f([1,2,3], 3);`,
  },
  {
    name: 'ternary_a',
    filter: 'f',
    source: `function f(a, b) { return a > b ? a - b : b - a; }
f(1, 2);`,
  },
  {
    name: 'ternary_b',
    filter: 'f',
    source: `function f(left, right) { return left > right ? left - right : right - left; }
f(1, 2);`,
  },
  {
    name: 'logical_and_or',
    filter: 'f',
    source: `function f(a, b, c) { return (a && b) || (c ?? a); }
f(1, 2, 3);`,
  },
  {
    name: 'try_catch_finally',
    filter: 'f',
    source: `function f(x) { try { return x.y; } catch (e) { return e; } finally { x = null; } }
f({y: 1});`,
  },
  {
    name: 'for_of',
    filter: 'f',
    source: `function f(it) { let n = 0; for (const v of it) n += v; return n; }
f([1,2,3]);`,
  },
  {
    name: 'for_in',
    filter: 'f',
    source: `function f(o) { let s = ''; for (const k in o) s += k; return s; }
f({a: 1, b: 2});`,
  },
  {
    name: 'destructure_default',
    filter: 'f',
    source: `function f(o) { const {a = 1, b: {c} = {c: 2}} = o; return a + c; }
f({a: 5, b: {c: 6}});`,
  },
  {
    name: 'class_extends',
    filter: 'C',
    source: `class B { constructor(x) { this.x = x; } get v() { return this.x; } }
class C extends B { constructor(x) { super(x + 1); } m() { return super.v + this.x; } }
new C(1).m();`,
  },
  {
    name: 'generator',
    filter: 'g',
    source: `function* g(n) { for (let i = 0; i < n; i++) yield i * 2; return -1; }
[...g(3)];`,
  },
  {
    name: 'async_await',
    filter: 'f',
    source: `async function f(p) { const a = await p; try { return await a.q(); } catch { return 0; } }
f(Promise.resolve({q(){return 1;}}));`,
  },
  {
    name: 'switch_table',
    filter: 'f',
    source: `function f(n) { switch (n) { case 0: return 'a'; case 1: return 'b'; case 2: return 'c'; case 3: return 'd'; case 4: return 'e'; case 5: return 'f'; case 6: return 'g'; default: return 'z'; } }
f(3);`,
  },
  {
    name: 'template_spread',
    filter: 'f',
    source: `function f(a, ...rest) { return \`x\${a}y\${rest.length}\` + [...rest, a].join(''); }
f(1, 2, 3);`,
  },
  {
    name: 'object_literal',
    filter: 'f',
    source: `function f(k, v) { return {a: 1, [k]: v, get g() { return 2; }, m() { return 3; }, ...v}; }
f('z', {});`,
  },
  {
    name: 'labeled_break',
    filter: 'f',
    source: `function f(n) { outer: for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { if (i * j > 4) break outer; if (j === 1) continue outer; } } return n; }
f(5);`,
  },
  {
    name: 'optional_chain',
    filter: 'f',
    source: `function f(o) { return o?.a?.b?.(1) ?? o?.['c']; }
f({});`,
  },
  {
    name: 'typeof_delete_in',
    filter: 'f',
    source: `function f(o, k) { return typeof o === 'object' && k in o && delete o[k]; }
f({a:1}, 'a');`,
  },
];

/** Deterministic pairs the self-test asserts on. */
export const EQUAL_PAIRS = [
  ['sum_loop_a', 'sum_loop_b'],
  ['ternary_a', 'ternary_b'],
];

export const UNEQUAL_PAIRS = [
  ['sum_loop_a', 'ternary_a'],
  ['for_of', 'for_in'],
  ['generator', 'async_await'],
  ['switch_table', 'labeled_break'],
  ['sum_loop_a', 'optional_chain'],
];
