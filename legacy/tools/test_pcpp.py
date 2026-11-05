import io
import re
from pcpp import Preprocessor

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
text = out.getvalue()
entries = re.findall(r'ENTRY\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)', text)
print(f"Total entries: {len(entries)}")
for i in range(690, 725):
    print(f"[{i}] {entries[i][0]}")







