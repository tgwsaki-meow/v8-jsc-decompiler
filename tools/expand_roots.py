import re

# Read all 4 raw header files
with open('rules/raw/roots.h', 'r', encoding='utf-8') as f:
    roots_h = f.read()

with open('rules/raw/heap-symbols.h', 'r', encoding='utf-8') as f:
    symbols_h = f.read()

with open('rules/raw/objects-definitions.h', 'r', encoding='utf-8') as f:
    objs_h = f.read()

with open('rules/raw/accessors.h', 'r', encoding='utf-8') as f:
    accessors_h = f.read()

print('All 4 header files loaded successfully.')
