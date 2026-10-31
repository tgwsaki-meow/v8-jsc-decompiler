// tests/t4/make-cache.cjs
//
//   node [v8 flags] tests/t4/make-cache.cjs <source.js> <out.jsc>
//
// Produces a real code cache for the V8 of the node that runs it, by the same
// route the acceptance harness compares against: compile the file's text as a
// classic sloppy script and ask V8 for its cached data.
//
// Deliberately does NOT run the script. Under --no-lazy every function is
// compiled during `new vm.Script`, so running adds nothing; without --no-lazy,
// not running is what leaves inner functions with UncompiledData and no
// BytecodeArray, which is the lazy hole the front end has to report.

const fs = require('fs');
const vm = require('vm');

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error('usage: make-cache.cjs <source.js> <out.jsc>');
  process.exit(2);
}
const source = fs.readFileSync(srcPath, 'utf8');
const script = new vm.Script(source, { filename: srcPath });
const data = script.createCachedData();
fs.writeFileSync(outPath, data);
process.stdout.write(JSON.stringify({
  v8: process.versions.v8,
  sourceLength: source.length,
  cacheBytes: data.length,
}) + '\n');
