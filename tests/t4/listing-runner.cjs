// tests/t4/listing-runner.cjs
//
//   node --print-bytecode [...] tests/t4/listing-runner.cjs <source.js>
//
// Compiles the source the *same way* make-cache.cjs does -- `new vm.Script`,
// i.e. a bare classic script -- so that the listing and the `.jsc` describe the
// same program.
//
// Running the file directly instead would compile it as a CommonJS module,
// which node wraps in
//   (function (exports, require, module, __filename, __dirname) { ... })
// That wrapper turns every top-level `var` from a global property into a
// function local, which changes the bytecode of any inner function that reads
// one (LdaGlobal becomes a context or register load). Those functions would
// then never match, for a reason that has nothing to do with the decoder.

const fs = require('fs');
const vm = require('vm');

const srcPath = process.argv[2];
const source = fs.readFileSync(srcPath, 'utf8');
// Compile only. Executing would run the sources' bottom-of-file calls, which
// is unnecessary under --no-lazy and would add node's own lazily compiled
// internals to the listing.
new vm.Script(source, { filename: srcPath });
