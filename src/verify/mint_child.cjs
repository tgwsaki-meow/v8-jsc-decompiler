// Minting helper, run by whichever engine is producing the .jsc (Electron's
// node, the local node, or any other node-compatible binary). CommonJS so it
// loads identically regardless of the nearest package.json "type".
//
// argv: <srcPath> <outPath> <script|module>
//
// Compiles only. Nothing here executes the source... with one exception that
// has to be stated: vm.SourceTextModule.createCachedData() is only legal
// before evaluation, so the module path links nothing and evaluates nothing.
const fs = require('fs');
const vm = require('vm');

const [srcPath, outPath, kind] = process.argv.slice(2);
const src = fs.readFileSync(srcPath, 'utf8');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

try {
  let cd;
  if (kind === 'module') {
    if (typeof vm.SourceTextModule !== 'function') {
      out({ ok: false, error: 'vm.SourceTextModule unavailable' });
      process.exit(3);
    }
    const m = new vm.SourceTextModule(src, { identifier: srcPath });
    cd = m.createCachedData();
  } else {
    const s = new vm.Script(src, { filename: srcPath, produceCachedData: true });
    cd = s.cachedData || s.createCachedData();
  }
  fs.writeFileSync(outPath, cd);
  out({ ok: true, node: process.version, v8: process.versions.v8, bytes: cd.length, srcLen: src.length });
} catch (e) {
  out({ ok: false, node: process.version, v8: process.versions.v8, error: `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}` });
  process.exit(2);
}
