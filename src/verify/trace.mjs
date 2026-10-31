// Deterministic value serialisation + the instrumented global used by O3.
//
// O3 compares two programs by the ORDERED TRACE of observable effects they
// produce, so the serialisation has to be total (never throws, never recurses
// forever) and stable (same value -> same string, on any run).
//
// What a trace record looks like:
//   { seq, k: 'T',      label, values: [string, ...] }   explicit T(...) call
//   { seq, k: 'write',  target, key, value }             property write on G
//   { seq, k: 'call',   name, args: [...] }              call through G.fn
//   { seq, k: 'log',    args: [...] }                    console.*
//   { seq, k: 'throw',  value }                          escaped the script
//   { seq, k: 'done',   completion }                     normal completion
//
// Functions are serialised WITHOUT their name (`[function/2]`): function names
// are a symbol-recovery question, measured by metric 5, and folding them into
// the behavioural trace would make every O3 row fail for a naming reason. A
// corpus file that cares about `f.name` traces it explicitly as a string, and
// that comparison is kept.

const MAX_STR = 200;
const MAX_DEPTH = 6;
const MAX_ITEMS = 32;

/** Total, cycle-safe, deterministic serialisation of an arbitrary value. */
export function ser(v, depth = 0, seen = new Set()) {
  try {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'bigint') return `${v}n`;
    if (t === 'boolean') return String(v);
    if (t === 'string') return v.length > MAX_STR ? JSON.stringify(v.slice(0, MAX_STR)) + `+${v.length - MAX_STR}` : JSON.stringify(v);
    if (t === 'symbol') return `Symbol(${v.description ?? ''})`;
    if (t === 'function') return `[function/${v.length}]`;
    if (depth >= MAX_DEPTH) return '[depth]';
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const parts = [];
        for (let i = 0; i < Math.min(v.length, MAX_ITEMS); i++) {
          parts.push(i in v ? ser(v[i], depth + 1, seen) : '<hole>');
        }
        if (v.length > MAX_ITEMS) parts.push(`+${v.length - MAX_ITEMS}`);
        return `[${parts.join(',')}]`;
      }
      if (v instanceof Error || (v && typeof v.message === 'string' && typeof v.stack === 'string')) {
        const name = v.constructor && v.constructor.name ? v.constructor.name : 'Error';
        return `${name}: ${v.message}`;
      }
      if (v instanceof Map) {
        const parts = [];
        let n = 0;
        for (const [k, val] of v) { if (n++ >= MAX_ITEMS) { parts.push('...'); break; } parts.push(`${ser(k, depth + 1, seen)}=>${ser(val, depth + 1, seen)}`); }
        return `Map{${parts.join(',')}}`;
      }
      if (v instanceof Set) {
        const parts = [];
        let n = 0;
        for (const val of v) { if (n++ >= MAX_ITEMS) { parts.push('...'); break; } parts.push(ser(val, depth + 1, seen)); }
        return `Set{${parts.join(',')}}`;
      }
      if (typeof Promise !== 'undefined' && v instanceof Promise) return '[promise]';
      if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
      if (v instanceof Date) return `Date(${v.getTime()})`;
      const ctor = v.constructor && v.constructor.name;
      const prefix = ctor && ctor !== 'Object' ? ctor : '';
      const keys = Object.keys(v);
      const parts = [];
      for (let i = 0; i < Math.min(keys.length, MAX_ITEMS); i++) {
        parts.push(`${keys[i]}:${ser(v[keys[i]], depth + 1, seen)}`);
      }
      if (keys.length > MAX_ITEMS) parts.push(`+${keys.length - MAX_ITEMS}`);
      return `${prefix}{${parts.join(',')}}`;
    } finally {
      seen.delete(v);
    }
  } catch (e) {
    return `[unserialisable:${e && e.constructor ? e.constructor.name : 'err'}]`;
  }
}

/**
 * Build the object graph installed as the sandbox global.
 * Returns { globals, records, snapshot() }.
 */
export function createRecorder() {
  const records = [];
  let seq = 0;
  const push = (r) => { if (records.length < 5000) records.push({ seq: seq++, ...r }); };

  const T = (label, ...values) => {
    push({ k: 'T', label: String(label), values: values.map((v) => ser(v)) });
    return values[0];
  };
  // G records every property write and every call made through it, so a corpus
  // file can expose an effect without having to name it.
  const store = {};
  const G = new Proxy(store, {
    set(t, k, v) { push({ k: 'write', key: String(k), value: ser(v) }); t[k] = v; return true; },
    deleteProperty(t, k) { push({ k: 'delete', key: String(k) }); delete t[k]; return true; },
    get(t, k) {
      if (k === 'call') return (name, ...args) => { push({ k: 'call', name: String(name), args: args.map((a) => ser(a)) }); return args[0]; };
      return t[k];
    },
  });
  const logFn = (level) => (...args) => push({ k: 'log', level, args: args.map((a) => ser(a)) });
  const console_ = { log: logFn('log'), info: logFn('log'), warn: logFn('warn'), error: logFn('error'), debug: logFn('log') };

  return {
    records,
    globals: { T, G, console: console_ },
    note(k, extra) { push({ k, ...extra }); },
  };
}

/** The records that count as observable effects for trace equality. */
export const EFFECT_KINDS = ['T', 'write', 'delete', 'call', 'log', 'throw'];

/** Canonical text form of a trace, one record per line. */
export function traceText(records) {
  return records.map((r) => {
    switch (r.k) {
      case 'T': return `T ${r.label} ${r.values.join(' | ')}`;
      case 'write': return `W ${r.key} = ${r.value}`;
      case 'delete': return `D ${r.key}`;
      case 'call': return `C ${r.name}(${r.args.join(', ')})`;
      case 'log': return `L ${r.level} ${r.args.join(' ')}`;
      case 'throw': return `X ${r.value}`;
      case 'done': return `= ${r.completion}`;
      default: return `${r.k} ${JSON.stringify(r)}`;
    }
  }).join('\n');
}

/**
 * Compare two traces.
 *
 * Equality is over the EFFECT records only. The script's own completion value
 * is reported separately (`completion`, `completionMatch`) and deliberately
 * kept out of the verdict: the current emitter wraps the whole program in
 * `function main(){…}`, which changes a script's completion value from `2` to
 * `undefined` without changing anything a caller can observe. Measured in
 * scratch/t3/probe_invokemain.mjs. Pass {includeCompletion:true} to fold it in.
 *
 * Thrown values stay in the primary trace -- an escaped exception is
 * observable, and losing it would be exactly the kind of difference O3 exists
 * to catch.
 */
export function compareTraces(a, b, { includeCompletion = false } = {}) {
  const keep = (rs) => (includeCompletion ? rs : rs.filter((r) => EFFECT_KINDS.includes(r.k)));
  const la = traceText(keep(a)).split('\n').filter((s) => s.length);
  const lb = traceText(keep(b)).split('\n').filter((s) => s.length);
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const equal = la.length === lb.length && i === la.length;
  const completionOf = (rs) => rs.filter((r) => r.k === 'done').map((r) => r.completion).join(' ; ');
  const ca = completionOf(a), cb = completionOf(b);
  return {
    equal,
    counts: [la.length, lb.length],
    commonPrefix: i,
    completion: [ca, cb],
    completionMatch: ca === cb,
    firstDivergence: equal ? null : {
      index: i,
      left: la[i] ?? '<end of trace>',
      right: lb[i] ?? '<end of trace>',
    },
  };
}
