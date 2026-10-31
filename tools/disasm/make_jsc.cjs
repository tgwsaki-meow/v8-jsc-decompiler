// tools/disasm/make_jsc.cjs
//
// Produce a real V8 code cache (.jsc) for one source file, using whatever
// engine runs this script. CommonJS on purpose: it has to load under the
// repo's "type": "module" package.json and under Electron's
// ELECTRON_RUN_AS_NODE node shim without either treating it as an ES module.
//
//   node --no-lazy --no-enable-lazy-source-positions \
//        tools/disasm/make_jsc.cjs <in.js> <out.jsc>
//
// --no-lazy makes V8 compile the inner functions, so their BytecodeArrays are
// in the graph CodeSerializer walks; --no-enable-lazy-source-positions makes it
// build the source position tables, which are otherwise absent from the cache.
// Both flags must match the flags the listing engine is run with.

const fs = require('fs');
const vm = require('vm');

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('usage: make_jsc.cjs <in.js> <out.jsc>');
  process.exit(2);
}

const source = fs.readFileSync(inFile, 'utf8');
const script = new vm.Script(source, { filename: inFile });
const data = script.createCachedData();
fs.writeFileSync(outFile, data);
fs.writeFileSync(outFile + '.meta.json', JSON.stringify({
  v8: process.versions.v8,
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  sourceLength: source.length,
  cacheLength: data.length,
  argv: process.execArgv,
}, null, 1));
console.log(`${outFile} ${data.length} bytes (v8 ${process.versions.v8})`);
