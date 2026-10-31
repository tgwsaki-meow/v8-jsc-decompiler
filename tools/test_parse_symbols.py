import re
import json

# 1. Parse heap-symbols.h
with open('rules/raw/heap-symbols.h', 'r', encoding='utf-8') as f:
    symbols_text = f.read()

# Map from cpp_name to literal string value
string_values = {}

# Patterns:
# V(_, name_string, "string")
# V(name_string, "string")
# V(_, name, "string")
for m in re.finditer(r'V\s*\(\s*(?:_\s*,\s*)?([a-zA-Z0-9_]+)\s*,\s*"((?:\\.|[^"\\])*)"\s*\)', symbols_text):
    name = m.group(1)
    val = m.group(2)
    try:
        val_decoded = val.encode('utf-8').decode('unicode_escape')
    except Exception:
        val_decoded = val
    string_values[name] = val_decoded

# Handle single char strings latin1_XX_string
for i in range(256):
    string_values[f'latin1_{i:02x}_string'] = chr(i)

# Extra values
string_values['empty_string'] = ''
string_values['prototype_string'] = 'prototype'
string_values['name_string'] = 'name'
string_values['length_string'] = 'length'

print('Parsed string values:', len(string_values))
