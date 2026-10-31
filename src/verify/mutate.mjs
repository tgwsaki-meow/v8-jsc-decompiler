// Source mutations for the oracles' discrimination checks.
//
// Both O1 and O3 need a negative control: an oracle that always answers
// "match" passes every identity check, so each one has to be shown rejecting a
// program that really is different. The mutations below are deliberately
// minimal (one literal, one operator) because the interesting failure is an
// oracle too coarse to see a one-token change.
//
// Two honest caveats, both handled by trying candidates in order rather than
// trusting the first one:
//
//   * a mutation need not be OBSERVABLE: `out.unshift(x)` on an empty array
//     behaves exactly like `out.push(x)`, so a trace check has to keep going.
//   * a mutation need not be VISIBLE IN BYTECODE: V8 prints an array literal
//     as `<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS, <FixedArray[3]>>`
//     and never prints the element values, so changing `[1,2,3]` to `[2,2,3]`
//     is invisible to O1 on either engine (tools/probes/probe_pool.mjs).
//
// The last candidate -- appending one extra observable call -- is guaranteed
// visible to both, so "no candidate was detected" always means a real oracle
// defect rather than an unlucky mutation.

const OPERATOR_SWAPS = [
  [' + ', ' - '], [' < ', ' > '], [' === ', ' !== '], [' * ', ' + '],
  [' && ', ' || '], [' ?? ', ' || '], ['.push(', '.unshift('],
];

/** Index just past the leading `//` comment block, so mutations hit code. */
function skipHeader(src) {
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const line = src.slice(i, nl < 0 ? src.length : nl).trim();
    if (line.startsWith('//') || line === '') { i = nl < 0 ? src.length : nl + 1; continue; }
    break;
  }
  return i;
}

function bumpNumber(src, from) {
  const re = /(^|[^\w$.])(\d+)(?![\w$n])/;
  const m = re.exec(src.slice(from));
  if (!m) return null;
  const at = from + m.index + m[1].length;
  return { label: `literal ${m[2]} -> ${Number(m[2]) + 1}`, src: src.slice(0, at) + String(Number(m[2]) + 1) + src.slice(at + m[2].length) };
}

function tweakString(src, from) {
  const re = /(['"])([A-Za-z_][A-Za-z0-9_]{0,30})\1/;
  const m = re.exec(src.slice(from));
  if (!m) return null;
  const at = from + m.index;
  const replaced = `${m[1]}${m[2]}X${m[1]}`;
  return { label: `string "${m[2]}" -> "${m[2]}X"`, src: src.slice(0, at) + replaced + src.slice(at + m[0].length) };
}

/** Candidate single-token mutations, most-likely-detectable first. */
export function mutations(src) {
  const from = skipHeader(src);
  const out = [];
  const n = bumpNumber(src, from);
  if (n) out.push(n);
  const s = tweakString(src, from);
  if (s) out.push(s);
  for (const [a, b] of OPERATOR_SWAPS) {
    const i = src.indexOf(a, from);
    if (i >= 0) out.push({ label: `${a.trim()} -> ${b.trim()}`, src: src.slice(0, i) + b + src.slice(i + a.length) });
  }
  const t = src.indexOf('true', from);
  if (t >= 0) out.push({ label: 'true -> false', src: src.slice(0, t) + 'false' + src.slice(t + 4) });
  // guaranteed visible to both oracles: one extra observable call
  out.push({ label: 'appended an extra T() call', src: src.replace(/\s*$/, '\n') + "T('__mutation__', 1);\n" });
  return out;
}

/** The first candidate, or null when the source has nothing to mutate. */
export function mutate(src) {
  const m = mutations(src);
  return m.length ? m[0].src : null;
}
