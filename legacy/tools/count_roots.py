import re

with open('rules/raw/heap-symbols.h', 'r', encoding='utf-8') as f:
    text = f.read()

m = re.search(r'#define\s+NOT_IMPORTANT_INTERNALIZED_STRING_LIST_GENERATOR\s*\([^)]*\)\s*([\s\S]*?)(?=(?:\r?\n\s*#define|\r?\n\s*#undef|\Z))', text)
if m:
    body = m.group(1)
    entries = re.findall(r'V\s*\(\s*[^,]+\s*,\s*([a-zA-Z0-9_]+)\s*,\s*"([^"]*)"\s*\)', body)
    print('NOT_IMPORTANT count:', len(entries))
