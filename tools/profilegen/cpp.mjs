// tools/profilegen/cpp.mjs
//
// A small but real C/C++ preprocessor: conditional evaluation
// (#if/#ifdef/#ifndef/#else/#elif/#endif), #define/#undef collection, and
// function-like macro expansion with __VA_ARGS__, ## pasting and # stringising.
//
// Why this exists: the prior probe (scratch/recon/derive_tables.mjs) collected
// *every* #define in a header and kept the last one, so a doubly-defined macro
// such as INTERNALIZED_STRING_LIST_GENERATOR_INTL resolved to the empty #else
// body and 142 Intl internalized-string roots silently vanished
// (scratch/recon/VERSION_PLUGGABILITY.md §3.4). Honouring the conditionals is
// the fix, and it has to be done at #define-collection time, not afterwards.
//
// Scope note: this is not a conforming preprocessor. It does not do #include
// resolution (callers concatenate files in include order), and it does not
// implement recursive-macro blue-painting beyond a simple active-set guard.
// Both are adequate for the declarative macro tables V8 uses for its generated
// lists, and anything it cannot resolve is reported rather than guessed.

/** Strip C and C++ comments while respecting string and char literals. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // keep line count stable
        i++;
      }
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        if (src[i] === '\n') { i++; break; } // unterminated: bail out of the literal
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Join backslash-newline continuations into single logical lines. */
export function spliceLines(src) {
  return src.replace(/\\[ \t]*\r?\n/g, ' ');
}

/** Split a macro argument list on top-level commas. */
export function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '', inStr = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') { cur += s[++i] ?? ''; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

/**
 * Find the index of the ')' matching the '(' at `open`.
 *
 * String and char literals are skipped. That is not a nicety: heap-symbols.h
 * contains `V_(_, close_parenthesis_string, ")")`, and a paren matcher that
 * counts the ')' inside the literal swallows the following entry whole -- which
 * is how `close_parenthesis_string` went missing from the first derivation of
 * this table (1044 roots instead of 1045).
 */
export function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------------------------------------------------------------- #if evaluator

const KEYWORD_VALUES = { true: 1, false: 0 };

/** Tokenise a preprocessor constant expression. */
function tokenizeExpr(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({ t: 'id', v: s.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === '0' && /[xX]/.test(s[i + 1] ?? '')) {
        j = i + 2;
        while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
        toks.push({ t: 'num', v: Number(s.slice(i, j)) });
      } else {
        while (j < s.length && /[0-9]/.test(s[j])) j++;
        toks.push({ t: 'num', v: Number(s.slice(i, j)) });
      }
      while (j < s.length && /[uUlL]/.test(s[j])) j++; // integer suffixes
      i = j; continue;
    }
    if (c === "'") { // character literal
      let j = i + 1, val = 0;
      if (s[j] === '\\') { j++; const e = s[j++]; val = ({ n: 10, t: 9, r: 13, '0': 0 })[e] ?? e.charCodeAt(0); }
      else val = s.charCodeAt(j++);
      if (s[j] === "'") j++;
      toks.push({ t: 'num', v: val });
      i = j; continue;
    }
    const three = s.slice(i, i + 3);
    const two = s.slice(i, i + 2);
    if (['<<=', '>>='].includes(three)) { toks.push({ t: 'op', v: three }); i += 3; continue; }
    if (['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    toks.push({ t: 'op', v: c });
    i++;
  }
  return toks;
}

const BINARY_PRECEDENCE = {
  '*': 10, '/': 10, '%': 10,
  '+': 9, '-': 9,
  '<<': 8, '>>': 8,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '==': 6, '!=': 6,
  '&': 5, '^': 4, '|': 3,
  '&&': 2, '||': 1,
};

/**
 * Evaluate a tokenised constant expression.
 * `unknown` collects identifiers that survived macro expansion (they evaluate
 * to 0, which is what the C standard says, but we want them reported).
 */
function parseExpr(toks, unknown) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function primary() {
    const t = next();
    if (!t) return 0;
    if (t.t === 'num') return t.v;
    if (t.t === 'id') {
      if (t.v in KEYWORD_VALUES) return KEYWORD_VALUES[t.v];
      unknown.add(t.v);
      return 0;
    }
    if (t.v === '(') {
      const v = ternary();
      if (peek() && peek().v === ')') next();
      return v;
    }
    if (t.v === '!') return primary() ? 0 : 1;
    if (t.v === '~') return ~primary();
    if (t.v === '-') return -primary();
    if (t.v === '+') return +primary();
    return 0;
  }

  function binary(minPrec) {
    let lhs = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op') break;
      const prec = BINARY_PRECEDENCE[t.v];
      if (prec === undefined || prec < minPrec) break;
      next();
      // short-circuit semantics matter: && / || must not evaluate div-by-zero rhs
      const rhs = binary(prec + 1);
      switch (t.v) {
        case '*': lhs = lhs * rhs; break;
        case '/': lhs = rhs === 0 ? 0 : Math.trunc(lhs / rhs); break;
        case '%': lhs = rhs === 0 ? 0 : lhs % rhs; break;
        case '+': lhs = lhs + rhs; break;
        case '-': lhs = lhs - rhs; break;
        case '<<': lhs = lhs << rhs; break;
        case '>>': lhs = lhs >> rhs; break;
        case '<': lhs = lhs < rhs ? 1 : 0; break;
        case '>': lhs = lhs > rhs ? 1 : 0; break;
        case '<=': lhs = lhs <= rhs ? 1 : 0; break;
        case '>=': lhs = lhs >= rhs ? 1 : 0; break;
        case '==': lhs = lhs === rhs ? 1 : 0; break;
        case '!=': lhs = lhs !== rhs ? 1 : 0; break;
        case '&': lhs = lhs & rhs; break;
        case '^': lhs = lhs ^ rhs; break;
        case '|': lhs = lhs | rhs; break;
        case '&&': lhs = (lhs && rhs) ? 1 : 0; break;
        case '||': lhs = (lhs || rhs) ? 1 : 0; break;
        default: break;
      }
    }
    return lhs;
  }

  function ternary() {
    const cond = binary(1);
    if (peek() && peek().v === '?') {
      next();
      const a = ternary();
      if (peek() && peek().v === ':') next();
      const b = ternary();
      return cond ? a : b;
    }
    return cond;
  }

  return ternary();
}

// ---------------------------------------------------------------- macro expansion

/**
 * Expand macro invocations in `text`.
 * `leaf` names are never expanded (they are the callback placeholders such as V
 * or ENTRY that we want to see in the output).
 */
export function expandMacros(text, macros, leaf = new Set(), opts = {}) {
  const maxDepth = opts.maxDepth ?? 200;
  const unexpanded = opts.unexpanded ?? new Set();

  function once(src, active) {
    let out = '';
    let i = 0;
    let changed = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'") { // copy literals verbatim
        const q = ch;
        out += ch; i++;
        while (i < src.length) {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
          out += src[i];
          if (src[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      if (!/[A-Za-z_]/.test(ch)) { out += ch; i++; continue; }
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const name = src.slice(i, j);
      const def = macros.get(name);
      if (!def || leaf.has(name) || active.has(name)) { out += name; i = j; continue; }
      if (def.params === null) {
        out += ' ' + def.body + ' ';
        i = j; changed = true; continue;
      }
      // function-like: needs a '(' next (whitespace allowed)
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] !== '(') { out += name; i = j; continue; }
      const close = matchParen(src, k);
      if (close < 0) { out += name; i = j; continue; }
      const args = splitArgs(src.slice(k + 1, close));
      out += ' ' + substitute(def, args, active, name) + ' ';
      i = close + 1;
      changed = true;
    }
    return { out, changed };
  }

  function substitute(def, args, active, selfName) {
    const named = def.variadic ? def.params.slice(0, -1) : def.params;
    const varArgs = def.variadic ? args.slice(named.length).join(', ') : '';
    let body = def.body;

    // Tokenwise substitution so that `name##_accessor` and `#name` both work.
    let out = '';
    let i = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '"' || ch === "'") {
        const q = ch; out += ch; i++;
        while (i < body.length) {
          if (body[i] === '\\') { out += body[i] + (body[i + 1] ?? ''); i += 2; continue; }
          out += body[i];
          if (body[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      if (ch === '#' && body[i + 1] === '#') { out += '\u0000PASTE\u0000'; i += 2; continue; }
      if (ch === '#') { // stringise next parameter
        let k = i + 1;
        while (k < body.length && /\s/.test(body[k])) k++;
        let m = k;
        while (m < body.length && /[A-Za-z0-9_]/.test(body[m])) m++;
        const pname = body.slice(k, m);
        const idx = named.indexOf(pname);
        if (idx >= 0) { out += JSON.stringify(args[idx] ?? ''); i = m; continue; }
        if (pname === '__VA_ARGS__') { out += JSON.stringify(varArgs); i = m; continue; }
        out += ch; i++; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let m = i;
        while (m < body.length && /[A-Za-z0-9_]/.test(body[m])) m++;
        const id = body.slice(i, m);
        const idx = named.indexOf(id);
        if (idx >= 0) out += args[idx] ?? '';
        else if (id === '__VA_ARGS__') out += varArgs;
        else out += id;
        i = m; continue;
      }
      out += ch; i++;
    }
    // apply ## pastes
    out = out.replace(/\s*\u0000PASTE\u0000\s*/g, '');
    const nextActive = new Set(active); nextActive.add(selfName);
    return expandBody(out, nextActive);
  }

  function expandBody(src, active, depth = 0) {
    if (depth > maxDepth) return src;
    const r = once(src, active);
    return r.changed ? expandBody(r.out, active, depth + 1) : r.out;
  }

  const result = expandBody(text, new Set());
  // report list-macro-looking identifiers that never resolved
  for (const m of result.matchAll(/\b([A-Z][A-Z0-9_]{3,})\s*\(/g)) {
    if (!macros.has(m[1]) && !leaf.has(m[1])) unexpanded.add(m[1]);
  }
  return result;
}

// ---------------------------------------------------------------- the driver

/**
 * A preprocessing context: a defines map that survives across files, so that
 * callers can feed headers in #include order.
 */
export class Cpp {
  /** @param {Record<string, string|number>} initialDefines */
  constructor(initialDefines = {}) {
    this.macros = new Map();
    /** identifiers that appeared in a #if but were never defined */
    this.unknownInConditions = new Set();
    /** names referenced as FOO(...) in expanded output but never defined */
    this.unexpanded = new Set();
    for (const [k, v] of Object.entries(initialDefines)) {
      if (v === null || v === undefined) continue;
      this.define(k, String(v));
    }
  }

  define(name, body = '1', params = null, variadic = false) {
    this.macros.set(name, { params, body, variadic });
  }

  undef(name) { this.macros.delete(name); }

  isDefined(name) { return this.macros.has(name); }

  /** Evaluate a #if / #elif expression. */
  evalCondition(expr) {
    // `defined X` / `defined(X)` must be resolved before macro expansion
    let e = expr.replace(/\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => (this.macros.has(n) ? '1' : '0'))
      .replace(/\bdefined\s+([A-Za-z_]\w*)/g, (_, n) => (this.macros.has(n) ? '1' : '0'));
    e = expandMacros(e, this.macros, new Set(), { unexpanded: new Set() });
    // __has_include / __has_attribute / __has_builtin: not modelled -> 0
    e = e.replace(/__has_(include|attribute|builtin|feature|cpp_attribute)\s*\(([^()]|\([^()]*\))*\)/g, '0');
    const toks = tokenizeExpr(e);
    const unknown = new Set();
    const v = parseExpr(toks, unknown);
    for (const u of unknown) this.unknownInConditions.add(u);
    return v !== 0;
  }

  /**
   * Run the preprocessor over one translation unit fragment.
   * Returns the text of the lines that survived conditional compilation
   * (directives removed). #define/#undef mutate this.macros.
   */
  run(rawText, { label = '<text>', onLine = null } = {}) {
    const text = spliceLines(stripComments(rawText));
    const lines = text.split(/\r?\n/);
    const out = [];
    // stack of {parentActive, taken, active}
    const stack = [];
    const active = () => stack.every((s) => s.active);

    for (const line of lines) {
      const d = /^[ \t]*#[ \t]*(\w+)[ \t]*(.*)$/.exec(line);
      if (!d) {
        if (active()) {
          out.push(line);
          // The hook sees each active line *with the macro table as it stands at
          // that point*. That matters because these headers do
          //   #define FIELD_LIST(V) ... / DEFINE_FIELD_OFFSET_CONSTANTS(...) / #undef FIELD_LIST
          // several times in one file, so the list has to be expanded where it
          // is used, not after the whole file has been read.
          if (onLine) onLine(line, this);
        }
        continue;
      }
      const [, directive, rest] = d;
      switch (directive) {
        case 'if':
        case 'ifdef':
        case 'ifndef': {
          const parentActive = active();
          let cond = false;
          if (parentActive) {
            if (directive === 'if') cond = this.evalCondition(rest);
            else {
              const n = (rest.trim().match(/^[A-Za-z_]\w*/) || [''])[0];
              cond = directive === 'ifdef' ? this.macros.has(n) : !this.macros.has(n);
            }
          }
          stack.push({ parentActive, taken: cond, active: parentActive && cond });
          break;
        }
        case 'elif': {
          const top = stack[stack.length - 1];
          if (!top) break;
          if (top.taken) { top.active = false; }
          else {
            const cond = top.parentActive ? this.evalCondition(rest) : false;
            top.taken = cond;
            top.active = top.parentActive && cond;
          }
          break;
        }
        case 'else': {
          const top = stack[stack.length - 1];
          if (!top) break;
          top.active = top.parentActive && !top.taken;
          if (top.active) top.taken = true;
          break;
        }
        case 'endif':
          stack.pop();
          break;
        case 'define': {
          if (!active()) break;
          const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?[ \t]*([\s\S]*)$/.exec(rest.trim());
          if (!m) break;
          const name = m[1];
          if (m[2] !== undefined) {
            const params = m[3].split(',').map((p) => p.trim()).filter(Boolean);
            const variadic = params.length > 0 && params[params.length - 1] === '...';
            const ps = variadic ? [...params.slice(0, -1), '__VA_ARGS__'] : params;
            this.define(name, m[4].trim(), ps, variadic);
          } else {
            this.define(name, m[4].trim(), null, false);
          }
          break;
        }
        case 'undef':
          if (active()) this.undef((rest.trim().match(/^[A-Za-z_]\w*/) || [''])[0]);
          break;
        case 'include':
        case 'pragma':
        case 'error':
        case 'warning':
        case 'line':
        default:
          break;
      }
    }
    if (stack.length) {
      throw new Error(`unbalanced #if in ${label} (depth ${stack.length})`);
    }
    return out.join('\n');
  }

  /** Expand `text` using the current macro table. */
  expand(text, leaf = new Set(['V'])) {
    return expandMacros(text, this.macros, leaf instanceof Set ? leaf : new Set(leaf), { unexpanded: this.unexpanded });
  }

  /**
   * Expand `LIST(CB)` and return every `CB(...)` invocation's argument list,
   * in order.
   */
  expandList(listExpr, cb = 'V') {
    const expanded = this.expand(listExpr, new Set([cb]));
    return collectCalls(expanded, cb);
  }
}

/** Collect the argument lists of every `cb(...)` call in `text`, in order. */
export function collectCalls(text, cb) {
  const out = [];
  const re = new RegExp(`\\b${cb}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) break;
    out.push(splitArgs(text.slice(open + 1, close)));
    re.lastIndex = close;
  }
  return out;
}

/** Evaluate a C++ integer constant expression given a map of known constants. */
export function evalIntExpr(expr, constants = {}) {
  let e = String(expr)
    .replace(/\bstatic_cast\s*<[^>]*>\s*/g, '')
    .replace(/\bint\s*\{/g, '{')
    .replace(/\b(\d+)[uUlL]+\b/g, '$1');
  // substitute known constants until fixed point
  for (let pass = 0; pass < 24; pass++) {
    let changed = false;
    e = e.replace(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\b/g, (id) => {
      const key = id.includes('::') ? id.split('::').pop() : id;
      if (id in constants) { changed = true; return `(${constants[id]})`; }
      if (key in constants) { changed = true; return `(${constants[key]})`; }
      return id;
    });
    if (!changed) break;
  }
  const unknown = new Set();
  const v = parseExpr(tokenizeExpr(e), unknown);
  return { value: v, unknown: [...unknown].filter((u) => !(u in KEYWORD_VALUES)) };
}
