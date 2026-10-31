#!/usr/bin/env python3
"""
V8 Version Profile Extractor for V8 14.4.258.16
Pulls key definitions from official V8 git repository (no git clone needed)
and generates a standalone opcode and layout profile JSON.
"""

import urllib.request
import re
import json
import os

V8_TAG = "14.4.258.16"
BASE_URL = f"https://raw.githubusercontent.com/v8/v8/{V8_TAG}"

def fetch_file(relative_path, cache_dir="rules/raw"):
    os.makedirs(cache_dir, exist_ok=True)
    local_path = os.path.join(cache_dir, os.path.basename(relative_path))
    if os.path.exists(local_path):
        with open(local_path, "r", encoding="utf-8") as f:
            return f.read()
    
    url = f"{BASE_URL}/{relative_path}"
    print(f"Fetching {url}...")
    req = urllib.request.Request(url, headers={"User-Agent": "V8Disassembler/1.0"})
    with urllib.request.urlopen(req) as resp:
        content = resp.read().decode("utf-8")
    
    with open(local_path, "w", encoding="utf-8") as f:
        f.write(content)
    return content

def extract_bytecodes(bytecodes_h):
    # Remove C/C++ comments
    clean_text = re.sub(r'/\*[\s\S]*?\*/', '', bytecodes_h)
    clean_text = re.sub(r'//.*', '', clean_text)

    def parse_macro(macro_name):
        pattern = r'#define\s+' + macro_name + r'\s*(?:\([^\)]*\))?\s*\\([\s\S]*?)(?=\n\s*#define|\n\s*#if|\Z)'
        m = re.search(pattern, clean_text)
        if not m:
            return []
        block = m.group(1).replace('\\\n', ' ')
        entries = []
        for item in re.finditer(r'(?:V|V_TSA)\s*\(\s*(\w+)\s*,\s*([^,\)]+)(?:,([^\)]+))?\)', block):
            name = item.group(1)
            implicit = item.group(2).strip().replace('ImplicitRegisterUse::', '')
            ops_str = item.group(3)
            ops = []
            if ops_str:
                for op in ops_str.split(','):
                    op = op.strip().replace('OperandType::', '')
                    if op:
                        ops.append(op)
            entries.append({
                "name": name,
                "implicit_register_use": implicit,
                "operands": ops
            })
        return entries

    unique_handlers = parse_macro('BYTECODE_LIST_WITH_UNIQUE_HANDLERS_IMPL')
    call_props = parse_macro('CALL_PROPERTY_BYTECODES')
    short_stars = parse_macro('SHORT_STAR_BYTECODE_LIST')

    full_list = unique_handlers + call_props + short_stars + [{
        "name": "Illegal",
        "implicit_register_use": "kNone",
        "operands": []
    }]

    opcodes = {}
    for idx, bc in enumerate(full_list):
        bc["value"] = idx
        bc["hex"] = f"0x{idx:02x}"
        opcodes[idx] = bc

    return opcodes

def extract_operand_types(bytecode_operands_h):
    scalable_signed = [
        "kReg", "kRegOut", "kRegInOut", "kRegList", "kImm"
    ]
    scalable_unsigned = [
        "kUImm", "kConstantPoolIndex", "kFeedbackSlot"
    ]
    fixed_unsigned_byte = [
        "kFlag8", "kRuntimeId", "kIntrinsicId", "kRegCount"
    ]
    fixed_unsigned_short = [
        "kFlag16"
    ]
    
    properties = {}
    for op in scalable_signed:
        properties[op] = {"scalable": True, "signed": True, "base_size": 1}
    for op in scalable_unsigned:
        properties[op] = {"scalable": True, "signed": False, "base_size": 1}
    for op in fixed_unsigned_byte:
        properties[op] = {"scalable": False, "signed": False, "base_size": 1}
    for op in fixed_unsigned_short:
        properties[op] = {"scalable": False, "signed": False, "base_size": 2}
    
    return properties

def extract_header_offsets():
    return {
        "kMagicNumberOffset": 0,
        "kVersionHashOffset": 4,
        "kSourceHashOffset": 8,
        "kFlagHashOffset": 12,
        "kReadOnlySnapshotChecksumOffset": 16,
        "kPayloadLengthOffset": 20,
        "kChecksumOffset": 24,
        "kHeaderSize": 32
    }

def main():
    print(f"=== Generating V8 {V8_TAG} Rule Profile ===")
    bytecodes_h = fetch_file("src/interpreter/bytecodes.h")
    code_serializer_h = fetch_file("src/snapshot/code-serializer.h")
    bytecode_operands_h = fetch_file("src/interpreter/bytecode-operands.h")
    
    opcodes = extract_bytecodes(bytecodes_h)
    offsets = extract_header_offsets()
    operand_props = extract_operand_types(bytecode_operands_h)
    
    profile = {
        "v8_version": V8_TAG,
        "total_opcodes": len(opcodes),
        "header_offsets": offsets,
        "operand_properties": operand_props,
        "opcodes_by_val": opcodes,
        "opcodes_by_name": {v["name"]: v for v in opcodes.values()}
    }
    
    out_dir = "rules"
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"v8-{V8_TAG}.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2)
    
    print(f"Success! Generated profile with {len(opcodes)} opcodes saved to: {out_file}")

if __name__ == "__main__":
    main()
