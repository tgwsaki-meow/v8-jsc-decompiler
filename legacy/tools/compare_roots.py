import re
import io
from pcpp import Preprocessor

with open('rules/raw/static-roots.h', 'r', encoding='utf-8') as f:
    text = f.read()

table_match = re.search(r'StaticReadOnlyRootsPointerTable = \{([\s\S]*?)\};', text)
sr_entries = re.findall(r'StaticReadOnlyRoot::k([a-zA-Z0-9_]+)', table_match.group(1))

def read_clean(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = re.sub(r'^\s*#\s*include.*', '// [include removed]', content, flags=re.MULTILINE)
    return content

h_symbols = read_clean('rules/raw/heap-symbols.h')
h_accessors = read_clean('rules/raw/accessors.h')
h_objs = read_clean('rules/raw/objects-definitions.h')
h_roots = read_clean('rules/raw/roots.h')

combined = f"""
#define V8_INTL_SUPPORT 1
#define V8_ENABLE_WEBASSEMBLY 1
#define IF_WASM(V, ...) V(__VA_ARGS__)
#define IF_FUNCTION_ARGUMENTS_CALLER_ARE_OWN_PROPS(...)

{h_symbols}
{h_accessors}
{h_objs}
{h_roots}

#define DUMP_ENTRY(type, name, CamelName) ENTRY(#name, #CamelName)
ROOT_LIST(DUMP_ENTRY)
"""

p = Preprocessor()
p.parse(combined)
out = io.StringIO()
p.write(out)
root_entries = re.findall(r'ENTRY\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)', out.getvalue())

print(f"StaticReadOnlyRootsPointerTable count: {len(sr_entries)}")
print(f"ROOT_LIST count: {len(root_entries)}")

for i in range(min(len(sr_entries), len(root_entries))):
    sr = sr_entries[i]
    r_name, r_camel = root_entries[i]
    sr_clean = sr.replace('_string', '').replace('_symbol', '').replace('Map', '').lower()
    r_clean = r_camel.replace('_string', '').replace('_symbol', '').replace('Map', '').lower()
    if sr_clean != r_clean:
        print(f"First mismatch at index {i}: StaticRoot={sr}, ROOT_LIST={r_name} / {r_camel}")
        for j in range(max(0, i-3), min(len(sr_entries), i+10)):
            print(f"  [{j}] Static: {sr_entries[j]} | ROOT_LIST: {root_entries[j][0]} ({root_entries[j][1]})")
        break
