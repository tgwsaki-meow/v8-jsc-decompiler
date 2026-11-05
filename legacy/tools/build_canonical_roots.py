import struct
import json
import re

# 1. Parse string literal values from official heap-symbols.h
string_values = {
    "undefined_value": "undefined",
    "null_value": "null",
    "true_value": True,
    "false_value": False,
    "the_hole_value": "the_hole",
    "empty_string": "",
}

with open('rules/raw/heap-symbols.h', 'r', encoding='utf-8') as f:
    symbols_raw = f.read()

matches = re.finditer(r'V_?\s*\(\s*(?:[^,\n]+,\s*)?([a-zA-Z0-9_]+)\s*,\s*"((?:\\.|[^"\\])*)"\)', symbols_raw)
for m in matches:
    name = m.group(1).strip()
    val = m.group(2).strip()
    try:
        val = bytes(val, 'utf-8').decode('unicode_escape')
    except Exception:
        pass
    string_values[name] = val

# Also standard single-character strings
for c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_":
    string_values[f"{c}_string"] = c

# 2. Read exact RootsTable from QQNT.dll at 0xc602b60
dll_path = r'C:\Users\yumemita\Pictures\Q\pc\260924\win\Files\versions\9.9.36-53644\QQNT.dll'
with open(dll_path, 'rb') as f:
    data = f.read()

e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
image_base = struct.unpack_from('<Q', data, e_lfanew + 48)[0]
opt_hdr_size = struct.unpack_from('<H', data, e_lfanew + 20)[0]
sec_table_offset = e_lfanew + 24 + opt_hdr_size
num_sections = struct.unpack_from('<H', data, e_lfanew + 6)[0]

sections = []
for i in range(num_sections):
    sec = data[sec_table_offset + i*40 : sec_table_offset + (i+1)*40]
    name = sec[:8].rstrip(b'\x00').decode('latin1')
    vsize, vaddr, rsize, raddr = struct.unpack_from('<IIII', sec, 8)
    sections.append((name, vaddr, vsize, raddr, rsize))

def rva_to_file(rva):
    for name, vaddr, vsize, raddr, rsize in sections:
        if vaddr <= rva < vaddr + vsize:
            return raddr + (rva - vaddr)
    return None

po = 0xc602b60
# In V8 snapshot serialization, root index 0 corresponds to table entry 4 (undefined_value)
# Index 5 corresponds to table entry 9 (empty_string)
# Therefore, serialized_root_id = table_index - 4
roots_dict = {}
total_roots = 1150
for table_idx in range(4, 4 + total_roots):
    ptr_val = struct.unpack_from('<Q', data, po + table_idx * 8)[0]
    rva = ptr_val - image_base
    fo = rva_to_file(rva)
    if fo is None or fo < 0 or fo >= len(data):
        break
    end = data.find(b'\x00', fo)
    cpp_name = data[fo:end].decode('ascii', errors='replace')
    
    serialized_id = table_idx - 4

    # Determine type and value
    if cpp_name == "undefined_value":
        entry = {"cpp_name": cpp_name, "type": "oddball", "value": "undefined"}
    elif cpp_name == "null_value":
        entry = {"cpp_name": cpp_name, "type": "oddball", "value": "null"}
    elif cpp_name == "true_value":
        entry = {"cpp_name": cpp_name, "type": "oddball", "value": True}
    elif cpp_name == "false_value":
        entry = {"cpp_name": cpp_name, "type": "oddball", "value": False}
    elif cpp_name == "the_hole_value":
        entry = {"cpp_name": cpp_name, "type": "oddball", "value": "the_hole"}
    elif cpp_name == "empty_string":
        entry = {"cpp_name": cpp_name, "type": "string", "value": ""}
    elif cpp_name in string_values:
        entry = {"cpp_name": cpp_name, "type": "string", "value": string_values[cpp_name]}
    elif cpp_name.endswith("_string") and cpp_name[:-7] in string_values:
        entry = {"cpp_name": cpp_name, "type": "string", "value": string_values[cpp_name[:-7]]}
    elif cpp_name.endswith("_symbol"):
        sym_name = cpp_name[:-7]
        entry = {"cpp_name": cpp_name, "type": "symbol", "value": f"Symbol.{sym_name}"}
    elif cpp_name.endswith("_map"):
        entry = {"cpp_name": cpp_name, "type": "map", "value": cpp_name}
    else:
        entry = {"cpp_name": cpp_name, "type": "identifier", "value": cpp_name}

    roots_dict[str(serialized_id)] = entry

out_path = 'rules/v8-roots-14.4.258.16.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump({
        "version": "14.4.258.16",
        "total_roots": len(roots_dict),
        "roots": roots_dict
    }, f, indent=2, ensure_ascii=False)

print(f"Successfully generated {len(roots_dict)} roots to {out_path}!")
print(f"Root 0: {roots_dict['0']}")
print(f"Root 5: {roots_dict['5']}")
print(f"Root 392: {roots_dict['392']}")
print(f"Root 594: {roots_dict['594']}")
print(f"Root 674: {roots_dict['674']}")
print(f"Root 713: {roots_dict['713']}")
print(f"Root 880: {roots_dict['880']}")
