import fs from 'fs';
import path from 'path';

const files = fs.readdirSync('decompiled_js');
const businessStrings = new Set();
const protocolsAndApis = new Set();
const configAndProperties = new Set();

for (const file of files.slice(0, 100)) {
  const content = fs.readFileSync(path.join('decompiled_js', file), 'utf8');
  const matches = content.match(/"([^"\\]{4,80})"/g);
  if (!matches) continue;

  for (let m of matches) {
    const s = m.slice(1, -1);
    if (s.includes('Decompiled from') || s.includes('VersionHash')) continue;

    if (s.startsWith('http') || s.includes('://') || s.includes('/') || s.includes('\\')) {
      protocolsAndApis.add(s);
    } else if (s.includes('get') || s.includes('set') || s.includes('on') || s.includes('Handle') || s.includes('Path') || s.includes('Config')) {
      configAndProperties.add(s);
    } else if (s.length >= 5) {
      businessStrings.add(s);
    }
  }
}

console.log('=== Sample of Extracted Business & Semantic Strings ===');
console.log('\n[1] Protocol / URLs / Path Literals:');
console.log(Array.from(protocolsAndApis).slice(0, 15));

console.log('\n[2] Methods / Handlers / Business Properties:');
console.log(Array.from(configAndProperties).slice(0, 20));

console.log('\n[3] Domain / Business Vocabulary:');
console.log(Array.from(businessStrings).slice(0, 25));
