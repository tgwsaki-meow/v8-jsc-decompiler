# CI — what runs where, and why the corpus is not in the repository

Three workflows. The split is not cosmetic: it is the same layering rule as
[ARCHITECTURE.md §11.0](ARCHITECTURE.md), enforced by what each job is allowed
to download.

| workflow | trigger | needs a V8 binary | needs the corpus | runner |
|---|---|---|---|---|
| `selftest.yml` | every push, every PR | no | no | ubuntu + windows |
| `oracle.yml` | push to main, weekly | **yes** (fetched) | no | ubuntu |
| `corpus-scan.yml` | manual only | no | **yes** (fetched at run time) | ubuntu × N shards |

`selftest.yml` is the gate. It runs on the committed profiles, the 270 syntax
fixtures in `corpus/features/` and the 24 `.jsc` files in `tests/t8/fixtures/`,
all of which are ours. It also asserts the layering rule directly — `grep` over
`src/` for an import of `src/verify/` or `tools/` — so the claim "the
decompilation path cannot depend on a real V8" is checked on every push instead
of being re-audited by hand.

It runs on Windows **and** Linux on purpose. Development happens on Windows and
the corpus was produced by a Linux x64 build, so the two together catch a path
separator or a line ending leaking into a decode.

## The corpus stays out of the repository

The corpus is 104 MiB of someone else's compiled JavaScript. Committing it would
be redistributing proprietary software, and a public repository makes that
publication. So:

* `.gitignore` excludes `extracted_jsc/`, `decompiled_js/`, `linuxQQ/` and
  `*.jsc` outside our own fixtures;
* `corpus-scan.yml` fetches the corpus at run time from the `CORPUS_URL`
  secret — a short-lived signed URL to storage the repository owner controls.
  Nothing is cached and the staging directory dies with the runner;
* with `CORPUS_URL` unset the workflow still runs, over the committed fixtures,
  so anyone who clones this can exercise the whole path at small scale.

That keeps the published artefact to what it should be: the tool, the generated
profiles, and our own tests.

## Why sharding, and why twelve

The development host is 2 cores and 4 GB with about 250 MB free. Two concurrent
corpus scans measured **4.2 and 3.4 KiB/s**, i.e. 4.5 and 7.3 hours, and most of
that loss is the two of them starving each other.

A standard Linux runner on a **public** repository is 4 vCPU / 16 GB with free
unlimited minutes; on a private repository it is 2 vCPU / 8 GB against a monthly
allowance. Either is a large improvement, and the public shape is twice the
machine for free.

`tools/ci/shard_corpus.mjs` splits the corpus **by bytes, not by file count**,
because the distribution is badly skewed: 1039 files, 104.0 MiB, and the largest
five are 27.4% of the total. It sorts descending by size and gives each file to
the lightest shard so far — Graham's longest-processing-time rule, within 4/3 of
optimal. Measured at 12 shards:

```
1039 files, 104.0 MiB, 12 shards
balance: largest shard 10.2 MiB, smallest 8.5 MiB, spread 19.5% of the mean

shard  0     1 files    10.2 MiB   biggest: r_8878.jsc
shard  1    57 files     8.5 MiB   biggest: b_nodeXpluginbackground.jsc
shard  2    86 files     8.5 MiB   biggest: b_86background.jsc
...
shard 11   100 files     8.5 MiB   biggest: r_vendorsXvue.jsc
```

**`r_8878.jsc` is 10.2 MiB on its own, so it gets a shard to itself and sets the
floor.** No number of shards beats the time that one file takes; past about
twelve the extra jobs only add queueing. Check the balance before spending
minutes:

```bash
npm run shard:plan                                    # 12 shards
node tools/ci/shard_corpus.mjs --corpus extracted_jsc --shards 24 --plan
```

## How a sharded run merges

One JSON per input file, no shared state, which is what makes sharding work at
all. Each shard uploads its work directory as an artifact; the `merge` job
downloads them all into one directory with `merge-multiple: true` and re-runs
the same scanner with `--merge-only`, which reports over existing results
without running anything.

`--merge-only` takes its file list from the **results**, not from the corpus
directory, so the merge job never stages the 104 MiB. Verified locally before
being committed:

```bash
node tools/ci/shard_corpus.mjs --corpus extracted_jsc --shards 200 --index 7 --out /tmp/shard
node tools/structure/corpus_scan.mjs --corpus /tmp/shard --work /tmp/work --out /tmp/shard.md
node tools/structure/corpus_scan.mjs --merge-only --work /tmp/work --corpus /nonexistent --out /tmp/merged.md
```

The last line is the one that matters: a nonexistent corpus path and a correct
report.

## `oracle.yml` downloads two binaries

```
d8 14.4.258.16  linux64   storage.googleapis.com/chromium-v8   (the corpus's V8)
Electron 40.0.0 linux-x64 github.com/electron/electron/releases
```

Both via the project's own `tools/oracle/fetch_*.mjs`, cached by a key naming
the pinned versions. Electron is there because it ships V8 **14.4.258.16
exactly** and, unlike the local `node`, is a sandboxed pointer-compressed build
— so the `.jsc` it mints is one the corpus's own reader accepts
(ARCHITECTURE.md §9.7). `node --print-bytecode` is not usable for file-level
comparison either: it prints its own bootstrap, 517 functions for a 12-line
file against `d8`'s 2.

Linux is required rather than preferred for this one: `electron.exe` on Windows
is a GUI-subsystem binary with no stdout, so its bytecode listing cannot be
captured at all.

The workflow also **regenerates `profiles/<tag>/ro-heap.json` from a downloaded
snapshot and diffs it against the committed one**. That is the one table the
project cannot derive from source, so a check that it is a function of the
snapshot rather than of the machine that happened to run the tool is worth a
job step. It is a real reproduction and not a tautology: the downloaded Electron
snapshot differs in sha256 from the one the corpus was produced with, and the
two were measured to agree on all 883 addresses the corpus dereferences, with 0
disagreements.
