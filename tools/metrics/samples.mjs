// Sample definitions for the dashboard, in one place, so every number in
// docs/METRICS.md can say exactly which files produced it.
//
// Two of the samples are deliberately IDENTICAL to the ones BASELINE_AUDIT.md
// used, formula included, because the first job of the dashboard is to
// reproduce the baseline. Where a sample differs, the doc says so.
//
//   quick   minutes. Reproduces the baseline samples for the cheap metrics and
//           uses a small, named set of inputs for the expensive ones.
//   full    hours. Wider samples; the liveness set becomes a superset of the
//           baseline's 12 inputs so the comparison stays apples to apples.
//
// The stratified formula is the baseline's: sort by size ascending, then take
// index floor(((i + 0.5) / n) * len) for i in 0..n-1, dropping duplicates.
// It is deterministic, so a re-run samples the same files.

import fs from 'node:fs';
import path from 'node:path';

export const JSC_DIR = 'extracted_jsc';
export const OUT_DIR = 'decompiled_js';

export function listBySize(dir, pred = () => true) {
  return fs.readdirSync(dir)
    .filter((f) => pred(f))
    .map((f) => ({ name: f, path: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
}

export function stratified(list, n) {
  const picks = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(list.length - 1, Math.floor(((i + 0.5) / n) * list.length));
    if (!picks.some((p) => p.name === list[idx].name)) picks.push(list[idx]);
  }
  return picks;
}

/** metrics 1-3, 10: bytecode side and output side must be the SAME files. */
export function controlFlowSample(mode) {
  const all = listBySize(JSC_DIR, (f) => f.endsWith('.jsc'));
  const n = mode === 'full' ? 120 : 20;
  return {
    files: stratified(all, n),
    description: `${n} size-stratified .jsc from ${JSC_DIR}/ (${mode === 'quick' ? 'identical to BASELINE_AUDIT.md 5.4' : 'wider than the baseline 20'}), each paired with its own ${OUT_DIR}/*.js`,
  };
}

/** metric 5: the baseline took every other file of the 40 smallest. */
export function identifierSample(mode) {
  const all = listBySize(OUT_DIR, (f) => f.endsWith('.js'));
  const take = mode === 'full' ? 120 : 40;
  return {
    files: all.slice(0, take).filter((_, i) => i % 2 === 0),
    description: `every other file of the ${take} smallest ${OUT_DIR}/*.js (${mode === 'quick' ? 'identical to BASELINE_AUDIT.md 5.3' : 'wider'})`,
  };
}

/** metrics 7-8: the baseline window was (1 KB, 400 KB]. */
export function hazardSample(mode) {
  const all = listBySize(OUT_DIR, (f) => f.endsWith('.js')).filter((x) => x.size > 1000 && x.size <= 400_000);
  const n = mode === 'full' ? 120 : 40;
  return {
    files: stratified(all, n),
    description: `${n} size-stratified ${OUT_DIR}/*.js in (1 KB, 400 KB] (${mode === 'quick' ? 'identical to BASELINE_AUDIT.md 5.5' : 'wider'})`,
  };
}

/**
 * metrics 6, 9, 11: these re-run the pipeline, so the sample is the budget.
 *
 * BASELINE_AUDIT.md 3.1 used exactly these 12: the 3 smallest, 3 around the
 * median, the 3 largest, and 3 named files. Two of the largest time out and
 * two more take 90-170 s, which is why --quick does not use them.
 */
export const BASELINE_LIVENESS = [
  'r_73065.jsc', 'r_82276.jsc', 'r_loginXapp.jsc',
  'r_commonNodeModuleXxmlXjs.jsc', 'r_98447.jsc', 'r_8305.jsc',
  'b_86background.jsc', 'b_nodeXpluginbackground.jsc', 'r_8878.jsc',
  'b_background.jsc', 'internal_index.jsc', 'p_preload.jsc',
];

export function livenessSample(mode) {
  const all = listBySize(JSC_DIR, (f) => f.endsWith('.jsc'));
  const byName = new Map(all.map((x) => [x.name, x]));
  if (mode === 'full') {
    const files = BASELINE_LIVENESS.map((n) => byName.get(n)).filter(Boolean);
    const extra = stratified(all.filter((x) => !BASELINE_LIVENESS.includes(x.name)), 12);
    return {
      files: [...files, ...extra],
      baselineNames: BASELINE_LIVENESS,
      description: `the 12 inputs of BASELINE_AUDIT.md 3.1 (so metric 6 is comparable) plus 12 more size-stratified inputs`,
    };
  }
  // quick: small and median only, plus internal_index.jsc, which is 3.4 KB and
  // still takes ~20 s -- the cheapest proof that cost is not size-driven.
  const small = stratified(all.filter((x) => x.size <= 32_000), 11);
  const named = byName.get('internal_index.jsc');
  const files = named && !small.some((x) => x.name === named.name) ? [...small, named] : small;
  return {
    files,
    baselineNames: [],
    description: '11 size-stratified .jsc of at most 32 KB plus internal_index.jsc (3.4 KB, ~20 s). Chosen to finish in minutes: the baseline 12 include two 180 s timeouts and three files over 85 s, which belong to --full',
  };
}

export function describeSamples(mode) {
  return {
    mode,
    controlFlow: controlFlowSample(mode).description,
    identifiers: identifierSample(mode).description,
    hazards: hazardSample(mode).description,
    liveness: livenessSample(mode).description,
  };
}
