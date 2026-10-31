# rules/ — the prototype's hand-made tables, kept as independent oracles

Everything the decompiler actually runs on lives in `profiles/<tag>/`, generated
by `tools/profilegen/` from pinned upstream V8 sources
(docs/ARCHITECTURE.md §1.2, §3). These files are from the earlier prototype and
are **not on the read path**. They are kept because two of them are useful as
*independent* checks — a table produced by a different method, years apart,
agreeing with the generated one is worth more than any self-consistency test.

| file | what it is | who reads it |
|---|---|---|
| `v8-14.4.258.16.json` | opcode + operand table, hand-assembled | `tools/profilegen/selftest.mjs`, as the independent opcode oracle |
| `v8-ro-heap.json` | 3182 read-only strings, scraped from a binary that no longer exists | `tools/metrics/collect/ro_refs.mjs`, as the "before" number for metric 9 |
| `v8-roots-14.4.258.16.json` | root list, scraped | nothing; kept for the record |

Two warnings that cost real time to learn, recorded here so the files are not
mistaken for authorities:

1. **`v8-roots-*.json` and `v8-ro-heap.json` are how this project got two wrong
   tables.** They were scraped from a binary and checked in, so there was no way
   to tell which V8 build they described. ARCHITECTURE.md §7 forbids doing it
   again. `v8-ro-heap.json` resolves 3182 strings; the generated
   `profiles/14.4.258.16/ro-heap.json` resolves 10299 objects and 883/883 of the
   references the corpus actually uses.
2. **`rules/raw/` was V8 12.8.374.38, not 14.4.258.16** — a four-minor-version
   gap, in which root indices diverge from index 647 and six comparison
   bytecodes change operand width. It is gitignored: nothing reads it, and
   `tools/profilegen/selftest.mjs` has a check that asserts no generated profile
   cites a path under it. The correctly pinned sources are fetched on demand
   into `.v8src-cache/` and recorded with a sha256 in `profiles/<tag>/meta.json`.
