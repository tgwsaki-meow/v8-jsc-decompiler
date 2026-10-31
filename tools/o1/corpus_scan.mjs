// tools/o1/corpus_scan.mjs
//
// The `o1` layer of the corpus scan. This file exists only so that the corpus
// repository's workflow can reach the O1 oracle through the one command shape
// it already uses for every other layer:
//
//     node tools/<layer>/corpus_scan.mjs --corpus … --work … --out … \
//          --jobs 1 --child-heap N --timeout S
//     node tools/<layer>/corpus_scan.mjs --merge-only --work … --out …
//
// `tools/verify/o1_corpus.mjs` already takes exactly those flags, with exactly
// those meanings (`--timeout` in SECONDS, `--child-heap` in MB -- the
// mismatch that cost a whole cloud run is why that spelling is shared rather
// than re-invented). So this is a dispatch and not a wrapper: the dynamic
// import runs the real runner in THIS process, with THIS argv, so there is no
// second flag parser to drift out of step with the first.
//
// The one thing O1 needs that no other layer does is a minter: stream B is our
// own output compiled back to a .jsc, and it must be compiled by the corpus's
// own V8 (14.4.258.16 = Electron 40) or the comparison measures the gap
// between two V8 versions instead of measuring the decompiler. The runner
// exits 2 and says so when the binary is absent, rather than falling back to
// the host's node -- so the workflow's job is to run
//
//     node tools/oracle/fetch_electron.mjs 40.0.0 linux-x64 --binary
//
// first. Nothing from the corpus is executed on this path; see
// `src/verify/o1_corpus.mjs` for the asserts that enforce that.

await import('../verify/o1_corpus.mjs');
