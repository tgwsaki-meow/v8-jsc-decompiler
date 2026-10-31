import struct
import json
import re
import os

def main():
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

    def file_to_rva(f_offset):
        for name, vaddr, vsize, raddr, rsize in sections:
            if raddr <= f_offset < raddr + rsize:
                return vaddr + (f_offset - raddr)
        return None

    def rva_to_file(rva):
        for name, vaddr, vsize, raddr, rsize in sections:
            if vaddr <= rva < vaddr + vsize:
                return raddr + (rva - vaddr)
        return None

    po = 0xc602cd0
    root_names = []
    for k in range(1108):
        ptr_val = struct.unpack_from('<Q', data, po + k * 8)[0]
        rva = ptr_val - image_base
        fo = rva_to_file(rva)
        if fo is None or fo < 0 or fo >= len(data):
            break
        end = data.find(b'\x00', fo)
        root_names.append(data[fo:end].decode('ascii'))

    print(f'Extracted {len(root_names)} root names from QQNT.dll at 0x{po:x}')

    # Parse heap-symbols.h
    str_map = {}
    with open('rules/raw/heap-symbols.h', 'r', encoding='utf-8') as f:
        content = f.read()

    # Pattern: V(_, name, "val") or V_(_, name, "val")
    pattern = re.compile(r'V_?\s*\(\s*[^,]+,\s*([a-zA-Z0-9_]+)\s*,\s*"((?:\\.|[^"\\])*)"\)')
    for m in pattern.finditer(content):
        name = m.group(1)
        raw_val = m.group(2)
        # unescape raw_val safely
        try:
            val_decoded = raw_val.encode('utf-8').decode('unicode_escape')
        except Exception:
            val_decoded = raw_val
        str_map[name] = val_decoded

    # Also handle single-char strings like latin1_XX_string
    for i in range(256):
        c = chr(i)
        name_latin = f'latin1_{i:02x}_string'
        if name_latin not in str_map:
            str_map[name_latin] = c

    # Common known values
    special_values = {
        'empty_string': '',
        'undefined_value': None,  # handled as identifier/literal
        'the_hole_value': '__the_hole__',
        'null_value': None,
        'true_value': True,
        'false_value': False,
        'nan_value': float('nan'),
        'infinity_value': float('inf'),
        'minus_zero_value': -0.0,
        'minus_infinity_value': float('-inf'),
    }

    roots_by_index = {}
    for idx, cpp_name in enumerate(root_names):
        entry = {
            'cpp_name': cpp_name,
        }

        # Check if it has a string definition
        if cpp_name in str_map:
            entry['type'] = 'string'
            entry['value'] = str_map[cpp_name]
        elif cpp_name.endswith('_string') and cpp_name[:-7] in str_map:
            entry['type'] = 'string'
            entry['value'] = str_map[cpp_name[:-7]]
        elif cpp_name in special_values:
            val = special_values[cpp_name]
            if cpp_name == 'empty_string':
                entry['type'] = 'string'
                entry['value'] = ''
            elif val is None and cpp_name == 'undefined_value':
                entry['type'] = 'identifier'
                entry['value'] = 'undefined'
            elif val is None and cpp_name == 'null_value':
                entry['type'] = 'literal'
                entry['value'] = None
            elif isinstance(val, bool):
                entry['type'] = 'literal'
                entry['value'] = val
            else:
                entry['type'] = 'identifier'
                entry['value'] = str(val)
        elif cpp_name.endswith('_symbol'):
            # V8 Well known or private symbol
            sym_name = cpp_name[:-7]
            entry['type'] = 'symbol'
            entry['value'] = sym_name
        elif cpp_name.endswith('_map'):
            entry['type'] = 'map'
            entry['value'] = cpp_name
        else:
            # Generic root identifier
            entry['type'] = 'identifier'
            entry['value'] = cpp_name

        roots_by_index[str(idx)] = entry

    out_data = {
        'version': '14.4.258.16',
        'total_roots': len(root_names),
        'roots_by_index': roots_by_index
    }

    out_file = 'rules/v8-roots-14.4.258.16.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(out_data, f, indent=2, ensure_ascii=False)

    print(f'Successfully wrote {len(roots_by_index)} roots to {out_file}')

if __name__ == '__main__':
    main()
