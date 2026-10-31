// One decompile, one process. Writes the row as JSON and the emitted code as a
// separate file, so a 100 MB output never has to go through JSON or a pipe.
//
// argv: <jscPath> <resultJsonPath> <codePath>   [--pipeline=<module>]
import fs from 'node:fs';
import path from 'node:path';
import { decompile } from './pipeline.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [jscPath, resultPath, codePath] = args.filter((a) => !a.startsWith('--'));
const moduleFlag = flags.find((f) => f.startsWith('--pipeline='));

const row = await decompile(jscPath, { module: moduleFlag ? moduleFlag.slice('--pipeline='.length) : undefined });
const code = row.code ?? '';
delete row.code;
// perFunction carries the full text of every function; keep the shape but drop
// the bodies from the JSON (the code file has them).
row.perFunction = (row.perFunction ?? []).map((f) => ({ index: f.index, name: f.name, bytes: f.bytes, start: undefined }));

fs.mkdirSync(path.dirname(resultPath), { recursive: true });
if (codePath) {
  fs.mkdirSync(path.dirname(codePath), { recursive: true });
  fs.writeFileSync(codePath, code, 'utf8');
}
fs.writeFileSync(resultPath, JSON.stringify(row), 'utf8');
