# references/

Prior art, read while building this project. **Not redistributed here** — this
directory is gitignored.

## view8

A V8 `.jsc` decompiler in Python, by Yaniv Hasbani / Check Point Research.
Upstream: <https://github.com/suidpit/view8> (and the Check Point Research
write-up it accompanies).

It was read for two things:

* the overall shape of the problem (cache header → deserialised objects →
  bytecode → source), which it gets right;
* its handling of the constant pool and its `Translate/` pass, which is the
  closest prior work to this project's `src/recover/`.

Where this project diverges, and why, is in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): every table here is
mechanically derived per V8 version from pinned upstream sources rather than
hand-maintained, and the back end goes through SSA with a real dominator tree
rather than per-block heuristics.

To read it yourself:

```
git clone https://github.com/suidpit/view8 references/view8
```
