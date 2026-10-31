#!/usr/bin/env python3
"""
Module 3: Frontend Lifter (Bytecode Disassembler & Basic Block / CFG Builder)
Disassembles raw V8 Ignition bytecode using a version profile.
"""

import json
import struct

class Instruction:
    def __init__(self, offset, opcode_info, operands_raw, operands_decoded, scale=1):
        self.offset = offset
        self.name = opcode_info["name"]
        self.value = opcode_info["value"]
        self.hex = opcode_info["hex"]
        self.implicit = opcode_info["implicit_register_use"]
        self.operands_raw = operands_raw
        self.operands_decoded = operands_decoded
        self.scale = scale
        self.size = 0  # Total instruction length in bytes

    def __repr__(self):
        ops = ", ".join(str(op) for op in self.operands_decoded)
        return f"{self.offset:04x} : {self.name} {ops}".strip()

class Lifter:
    def __init__(self, profile_path="rules/v8-14.4.258.16.json"):
        with open(profile_path, "r", encoding="utf-8") as f:
            self.profile = json.load(f)
        self.opcodes = {int(k): v for k, v in self.profile["opcodes_by_val"].items()}
        self.operand_props = self.profile.get("operand_properties", {})

    def decode_register(self, raw_val):
        """
        V8 Ignition register encoding:
        Register::FromOperand(operand): kRegisterFileStartOffset - operand
        In V8:
        Negative/small values map to parameters:
        ToParameterIndex:
        index 0 = receiver (<this>)
        index 1 = a0
        index 2 = a1, etc.
        Positive indices map to r0, r1, r2, ...
        """
        # When encoded as signed 8-bit or signed 16-bit:
        # Standard ignition convention in disassembled output:
        # If operand is negative (in 2's complement):
        if raw_val >= 128:
            signed_val = raw_val - 256
        else:
            signed_val = raw_val

        # Check typical V8 register mapping
        # In V8 bytecodes:
        # r0 is often encoded as -2 or -1 or 0 depending on frame pointer offset
        # Let's provide a consistent naming:
        if signed_val < 0:
            reg_idx = -signed_val - 1
            if reg_idx == 0:
                return "<this>"
            return f"a{reg_idx - 1}"
        else:
            return f"r{signed_val}"

    def disassemble_stream(self, bytecode_bytes, constants=None):
        """
        Disassembles a raw bytecode bytearray into Instruction objects.
        """
        instructions = []
        pc = 0
        total_len = len(bytecode_bytes)

        while pc < total_len:
            inst_start = pc
            scale = 1  # 1 = Single, 2 = Wide, 4 = ExtraWide

            byte = bytecode_bytes[pc]
            pc += 1

            # Handle Wide / ExtraWide prefixes
            if byte == 0x00:  # Wide
                scale = 2
                if pc >= total_len: break
                byte = bytecode_bytes[pc]
                pc += 1
            elif byte == 0x01:  # ExtraWide
                scale = 4
                if pc >= total_len: break
                byte = bytecode_bytes[pc]
                pc += 1

            op_info = self.opcodes.get(byte)
            if not op_info:
                # Unknown / invalid opcode
                instructions.append(Instruction(inst_start, {"name": f"Unknown_0x{byte:02x}", "value": byte, "hex": f"0x{byte:02x}", "implicit_register_use": "kNone"}, [], []))
                continue

            operands_raw = []
            operands_decoded = []

            for op_type in op_info.get("operands", []):
                prop = self.operand_props.get(op_type, {"scalable": False, "signed": False, "base_size": 1})
                op_size = prop["base_size"]
                if prop.get("scalable", False):
                    op_size *= scale

                if pc + op_size > total_len:
                    break

                raw_bytes = bytecode_bytes[pc:pc+op_size]
                pc += op_size

                if op_size == 1:
                    raw_val = raw_bytes[0]
                elif op_size == 2:
                    raw_val = struct.unpack("<H" if not prop["signed"] else "<h", raw_bytes)[0]
                elif op_size == 4:
                    raw_val = struct.unpack("<I" if not prop["signed"] else "<i", raw_bytes)[0]
                else:
                    raw_val = int.from_bytes(raw_bytes, "little")

                operands_raw.append(raw_val)

                # Decode into human-readable form
                if "Reg" in op_type:
                    decoded = self.decode_register(raw_val)
                elif "ConstantPool" in op_type:
                    if constants and raw_val < len(constants):
                        decoded = f"[{raw_val}] ({constants[raw_val]!r})"
                    else:
                        decoded = f"[{raw_val}]"
                elif "Imm" in op_type:
                    decoded = f"#{raw_val}"
                elif "FeedbackSlot" in op_type:
                    decoded = f"[{raw_val}]"
                else:
                    decoded = f"{raw_val}"

                operands_decoded.append(decoded)

            inst = Instruction(inst_start, op_info, operands_raw, operands_decoded, scale)
            inst.size = pc - inst_start
            instructions.append(inst)

        return instructions

    def build_cfg(self, instructions):
        """
        Partitions instructions into Basic Blocks and builds control flow edges.
        """
        if not instructions:
            return []

        # 1. Identify Leaders (Block Entry Points)
        leaders = {0}  # First instruction is always a leader
        for i, inst in enumerate(instructions):
            # If instruction is a jump, target is a leader
            if "Jump" in inst.name:
                # Target offset is computed from current offset
                if inst.operands_raw:
                    target_delta = inst.operands_raw[0]
                    # In V8, jumps can be forward (relative) or absolute
                    # Target PC
                    target_pc = inst.offset + target_delta
                    leaders.add(target_pc)
                # Next instruction after jump is also a leader
                if i + 1 < len(instructions):
                    leaders.add(instructions[i+1].offset)
            elif inst.name in ("Return", "Throw", "ReThrow", "Abort"):
                if i + 1 < len(instructions):
                    leaders.add(instructions[i+1].offset)

        # 2. Slice into Basic Blocks
        blocks = []
        current_block = []
        for inst in instructions:
            if inst.offset in leaders and current_block:
                blocks.append(current_block)
                current_block = []
            current_block.append(inst)
        if current_block:
            blocks.append(current_block)

        return blocks

if __name__ == "__main__":
    lifter = Lifter()
    # Test slice from r_73065.jsc offset 0x212
    # 23 00 00 d1 23 00 00 d0 33 f7 01 02
    test_bytes = bytearray.fromhex("23 00 00 d1 23 00 00 d0 33 f7 01 02")
    instructions = lifter.disassemble_stream(test_bytes)
    print("Disassembled instructions:")
    for inst in instructions:
        print(" ", inst)
