# V8 Code Cache Decompiler — 架构设计

> 本文是实现的唯一参考。所有 subagent 在动手前必须读完对应章节。
> 事实依据：`scratch/audit/BASELINE_AUDIT.md`（现状量化审计）、
> `scratch/recon/VERSION_PLUGGABILITY.md`（版本可插拔性勘察）。

---

## 0. 先纠正问题的提法

原始描述是「jsc 字节码会先由 V8 内部的解析器序列化为 V8 IR，然后 V8 IR 转 AST」。
这个链路是反的，而且「V8 IR」用词不对。真实链路：

```
源码 → Parser → AST → BytecodeGenerator(Ignition) → BytecodeArray
                                                        ↓ CodeSerializer
                                                      .jsc (序列化的堆对象图)
```

* `.jsc` 里是**序列化的 V8 堆对象图**（SharedFunctionInfo / BytecodeArray /
  ConstantPool / ScopeInfo / handler table / SourcePositionTable）。
* 反序列化出来是 **Ignition 字节码**：一个「寄存器文件 + 单累加器」的虚拟机指令流。
* TurboFan 的 sea-of-nodes IR（真正意义上的「V8 IR」）**从不进 code cache**。
  Sparkplug / Maglev 的机器码也不进。

**为什么这个纠正很重要**：它把问题从「反推编译器优化后的产物」改写成
**「反演一个确定性的、单遍的、AST 制导的代码生成器」**。

`BytecodeGenerator` 没有优化 pass、不做 CFG 重排、不做内联、不做寄存器重命名以外的变换。
它对每一类 AST 节点发射**模板化的固定字节码序列**。直接推论：

1. **控制流必然 reducible**（图是从结构化 JS 直接发射的），
   不需要处理一般意义上的 irreducible CFG。
2. **大量元数据可直接恢复**，不需要猜：
   - `ScopeInfo` → **真实变量名**（context local names）、真实参数个数、函数名、外层 scope 链
   - `SourcePositionTable` → **真实行列号** → 可以产出 source map
   - `HandlerTable` → try 范围、catch 预测类型
   - `SharedFunctionInfo` → `function_literal_id`、`start/end_position`、kind（async/generator/arrow/class ctor）
3. **模式目录不需要靠猜**：`src/interpreter/bytecode-generator.cc` 里每个 `Visit<Node>`
   方法就是对应语法的发射规范。逆向规则表 = 这 ~120 个方法的机械转写。
   这是「V8 IR 怎么回 AST」这个问题的直接答案。

因此目标不应该定在「审计够用」。变量名、行号、语法结构基本可以全还原。

### 0.1 必须提前讲清的能力上限

| 项 | 能否恢复 | 说明 |
|---|---|---|
| 已编译函数的函数体 | ✅ | 有 BytecodeArray |
| **lazy 未编译的内层函数体** | ❌ | 只有 SFI + `UncompiledData{start,end_position}`，**没有字节码**。必须显式标记成洞，不能假装有 |
| 变量名 | ✅ context 变量 / ⚠️ 纯栈局部 | ScopeInfo 存 context-allocated 变量名；纯栈局部名通常不在 |
| 行列号 | ✅ | SourcePositionTable |
| 注释 | ❌ | 不进字节码 |
| `let`/`const`/`var` 区分 | ⚠️ 部分 | ScopeInfo 的 `VariableProperties` 有 mode 位 |
| 死代码 | ❌ | 不发射 |
| 原始源码长度 | ✅ | 见 §1.2，header 的 sourceHash 就是字符数 |

---

## 1. 现状：事实，不是印象

### 1.1 后端是坏的，且坏得不明显

`BASELINE_AUDIT.md` 的关键数字：

| 指标 | 现状 |
|---|---|
| 输出是合法 JS 的比例 | **1039/1039 = 100%** |
| 1039 个输出里能跑起来的 | **≈ 0** |
| 167 个 `JumpLoop` 回边 → 发射的循环语句 | **0** |
| 667 个异常指令 → 发射的 `try` | **0** |
| 160 个 switch 分派指令 → 发射的 `switch` | **0** |
| 全语料 309MB 里含 `while` 的文件 | **2 个** |
| 相邻语句对重复求值同一个有副作用调用 | **2787 / 21550 = 12.93%** |
| 对象分配表达式在同一函数体内被复制 | **2160 / 4297 = 50.27%**（最严重一处复制 22 次） |
| `ctx` 被引用次数 / 被声明次数 | **1,710,336 / 0** |
| 反序列化出的函数真正进入输出的比例 | **38.76%**（中位数 96.78%，最差文件 35.87%） |
| 12 个输入里 180s 内跑不完的 | **2 个**；成本与输入大小无关（3.4KB 的输入要 20s） |

100% 可解析和 212/212 opcode 覆盖这两个数字是**假指标**：
前者是 `@babel/generator` 的性质（合法 AST 印不出非法 JS），
后者只说明 `switch` 有 `case` 标签，不说明 case 里重建对了。
**这两个指标已经饱和，不能用来衡量进展。**

真实的致命缺陷，按严重程度：

1. `legacy/src/relooper.js` 的 `_findMergeBlock` 取「两分支可达块里 id 最小的那个」当汇合点
   ——那不是 immediate post-dominator。循环检测只认自环（`trueTarget.id === block.id`），
   所以**所有真实循环都没被识别**。
2. `legacy/src/decompiler.js:70-76` 用「第一个前驱赢」把寄存器状态传给后继
   （`if (!blockStates.has(succ.id))`），**没有 phi，没有定点迭代，按布局顺序遍历**。
   合并点之后的寄存器状态全是错的。
3. `legacy/src/dataflow.js` 的表达式内联**没有 effect ordering 约束**，而且用
   「下一条指令不是 Star/JumpIf/Return 就把调用也当语句推一遍」这种启发式
   → 既重复求值又丢语句。对象被按引用点复制 → identity 全毁
   （webpack 的 module cache 变成每次 new 一个新对象，`.exports` 永远 undefined）。

### 1.2 前端大体可用，但不可插拔，且有两个错版本的表

| 产物 | 来源 | 可复现 | 正确性 |
|---|---|---|---|
| `rules/v8-14.4.258.16.json`（opcode 表） | `legacy/tools/extract_rules.js` ← `rules/raw/bytecodes.h` | ✅ | ✅ 独立重导 0 mismatch |
| `rules/v8-roots-*.json`（1150 roots） | `legacy/tools/build_canonical_roots.py` ← **已不存在的 QQNT.dll**，硬编码偏移 `0xc602b60` + 魔数 `-4` | ❌ | ⚠️ 内容基本对（1041/1045 位置吻合） |
| `rules/v8-ro-heap.json`（3182 条） | `scratch/generate_complete_ro_heap.js` ← **已不存在的 v8_context_snapshot.bin**，扫魔数 `0x155` | ❌ | ⚠️ 只含字符串，缺 map/symbol/oddball |
| `rules/raw/roots.h` | 本地拷贝 | — | ❌ **是 V8 12.8.374.38 的** |
| `rules/raw/static-roots.h` | 本地拷贝 | — | ❌ **是 V8 12.8.374.38 的**，且 ≥14.2 该文件已拆成 4 个变体 |

`operand_properties` 和 `header_offsets` 在 `legacy/tools/extract_rules.js` 里是**手敲的字面量**，
不是从源码导的。这正好撞上一个跨版本陷阱（见 §1.3）。

### 1.3 跨版本陷阱（为什么必须 per-version 生成）

14.4.258.16 → 14.6.202.34：opcode **编号完全相同**，212 条，无增删。
但有 6 条指令的操作数类型变了：

```
TestEqual / TestEqualStrict / TestLessThan / TestGreaterThan
/ TestLessThanOrEqual / TestGreaterThanOrEqual
  14.4: [kReg, kFeedbackSlot]      kFeedbackSlot = kScalableUnsignedByte  (1/2/4 字节)
  14.6: [kReg, kEmbeddedFeedback]  kEmbeddedFeedback = kFixedUnsignedShort (恒 2 字节)
```

用 14.4 的表解 14.6 的字节码会**算错指令长度**，从那条指令开始整个反汇编错位。
root 索引更脆：14.4→14.6 从 index 504 开始顺序就分叉了。

### 1.4 新发现的三件好事

1. **`node --print-bytecode` 在本机可用**（之前「没输出」是 agent 终端吞了 stdout）。
   `--print-code`、`--print-builtin-code`、`--allow-natives-syntax` 也可用。
   → 有真 V8 oracle。
   注意必须加 `--no-enable-lazy-source-positions`，否则 listing 里**完全没有**
   `NN S>` / `NN E>` 源位置标记（V8 默认惰性构建 source position table）。
   而且输出只能重定向到文件，不能走管道。
   **更进一步**：目标版本的 V8 也拿到了 —— `chromium-v8` bucket 里有
   `v8-linux64-rel-14.4.258.16.zip`（精确版本），`v8-win64-rel-14.4.258.17`
   提供可在本机运行的 `d8.exe`，Electron 40.0.0 正好带 V8 **14.4.258.16**。
   所以 O1 oracle 在目标版本上也能跑。
2. **RO ref 的地址公式已验证**：
   ```
   Tagged_t = (chunk_index << 18) + chunk_offset + 1
   ```
   （2^18 = 262144 = RO page 大小；`+1` 是 HeapObject tag）。
   抽查全对：`0:3528 → 0xdc9 → prototype_string`、`0:72 → 0x49 → empty_string`。
   → **不需要再去 scrape 二进制**，查 `static-roots-<variant>.h` 即可。
   Electron/Chromium x64 用 `intl+wasm` 变体（选错变体命中率从 22.9% 掉到 4~10%）。
3. **`extracted_jsc/manifest.json` 的字段名标错了**：它写的 `source_hash`
   其实是 `FlagList::Hash()`，它写的 `payload_size` 其实是 `sourceHash`
   = **原始源码的字符数**。经 header 实测确认（`r_8878.jsc` 原始源码 4,241,501 字符，
   `sourceHash` 高位 bit29/30 表示 wrapped-args / module，本语料全是普通 script）。
   → 每个脚本的原始源码长度是已知的，可作为验证上界。

---

## 2. 目标架构

```
profiles/<v8-version>/              # 全部由 profilegen 生成，禁止手改
    meta.json                       # tag, 源文件 URL + sha256, 生成时间, build 变体
    bytecodes.json  operands.json
    serializer-tags.json
    roots.json  static-roots.json
    layouts.json                    # 对象字段偏移（含条件字段规则）
    runtime.json  intrinsics.json
    constants.json                  # kTaggedSize / page size / handler table / sourcepos
    ro-heap.json                    # (chunk,offset) → RO 对象，由 static-roots + 可选真 snapshot 生成

src/
    profile/      加载 + 校验 profile，暴露类型化访问器
    cache/        .jsc header + SnapshotSource + 反序列化字节码循环（profile 驱动）
    heap/         类型化对象视图 + RO ref 解析 + ScopeInfo/SourcePositionTable/HandlerTable 解码
    disasm/       指令解码（含 Wide/ExtraWide、reg list、jump table、源位置贴合）
    ir/           CFG（含异常边、jump table 边）+ 支配树 + SSA + effect graph
    recover/      表达式重建 + 习语模式引擎 + 作用域/命名恢复
    structure/    控制流结构化 → 语法骨架
    emit/         Babel AST → JS + source map + 洞标记
    verify/       三套 oracle + 覆盖率报表
    cli/

tools/profilegen/                   # 抓 V8 源码 + 解析 C++/Torque → profiles/
corpus/features/                    # 手写的语法特征语料（验证用）
```

原则：
* **profile 是数据，不是代码**。`src/` 里不允许出现任何版本相关的魔数、偏移、root 索引。
  CI 规则：`src/` 里出现十六进制字面量需要注释说明为什么它与版本无关。
* **每一层都能单独跑、单独验**。CLI 暴露 `dump-cache` / `disasm` / `dump-ir` / `decompile`。
* **宁可标记，不可撒谎**。任何不能确定重建的区域，输出显式标记 + 原始反汇编注释，
  并进机器可读的报告。审计场景下「大声失败」永远优于「安静地错」。

---

## 3. 前端：.jsc → 类型化堆对象

### 3.1 header（profile 驱动）

```
0x00 magic                      = 0xC0DE0000 ^ ExternalReferenceTable::kSize（随 build 变）
0x04 versionHash                = Version::Hash()
0x08 sourceHash                 = 源码字符数 | (hasWrappedArgs<<29) | (isModule<<30)
0x0c flagHash                   = FlagList::Hash()
0x10 readOnlySnapshotChecksum
0x14 payloadLength
0x18 checksum                   （本语料为 0）
0x1c —
0x20 payload 起始
```

四个 hash 字段全部用于**前置校验**：profile 的 `versionHash` 不匹配就拒绝，
`readOnlySnapshotChecksum` 用来确认 RO 表来自同一个 build。
不匹配时报错要给出「你需要哪个版本的 profile」。

### 3.2 反序列化

现有 `legacy/src/deserializer.js` 的字节码循环是对的，保留思路，重写为 profile 驱动：
tag 常量全部来自 `serializer-tags.json`（35 个 tag，14.4/14.6 完全一致），
`kNewObject` 占 `0x00..0x03`（= `kNumberOfSnapshotSpaces`，有 `static_assert` 锚点），
区间 tag 按 `BytecodeValueEncoder::Decode` 解。

必须修掉的硬编码：`kTaggedSize = 4`、`sizeInTagged * 4`、
`slotIndex >= 6 → bytecodePayload`、BytecodeArray 字段偏移、
constant pool 在 `slots[5]`、handler table 在 `slots[4]`。
全部改为查 `layouts.json`。

### 3.3 对象字段偏移的推导规则

两套机制都要支持。

**机制 1：`FIELD_LIST` + `DEFINE_FIELD_OFFSET_CONSTANTS`**（`src/utils/utils.h`）
是个普通 C enum，所以 `offset(f[k+1]) = offset(f[k]) + size(f[k])`，
以父类 `kHeaderSize` 为起点，**没有自动对齐**（padding 都是显式零名字段）。

`BytecodeArray`（`kTaggedSize=4`，相对 `ExposedTrustedObject::kHeaderSize`）：

```
length=+0  wrapper=+4  source_position_table=+8  handler_table=+12
constant_pool=+16  frame_size=+20  parameter_size=+24  max_arguments=+26
incoming_new_target_or_generator_register=+28  headerSize=+32  bytes=+32
```

**机制 2：Torque `.tq`**。字段按声明顺序排，父类大小起算；
`Smi`/`Object`/`String`/`*Pointer<T>` 各占 1 个 tagged slot；
`int32`/`uint16`/… 占自然大小；
`@if(TAGGED_SIZE_8_BYTES) optional_padding` 只在 tagged size 为 8 时存在；
`name[count]: T` 是变长区，之后的字段只能算出来；
`name?[cond]: T` 是条件字段 → **该字段之后的偏移是数据相关的，不是静态的**。

`ScopeInfo` 几乎全是条件字段，必须按 `flags` 位域逐个判断：

```
flags: ScopeFlags(uint32 位域)
parameter_count: Smi
context_local_count: Smi
position_info: {start: Smi, end: Smi}
module_variable_count?[scope_type == MODULE_SCOPE]
context_local_names[count < 75 ? count : 0]: String      ← 真实变量名在这里
context_local_names_hashtable?[count >= 75]
context_local_infos[context_local_count]: SmiTagged<VariableProperties>
saved_class_variable_info?[has_saved_class_variable]
function_variable_info?[function_variable != NONE]
inferred_function_name?[has_inferred_function_name]
outer_scope_info?[has_outer_scope_info]: ScopeInfo       ← 外层 scope 链
module_info?[...]  module_variables[...]
dependent_code?[sloppy_eval_can_extend_vars]
unused_parameter_bits?[scope_type == FUNCTION_SCOPE]
```

`kScopeInfoMaxInlinedLocalNamesSize = 75`（`src/common/globals.h`）。
位域结构（`ScopeFlags` / `VariableProperties` / `SharedFunctionInfoFlags`）在同一批
`.tq` 里以 `bitfield struct` 声明，LSB 起按声明顺序分配，同样可机械推导。

### 3.4 HandlerTable

`src/codegen/handler-table.h`：`TrustedByteArray`，每条 4 个 int32：

```
[range_start, range_end, handler_bits, handler_data]
handler_bits: prediction = bits 0..2, was_used = bit 3, handler_offset = bits 4..31
prediction ∈ {UNCAUGHT, CAUGHT, PROMISE, ASYNC_AWAIT, UNCAUGHT_ASYNC_AWAIT}
```

现有代码按 16 字节/条解析是对的，但 `handlerOffset = val >> 4` 丢了 `was_used` 位，
且没用 `prediction` 区分 async。两者都要用上：`prediction` 直接告诉你
这个 handler 是 `catch` 还是 await 的 desugaring。

### 3.5 SourcePositionTable

`src/codegen/source-position-table.cc`：变长整数（每字节 7 位 payload + 1 位 more），
**增量编码**，signed 用 zig-zag：

```
tmp = DecodeUInt();  code_offset_delta = tmp >> 2
                     is_breakable = (tmp >> 1) & 1
                     is_statement  = tmp & 1
source_position_delta = DecodeInt()      // zig-zag: (z>>1) ^ -(z&1)
```

用途：(a) 语句边界 → 帮助判定表达式/语句切分；(b) 行列号 → source map；
(c) **排序校验**：恢复出的语句顺序必须与源位置单调一致，这是个便宜的正确性断言。

### 3.6 RO ref 解析 —— 已解决，但不是靠 static-roots

地址公式已从 snapshot image 本身证明（不是抽查）：9 个 page 的
`compressed_page_address == page_index << 18` 全部成立。

```
Tagged_t = (chunk_index << 18) + chunk_offset + 1
```

**但 `static-roots-<variant>.h` 是解析 RO ref 的错误工具，命中率恰好为 0%。**
原因在 `src/snapshot/code-serializer.cc:128-131` 的派发顺序：

```c
if (SerializeHotObject(raw)) return;
if (SerializeRoot(raw)) return;            // ← root 在这里就被截走了
if (SerializeBackReference(raw)) return;
if (SerializeReadOnlyObjectReference(raw, &sink_)) return;
```

而有序的 `StaticReadOnlyRootsPointerTable` **就是** `READ_ONLY_ROOT_LIST`。
所以一个 RO 对象只要是 root，就永远走不到 `SerializeReadOnlyObjectReference`：
**`kReadOnlyHeapRef` 只会为「不是 root 的 RO 对象」发射**。
0/883 是正确答案，不是 bug。（之前报告里的 22.9% 是在一个语料根本不可能引用的
集合上算的，分母错了。）

正确做法：**解析真实 snapshot blob 的 read-only image**，逐对象走一遍，
生成权威的 `(chunk,offset) → 对象` 表。已完成：

| 表 | 来源 | RO page | 对象数 | 语料命中率 |
|---|---|---|---|---|
| `profiles/14.4.258.16/ro-heap.json` | `electron-v40.0.0-win32-x64/v8_context_snapshot.bin`（V8 **14.4.258.16**） | 0–8 | 10299 | **883/883 distinct，161059/161059 occurrence = 100%** |
| `ro-heap-d8-startup.json` | 官方 `v8-linux64-rel-14.4.258.16/snapshot_blob.bin` | 0–7 | 7529 | 88/883 = 9.97% |

用前者。为什么必须用 embedder 的 blob：Chromium 生成
`v8_context_snapshot.bin` 时会把 Blink 的 DOM 标识符和
`AccessorInfo`/`InterceptorInfo` 放进 read-only space，多出**第 9 个 page**。
语料里 chunk 8 的 46657 次引用全是 DOM 名字（`document`/`window`/`title`/`setTimeout`…）。
chunk 6 是 V8 自己的非 root 尾部（page 6 segment 4 起始于 offset 131412，
正好是语料 chunk-6 引用的起点）。

另外两个值得记住的结论：
* **1.94MB 的 RO 堆里有 1.5MB 是护栏填充**。`Hole`/`WasmNull` 在
  `V8_CAN_UNMAP_HOLES_BOOL` 下带 64KiB 故意不映射的 payload，
  共 12 个对象（每 page 两个，offset 65532 和 196604），
  所以 page 0–5 看着「满」但几乎没有真数据。
* `readOnlySnapshotChecksum` 是 **adler32 seed=0**（不是惯例的 1），
  见 `src/snapshot/snapshot-utils.cc`。四个 blob 全部重算吻合，证明 section 切分正确。

**尚未闭环的一点（必须明说）**：语料 header 的
`readOnlySnapshotChecksum = 0x4be885e`，手上所有 blob 都对不上
（Electron ctx 是 `0xe0a58cd1`）。所以这是「layout 正确」而非「bit 级同一个 build」。
支持性证据：`ExternalReferenceTable::kSize = 1652` 完全一致
（Electron blob 的 magic `0xc0de0674` == 语料 `.jsc` 的 magic），
且 883 个引用全部落在对象起点、解码出的值全是合理的 JS 标识符。
要彻底闭环只需拿到 QQ 自己安装目录里的 `v8_context_snapshot.bin` 重跑一次。

解析顺序（运行时）：
1. 查 `ro-heap.json` → `{kind, value?, mapName?, rootName?}`。
2. 未命中 → **报告为未解析，带 (chunk, offset) 和出现次数**，绝不猜。
   当前实现直接 `throw`，改为可降级 + 计数。
3. `kRootArray` / `kRootArrayConstants` 走 `roots.json`（和 RO ref 是两条不同的路径，
   别混）。

---

## 4. 后端：Ignition 字节码 → AST

这是整个项目的难点，也是现在最烂的部分。分五个阶段，每个阶段的输出都可单独 dump。

### 4.1 Stage A — 反汇编

在现有 `legacy/src/lifter.js` 基础上补齐：

* 操作数长度 = `scalable ? base_size * scale : base_size`，scale 由 `Wide`(0x00)/`ExtraWide`(0x01) 前缀决定。
* `kRegList` + `kRegCount` 成对出现：寄存器是**递减**的（`start, start-1, ...`）。
  现有代码对 `CallProperty` 系列的 receiver/args 切分散落在各 case 里，要统一。
* **跳转目标**：`JumpLoop` 是 `opcode_offset - delta`，其余是 `opcode_offset + delta`，
  `*Constant` 变体的 delta 在常量池里。现有实现用「op 名以 Jump 开头且取第一个操作数」，
  对 `JumpLoop(imm, loop_depth, feedback)` 恰好对，但要改成按操作数类型 `kUImm`/`kImm` 显式定位。
* **跳转表**（现在完全没做，这是 switch / generator 全丢的直接原因）：
  `SwitchOnSmiNoFeedback(table_start_constant_idx, table_length, case_value_base)` 和
  `SwitchOnGeneratorState` 从常量池读一个 Smi 数组，产生 N 个后继。
* 贴合 SourcePositionTable，每条指令带上 `(line, col, isStatement)`。

### 4.2 Stage B — CFG + SSA（修掉「第一个前驱赢」）

1. **基本块划分**：leader = 入口 ∪ 跳转目标 ∪ 跳转后继 ∪ handler 入口 ∪ handler range 边界。
2. **边**：无条件跳转、条件跳转（真/假两条）、fallthrough、**跳转表 N 条**、
   **异常边**（protected range 内任意块 → handler 块）。
3. **支配树**：Cooper–Harvey–Kennedy 迭代算法（简单、够快），顺带算
   immediate post-dominator（在反向图上跑同一算法）——后者是结构化的基础，
   现在那个「id 最小的公共可达块」必须删掉。
4. **phi 放置**：以 (累加器 ∪ 所有寄存器) 为变量集合，Cytron 的支配边界算法。
5. **SSA 重命名**。
   * 异常边的入口状态：V8 在进 try 之前会把需要跨越的值显式 spill 到寄存器，
     所以 handler 入口取「protected range 内所有块状态的 phi」是保守且正确的。
     handler 入口的累加器 = `CaughtException`。
   * `SwitchOnGeneratorState` 的恢复点同理按多前驱处理。

**effect graph**：对可观测状态有读写的 op（属性读写、调用、construct、throw、
context 写、generator suspend、`delete`、`in`）串成块内全序，块间按 CFG 合并。
这是后面安全内联的前提。

### 4.3 Stage C — 表达式重建

在 SSA 上做三件事，顺序固定：

1. **DCE**：无副作用且无使用的 def 删掉。
2. **受约束的内联**（修掉 12.93% 重复求值 + 50.27% identity 破坏）：
   def 可以内联进 use，当且仅当
   - use 只有一个，**且**
   - def 支配 use，**且**
   - def 与 use 之间 effect 链上没有干扰项（若 def 本身有 effect，则 use 必须是它的下一个 effect 消费者）。

   **可以复制到多个 use 的只有：纯的、廉价的、无 identity 的值**
   —— 字面量、常量池常量、不可变 context slot 读、标识符。
   对象/数组/正则/闭包字面量、`new`、任何调用 **一律不复制**，多 use 就物化成命名临时变量。
   这正好是现在实现的反面。
3. **习语模式引擎**：按固定优先级在 SSA/CFG 上做子图匹配 + 重写。

   **模式目录的来源不是猜，是 `src/interpreter/bytecode-generator.cc` 的机械转写。**
   每个 `Visit<Node>` 就是对应语法的发射规范，逆过来就是识别规则。需要覆盖（至少）：

   | 语法 | 关键字节码特征 |
   |---|---|
   | `&&` / `\|\|` / `??` | `JumpIfToBooleanFalse` / `JumpIfUndefinedOrNull` + 累加器在汇合点有 phi |
   | 三元 | 同上形状，但两分支产生不同值的 phi |
   | `?.` | `JumpIfUndefinedOrNull` + hole 检查 |
   | `for-in` | `ForInPrepare` / `ForInNext` / `ForInStep` / `JumpIfForInDone` |
   | `for-of` | `GetIterator` + `next` 调用 + `done` 测试 + `IteratorClose` 的 finally |
   | 解构 + 默认值 | `GetNamedProperty` + `JumpIfUndefined` + `Star` 序列 |
   | spread / rest | `CreateRestParameter`、`CallWithSpread`、`ConstructWithSpread`、`CreateArrayFromIterable` |
   | class | `DefineClass` 运行时调用、`GetSuperConstructor`、`FindNonDefaultConstructorOrConstruct`、home object |
   | async / await | `SwitchOnGeneratorState` 入口分派 + `SuspendGenerator`/`ResumeGenerator` + `%AsyncFunctionAwait` |
   | generator / yield | 同上，按 SFI 的 kind 位区分 async vs generator |
   | 模板字符串 | `GetTemplateObject`、`Add_StringConstant_Internalize` |
   | 对象/数组字面量 | `ObjectBoilerplateDescription` / `ArrayBoilerplateDescription` → 直接重建字面量 |
   | `typeof` | `TestTypeOf`、`LdaGlobalInsideTypeof`、`Lda*LookupSlotInsideTypeof` |
   | getter/setter/计算键 | `DefineNamedOwnProperty` / `DefineKeyedOwnProperty` + runtime `DefineAccessor*` |

   **半自动挖掘**：对一个固定的 V8 版本，写一段语法片段 → 用匹配版本的 V8
   `--print-bytecode` dump → 记录 (片段 ↔ 字节码形状) 对。
   这样模式表是**机械生成、版本专属、可验证**的，而不是手写拍脑袋。
   `corpus/features/` 既是验证语料也是模式挖掘的输入。

### 4.4 Stage D — 控制流结构化

前提：图是 reducible（§0）。所以不需要 DREAM/no-more-gotos 那套重型方案，
但需要一个**诚实的兜底**。

1. **自然循环**：回边 (n → h) 且 h 支配 n → 循环体 = 自然循环节点集。
   按条件块相对 header/latch 的位置分类 `while` / `do-while` / `for`；
   V8 `LoopBuilder` 的形状很固定（latch 处 `JumpLoop`，header 在顶，`JumpIfFalse` 出口）。
   `for` 的 init/update 从 header 之前和 latch 之前的块里提。
2. **无环区域**：按 immediate post-dominator 划分区域，递归生成 `if/else`。
3. **`break`/`continue` + 标签**：由离开循环/区域的边生成；多层嵌套时生成标签。
4. **`switch`**：来自跳转表；也要认 if-else 链形态（V8 对小 switch 会发射比较链）。
5. **`try`/`catch`/`finally`**：来自 handler table 的 range。
   `finally` 在 V8 里是 **token 寄存器 + 末尾 `SwitchOnSmiNoFeedback` 分派**的形状，
   必须专门匹配，否则只会得到一堆垃圾状态机。
6. **generator / async**：入口的 `SwitchOnGeneratorState` 是 resume 分派器。
   做法是**删掉分派器**，把每个 suspend 点还原成 `yield` / `await` 表达式。
7. **兜底**：实在结构化不了的区域，发射
   `__region: while (true) switch (__pc) { ... }` + `/* UNSTRUCTURED */` 标记，
   并计入报告。correct-but-ugly 可以接受，silently-wrong 不可以。

### 4.5 Stage E — 命名与发射

**命名**（修掉 1,710,336 个未声明的 `ctx`）：
* context slot `(depth d, index i)` → 沿 ScopeInfo 的 `outer_scope_info` 链上溯 d 层
  → `context_local_names[i]` → **真实变量名**。
* 参数：SFI 的 `formal_parameter_count` 定个数；context-allocated 的参数名在 ScopeInfo 里。
* 寄存器：能从 ScopeInfo 拿到名字的用真名；拿不到的按确定性规则造名
  （优先从使用处推断，如 `x.length` 的结果叫 `len`），并在文件头注明命名规则。
* SSA 版本回收：同一个源变量会被拆成多个 SSA 版本，发射前要按
  「活跃区间 + ScopeInfo 名字」把版本合并回命名变量（SSA destruction with naming）。
* **`ctx` 这个标识符不允许出现在最终输出里**。如果某个 slot 名字恢复不了，
  发射 `/* ctx[d][i] */` 注释 + 一个被显式声明的占位变量。

**发射**：`@babel/types` AST → `@babel/generator`，带 source map（来自 SourcePositionTable）。
lazy 未编译的函数发射成 `function name(/* args */) { /* NOT IN CACHE: source [start,end) */ }`。

---

## 5. 验证：把「demo」变成「系统」的关键

三套互相独立的 oracle，缺一不可。

### O1 — V8 字节码 oracle（最强）
```
原始 .jsc ──我们的解码──→ 字节码序列 A
         └─我们的反编译─→ JS' ──匹配版本 V8 --print-bytecode──→ 字节码序列 B
归一化掉（寄存器编号、feedback slot、常量池下标、跳转偏移）后比对 A vs B
```
输出**每函数的 opcode 序列匹配率**。这是唯一能量化「反编译对不对」的指标。
本机 `node --print-bytecode` 可用（V8 14.6）；目标版本 14.4 需要匹配的 `d8`。

### O2 — 往返定点
`decompile → recompile(createCachedData) → decompile` 两次输出必须逐字节相同。
抓不稳定性和状态泄漏。（本机已验证 `createCachedData` 往返可用，
改源码会让 `cachedDataRejected=true`，可用作负面对照。）

### O3 — 行为差分（仅对自写语料）
`corpus/features/` 里的片段我们自己写、自己知道答案。
在隔离的 `vm` 里用插桩过的 global 跑原版和反编译版，比对副作用轨迹。
**绝不执行 QQ 的代码**，只对自写语料做。

### 覆盖矩阵
`corpus/features/` 要逐项覆盖：每个运算符、每种循环形态、
解构、class（含私有字段/静态块/继承）、generator、async、
optional chaining、labeled break/continue、try/finally、
getter/setter、计算属性名、spread、tagged template、`with`、`eval`、
modules、严格/非严格模式。每个特征一个 pass/fail 格子。
**这张矩阵就是「系统、完整」的定义。**

### 必须替换的进展指标

旧指标（已饱和，无用）：输出可解析率、opcode case 覆盖率。

新指标：

| # | 指标 | 基线 | 目标 |
|---|---|---|---|
| 1 | 每个 `JumpLoop` 回边恢复出循环语句的比例 | **0 / 167** | → 100% |
| 2 | 每个 handler range 恢复出 `try` 的比例 | **0 / 667** | → 100% |
| 3 | O1 opcode 序列匹配率（按函数） | 未测 | → 报告并逐步提升 |
| 4 | 自由标识符里「真全局」占比 | 30%（其余是编造的） | → 100% |
| 5 | 反序列化函数进入输出的比例 | 38.76% | → 100% |
| 6 | 重复求值的有副作用调用 | 12.93% | → 0 |
| 7 | 丢失 identity 的分配表达式 | 50.27% | → 0 |
| 8 | 吞吐（ms per input KB） | 4 ~ 5975（无规律） | → 线性可预测 |
| 9 | 未解析 RO ref 数 | 未测 | → 0 或显式列出 |
| 10 | 标记为 UNSTRUCTURED 的区域数 | — | 报告，不隐藏 |

---

## 6. 实施顺序与状态

| 波次 | 任务 | 依赖 | 状态 |
|---|---|---|---|
| **W1** | T1 `profilegen`（全部表从 pinned tag 机械导出） | — | ✅ **完成**，67/67 验收通过 |
| | T2 目标版本 d8 + O1 oracle + 权威 RO 表 | — | ✅ **完成**，RO 命中率 100% |
| | T3 验证框架 + `corpus/features/`(270 条) + 指标看板 | T1 | ✅ **完成**，三 oracle 自检全过 |
| **W2** | T4 `cache/` + `heap/` 类型化对象模型 | T1 | ✅ **完成**，1200/1200 断言对上 V8；**context slot 命名率 100%** |
| | T5 `disasm/`（跳转表、reg list、源位置） | T1 | ✅ **完成**，1680/1680 函数与 V8 listing 逐指令相同 |
| | T6 `ir/`（CFG + 支配 + SSA + effect graph） | T5 | ✅ **完成**，17 项不变式在 239979 个函数上全过 |
| **W3** | T7 `recover/`（受约束内联 + 习语模式 + 命名） | T6（契约见 §11.1） | 🔄 进行中 |
| | T8 `structure/`（循环/条件/switch/try/generator + 兜底） | T6（契约见 §11.2） | 🔄 进行中 |
| | T10 把 §9.6 + §10.7 的五个静默缺口回灌 profilegen | T1 | 🔄 进行中 |
| | T9 `emit/`（AST + source map + 洞标记） | T7 T8（契约见 §11.3/§11.4） | ⬜ 待 T7/T8 |

T7 和 T8 **都只以 §8.4 的 IR 为输入，互不引用**，在 T9 处按 §11.3 的六条
不变式对齐。这是 W3 能三路并行的唯一原因，细节见 §11。

每波结束跑一次 §5 的指标看板，和基线对比。

### W1 产出清单

```
profiles/14.4.258.16/   profiles/14.6.202.34/
    meta bytecodes operands serializer-tags roots static-roots
    layouts runtime intrinsics constants         ← T1，每 tag 283 个源文件带 sha256
profiles/14.4.258.16/ro-heap.json                ← T2，10299 个对象，语料命中 100%
profiles/DIFF-14.4-vs-14.6.md
src/profile/index.mjs                            ← 加载器，零版本字面量（selftest 强制）
src/verify/{oracle,bytecode_parser,normalize,compare}.mjs   ← O1
tools/profilegen/   tools/oracle/
docs/PROFILEGEN.md
```

---

## 8. 层间数据契约

并行开发必须先定死接口。以下是各层之间传递的结构，字段名即契约。

### 8.1 `cache/` + `heap/` → `disasm/`：`FunctionUnit`

```js
{
  // 身份
  sfiId, bytecodeId, functionLiteralId,
  name,                       // 来自 SFI.name_or_scope_info / inferred_function_name
  kind,                       // normal | arrow | method | classCtor | getter | setter
  isGenerator, isAsync, isStrict,
  startPosition, endPosition, // 源码字符区间（来自 SFI）

  // 字节码本体
  bytecode,                   // Buffer，仅字节码，不含 header
  frameSize, parameterCount, maxArguments,
  registerCount,              // frameSize / kSystemPointerSize
  incomingNewTargetOrGeneratorRegister,

  // 常量池：已解码，每项是 tagged union
  constants: [
    { t:'string', v }               | { t:'number', v }        | { t:'bigint', v }
  | { t:'boolean', v }              | { t:'null' }             | { t:'undefined' }
  | { t:'hole' }                    | { t:'symbol', desc }
  | { t:'sfi', sfiId }                                  // CreateClosure 目标
  | { t:'scopeInfo', scopeInfoId }
  | { t:'objectBoilerplate', entries, flags, backingStoreSize }
  | { t:'arrayBoilerplate', elements, flags }
  | { t:'regexpBoilerplate', source, flags }
  | { t:'templateObject', raw, cooked }
  | { t:'smiArray', values }                            // SwitchOnSmiNoFeedback 跳转表
  | { t:'roRef', chunk, offset, resolved? }             // 未解析时 resolved 缺失
  | { t:'unresolved', why, detail }                     // 必须显式，不能静默
  ],

  // 异常表：已解码位域
  handlers: [{ rangeStart, rangeEnd, handlerOffset, prediction, wasUsed, data }],

  // 源位置表：已解码为绝对值
  sourcePositions: [{ codeOffset, sourcePosition, isStatement, isBreakable }],

  // 作用域：真实变量名的来源
  scope: {
    scopeType, flags,                    // ScopeFlags 位域已展开
    parameterCount,
    contextLocalNames: [ 'name', ... ],  // 下标 = context slot - kVariablePartIndex
    contextLocalInfos: [{ mode, initFlag, maybeAssigned, isStaticFlag }],
    functionVariable, inferredFunctionName,
    outer: <同结构，沿 outer_scope_info 链>   // 解 LdaContextSlot 的 depth
  } | null,

  // 未编译的函数
  uncompiled: { startPosition, endPosition, inferredName } | null
}
```

规则：
* **任何不能确定解码的东西都进 `{t:'unresolved'}` 或顶层 `warnings[]`，带上原因。**
  禁止用占位值糊过去。
* `constants` 里的 `smiArray` 必须识别出来，否则 `SwitchOnSmiNoFeedback` 的
  跳转表无法建边（这是现在 switch / generator 全丢的根因之一）。

### 8.2 `disasm/` → `ir/`：`Instruction[]`

```js
{
  offset, length, opcode,         // opcode 为名字，不是字节
  scale,                          // 1 | 2 | 4（Wide / ExtraWide）
  operands: [                     // 按 profile 的 operands[] 顺序，已按类型解码
    { type:'kReg', reg }          // reg 是解码后的寄存器标识，见 8.3
  | { type:'kRegList', start, count }   // 注意 V8 的 reg list 是递减的
  | { type:'kRegOutPair'|'kRegOutTriple', regs }
  | { type:'kImm'|'kUImm', value }
  | { type:'kConstantPoolIndex', index }
  | { type:'kFlag8'|'kFlag16', value }
  | { type:'kFeedbackSlot'|'kEmbeddedFeedback', slot }
  | { type:'kRuntimeId', id, name }     // name 从 runtime.json
  | { type:'kIntrinsicId', id, name }
  ],
  jumpTarget,                     // 绝对 offset，null 表示不是跳转
  jumpTable,                      // [{ caseValue, target }]，用于 SwitchOnSmi*
  sourcePosition, isStatement,    // 来自 8.1 的 sourcePositions，已贴合
  implicitRegisterUse             // kReadAccumulator / kWriteAccumulator / ...
}
```

跳转目标规则（必须按操作数类型定位，不要按 op 名前缀猜）：
`JumpLoop` → `opcodeOffset - delta`；其余 `Jump*` → `opcodeOffset + delta`；
`*Constant` 变体的 delta 在常量池里。

### 8.3 寄存器标识

`profile` 的 `decodeRegister` 必须返回结构化值，不是字符串：

```js
{ k:'acc' } | { k:'param', i }  // i=0 是 this，i>=1 是 a(i-1)
| { k:'local', i } | { k:'context' } | { k:'closure' }
| { k:'newTarget' } | { k:'bytecodeOffset' } | { k:'feedbackVector' }
```

现在 `legacy/src/profile.js` 返回 `'feedback_vector'` 这种字符串，结果直接漏成了
输出里的 JS 变量名。结构化之后这类泄漏在类型上就不可能发生。

### 8.4 `ir/` → `recover/` / `structure/`

```js
{
  blocks: [{ id, startOffset, instructions, preds, succs,
             kind: 'normal'|'loopHeader'|'handler'|'switchDispatch',
             exceptionSuccs }],
  entry, dominators, idom, domFrontier, postDominators, ipdom,
  loops: [{ header, latches, body, exits }],
  values: Map<ssaId, Value>,      // Const | Param | Phi | Op | ContextSlot | CaughtException
  effects: [ssaId, ...],          // 每块内的 effect 全序
  defUse: Map<ssaId, ssaId[]>
}
```

`Value` 的 `Op` 必须带 `hasEffect: boolean` 和 `allocatesIdentity: boolean`
—— §4.3 的受约束内联完全依赖这两个标记。

---

## 7. 不要做的事

* 不要再从二进制里 scrape 表然后 check in（`v8-roots-*.json` / `v8-ro-heap.json` 就是这么坏掉的）。
* 不要在 `src/` 里写版本相关的魔数。
* 不要用「下一条指令是什么」这类局部启发式决定要不要物化语句。
* 不要为了让输出「看起来像 JS」而丢掉不确定性——标记它。
* 不要执行语料里的代码。

---

## 9. W1/W2 落地后，对后端设计的修正

这些是实测数据推翻或细化了前文的地方。做 W3 之前必须读。

### 9.1 `try` 恢复必须先过滤掉 await 脱糖（新增硬要求）

全语料 25189 条 handler range 的 catch prediction 分布：

| prediction | 条数 | 含义 |
|---|---|---|
| **ASYNC_AWAIT** | **13713 (54.4%)** | `await` 的脱糖，**不是** 源码里的 `try` |
| CAUGHT | 5821 (23.1%) | 真正的 `catch` |
| UNCAUGHT | 5655 (22.5%) | 只有 `finally`，没有 catch |

§4.4.5 说「try/catch/finally 来自 handler table 的 range」，这不够。
**三分之二的 handler range 不对应任何源码级 `try`。**
把 25189 条全当 `try` 发射，会有 13713 个凭空出现的 `try`。
`prediction` 字段必须参与判定：`ASYNC_AWAIT`/`UNCAUGHT_ASYNC_AWAIT` 的 range
应该在 async 脱糖识别（§4.3 的 async/await 模式）里被消费掉，而不是走 try 结构化。

基线指标 2 的分母也要改：审计报告写的 `0 / 667` 里 667 是
**异常 opcode 数**（`Throw`/`ReThrow`/`SetPendingMessage`），不是 handler range 数。
同一批 20 个文件的真实 range 数是 **356**（分布在 311 个函数里，占函数总数 8.4%）。
两个数都要报，不要混。

### 9.2 generator / async 的规模比预期大一个量级

`SwitchOnGeneratorState` 在语料里出现 **10068** 次，`SwitchOnSmiNoFeedback` 只有 **1140** 次。
也就是说跳转表的 88% 来自 generator/async 的 resume 分派器，不是 `switch` 语句。
`SuspendGenerator`/`ResumeGenerator` 各 15276 次。函数 kind 统计：
9887 个 async method、2279 个 async arrow、718 个 async function、76+66 个 generator。

推论：§4.4.6 的「删掉分派器，把 suspend 点还原成 yield/await」不是边角功能，
**它是主路径**。T8 的优先级应该是 generator/async 结构化 ≥ 普通循环。

### 9.3 `switch` 语句比想象的少

真正的 `switch` 跳转表只有 1140 个，而且 V8 只在「≥6 个 Smi case 且跨度不大」时才发射跳转表；
case 少或非 Smi 的 `switch` 会编译成比较链（语料里 `switch_strings.js` 验证了这点）。
所以 §4.4.4 的「也要认 if-else 链形态」不是补充项，而是 `switch` 恢复的**主要**形态。

### 9.4 语料里没有未编译函数

239979 个 SFI，239979 个 BytecodeArray，**0 个 `UncompiledData`**。
§0.1 说的「lazy 函数体不可恢复」在这批语料里不发生（QQ 是全量 eager 编译后导出的 cache）。
`uncompiled` 路径已实现并被自写语料覆盖，但对真实语料是死路径。
好消息：输出里不会有洞。

### 9.5 旧实现有一个比审计报告更严重的问题

T3 在搭验证框架时发现：`legacy/src/deserializer.js` 用 `slotIndex >= 6` 判断哪段 raw data 是字节码，
导致它**读不了任何含内层函数的新铸 `.jsc`**。23 字节的复现：

```js
function f(){return 1;}   // -> Malformed BytecodeArray #1: missing bytecode payload
var x = 1;                // -> OK
```

小函数的空 `source_position_table`/`handler_table`/`constant_pool` 会被序列化成
root reference 而不是独立对象槽，raw data 因此出现在 slot 2 而不是 slot 6。
QQ 语料恰好都满足 `slotIndex >= 6`，所以审计报告把反序列化器判为 Working。
连带后果：**旧解编译器读不了自己输出的 cache**，所以 O2 往返定点在旧实现上无法测量。
T4 的 `src/cache/` 已按 `layouts.json` 寻址，这条消失了。

### 9.6 profilegen 的四个静默缺口（已用 overlay 绕过，应回灌）

T4 发现 `profiles/*/layouts.json` 漏了东西，而且 `meta.json → unresolved` **没有记录**：

1. **ScopeInfo 丢了 3 个字段**：`context_local_names`、`context_local_names_hashtable`、
   `function_variable_info` —— 因为它们的 index/condition 表达式里含强制转换调用，
   profilegen 的 Torque 解析器跳过了。这三个是**中间字段**，缺失不只是丢数据，
   而是让后面每个字段的偏移全错位；而 `context_local_names` 就是变量名表本身。
2. `FunctionKind` / `FunctionSyntaxKind` 是普通 C++ enum 不是 Torque enum，
   `layouts.json` 的 `enums` 里没有，但 `SharedFunctionInfoFlags.function_kind`
   就是它的 5 个 bit，且是 `isGenerator`/`isAsync`/`arrow`/`getter`/`setter` 的唯一来源。
3. `LanguageMode` 和 `ElementsKind` 的 Torque 声明顺序 **不等于** C++ 值顺序
   （`kStrict` 在 Torque 里是 0，在 C++ 里是 1；`ElementsKind` 整体错一位）。
4. `0xC0DE0000` magic base 和 `SourceHash` 的位宽不在 `constants.json` 里。

现在由 `tools/layoutpatch/` 从同一批 pinned 源码机械导出 `layouts-overlay/<tag>.json`
补齐，并强制交叉校验（layouts.json 已有的 14 个 ScopeInfo 字段必须逐字段一致，
两个 tag 都是 14/14 相同）。**这是临时方案，应该回灌进 profilegen。**

### 9.7 跨版本的新事实

* `node` 自带的 V8 14.6.202.34 是**无沙箱**构建，它产出的 `.jsc` 里没有
  `kIndirectPointerPrefix`/`kInitializeSelfIndirectPointer` tag，
  而两个 profile 描述的都是**沙箱**构建（Chromium/Electron 的配置，也是语料的配置）。
  所以 14.6 的 `.jsc` 路径走不通，T5 的 14.6 oracle 用的是 listing 模式。
  **`meta.json` 应该记录沙箱开关，`readCache` 应该前置检查**，现在是在反序列化深处报一条看不懂的错。
* Electron 40.0.0 带的 V8 正好是 **14.4.258.16**，`ELECTRON_RUN_AS_NODE=1` 跑它
  产出的 `.jsc` 的 magic（`0xc0de0674`）和 versionHash（`0x12819a30`）与语料**逐位相同**。
  所以铸造测试输入不需要退回 14.6。
* `node --print-bytecode` 对一个 12 行文件会打印 **517** 个函数（它自己的 bootstrap），
  `d8` 只打印 2 个。全文件级 O1 比对必须用 `d8`。
* 强制 `ExtraWide` 的不是字节码长度：跳转距离不够就改用 `Jump*Constant`
  把 delta 搬进常量池。真正会无界增长的可缩放操作数是 **feedback slot 下标**，
  所以触发条件是「单函数内超过 65535 个吃 feedback 的操作」。

### 9.8 已经可用的工具（T6/T7/T8/T9 直接用，不要重写）

```
src/profile/index.mjs        profile 加载器 + 类型化访问器
src/cache/ + src/heap/       .jsc → FunctionUnit（§8.1），1039/1039，0 失败
src/disasm/                  FunctionUnit → Instruction[]（§8.2），与 V8 listing 逐指令一致
src/verify/{oracle,bytecode_parser,normalize,compare}.mjs   O1 比对机
src/verify/{o1_bytecode,o2_fixpoint,o3_behaviour,pipeline,corpus}.mjs  三 oracle + 可替换的 decompile() 接口
corpus/features/             270 条语法特征语料 + manifest
tools/metrics/run.mjs        指标看板 → docs/METRICS.md
tools/oracle/engines.mjs     引擎可插拔的 --print-bytecode 运行器
.v8bin-cache/                d8 14.4.258.17、Electron 40（V8 14.4.258.16）
```

**换后端实现的方式**：`src/verify/pipeline.mjs` 已经把解编译器收在
`decompile(jscPath) -> {code, perFunction}` 一个接口后面，
`V8D_PIPELINE=<module>` 或 `--pipeline <module>` 即可替换。
所以 T9 落地时所有 oracle 和指标收集器一行不用改。

---

## 10. T6 落地后的修正（做 W3 之前必读）

详见 `docs/IR.md`。这里只列推翻本文结论的部分。

### 10.1 §0 的「控制流必定 reducible」是错的，但只差一点

实测 239979 个函数：**121 个（0.0504%）含不可归约回边，共 163 条**。
其中 async 80 个、generator 42 个、**两者都不是的 0 个**。
把 `SwitchOnGeneratorState` 的 resume 跳转边移除后，**剩 0 个**。

形状固定：入口的 resume 分派器跳进循环体中间，构成第二个入口。
所以 §0 的推理是对的，缺的只是一条**顺序约束**：
**T8 必须先删掉 resume 分派器再做循环结构化，不能反过来。**
`goto` 兜底只作保险，不是主路径。

连带推翻另一个「显然」的交叉校验：**back edge 数 ≠ JumpLoop 数**。
async 函数的 `await` 在循环里时，循环体以 `SuspendGenerator` 结尾而它会 **return**，
所以单次调用的 CFG 是无环的，循环只在跨调用时闭合。
18201 条 JumpLoop 是回边，130 条在不可归约区域，**259 条是前向边**（243 个函数）。

### 10.2 §4.2 的 handler 状态模型是错的，不是保守

本文说「handler 入口取 protected range 内所有块状态的 phi 是保守且正确的」。
反例两行：

```js
try { f(); v = 2; g(); } catch { use(v) }   // f() 抛时机器看到旧值，该模型报 2
try { v = 2; g(); f(); } catch { use(v) }   // 取块入口状态则反过来错
```

两个方向都不保守，就是**另一个程序**。理由也不成立：V8 spill 的是跨越 try 的值，
不是 try 内部赋的值。

已改为 LLVM `invoke` 的做法：**protected range 内每条可能抛出的指令结束它所在的块**，
异常边因此携带前驱的正常出口状态，Cytron 放置不需要任何特例。
同一批 12 个文件上并排测量：块 +79%、边 +92%、**phi 反而更少**（2132 vs 2215，
块更细使活跃性剪枝更准），而「handler 读到的变量被同 range 内某块中途写过」
从 **34 降到 0**（全语料 11 次，且都是抛出指令自身的输出，已计数不隐藏）。

### 10.3 §8.1 的 context slot 下标算错了

本文说 `slot - kVariablePartIndex`。`kVariablePartIndex` 是 5，
它是 **ScopeInfo 自身字段表**的下标，不是 Context 的。
正确的是 `ScopeInfo::ContextHeaderLength()`（2，有 extension slot 时 3）。
用本文的写法每个名字都会偏 2~3 个。

更危险的一条：**depth 0 是 `unit.scope.outer`，不是 `unit.scope`**。
`Scope::GetOuterScopeWithContext()` 会跳过不需要 context 的 scope，
而函数自己的 context 是在 prologue 里由 `CreateFunctionContext` + `PushContext` 装上的。
把 `unit.scope` 当 depth 0，对不分配自己 context 的函数会读出一个
**看起来合理的错名字** —— 最糟的失败模式。已用真实 listing 验证修正。

最终：**980989 个 context slot 操作，968489 个（98.726%）解析到真实变量名。**

### 10.4 §8.4 的契约不够用（已扩展，字段名全部保留未改）

* `hasEffect`/`allocatesIdentity` 两个布尔表达不了「纯但顺序敏感」
  （可变 context 读）和「有缓存所以可复制」（`GetTemplateObject`）。
  已加 `effect.{reads,writes,throws,callsUserCode,diverges}` 和
  `allocationKind ∈ {definite, maybe, cached, none}`，两个布尔由它们导出。
  完整分配表在 `docs/IR.md` §7。
* `kind` 不是单值：一个块经常同时是 loop header + handler + switch dispatcher。
  已加 `kinds[]`。
* `succs` **必须**含异常边（否则支配和 SSA 都错），另加 `normalSuccs`/`normalPreds` 给结构化用。
* 缺边表。「按前驱顺序」只有逐**边**才定义良好（同一块到同一块两条边要两个 phi 操作数）。
  已加 `edges[]` 并断言 `preds[j] === edges[inEdges[j]].from`。
* value 种类不够：多输出指令需要 `Proj`（`ForInPrepare`、`CallRuntimeForPair`、`ResumeGenerator`）；
  入口状态需要 `FrameEntry`（没有它，「每个 use 恰有一个到达定义」对任何先读后写的寄存器都不成立）；
  effect 合并需要 `EffectPhi`/`EffectEntry`。`ContextSlot` 是**位置**不是数据流定义。
* 没提出口节点。后支配需要虚拟 exit 加上死循环的补边（全语料需要 0 条）。

### 10.5 发现的两个真 bug（都会静默出错）

1. **`SuspendGenerator` 是终结指令**，它的 handler 以 `Return(GetAccumulator())` 结尾，
   `BuildSuspendPoint` 之后不发 `Return`。当成 fallthrough 会凭空造一条
   「suspend → 对应 resume」的边，12 个文件试跑里**8 个"不可归约"中有 5 个是它造的**。
2. JS 位运算给**有符号** int32，而 `Uint32Array` 读回无符号，
   所以超过 32 个变量时活跃性定点永不终止。表现是 1334 个函数里挂 1 个，不是算错。

### 10.6 语料形状（T7/T8 必须知道）

| 指标 | 值 |
|---|---|
| 单块函数 | **55.13%** |
| 有循环的函数 | 5.35%；循环嵌套深度 0 占 86.8%，**最深 5 层** |
| 有异常边的函数 | 7.60%；**异常边占全部边的 20.95%** |
| 有 generator 分派器的函数 | 4.20% |
| 有真 `switch` 跳转表的函数 | **0.35%** |
| 无 phi 的函数 | 66.29%；phi arity 2 占 79.17%，**最大 896** |
| handler 的异常前驱数 | **一半的 handler 有 ≥9 个抛出点**，最多 896 |
| 每函数最大 context 深度 | 0 占 82.66%，最深 7 |

四条可直接行动的推论：
异常边占五分之一，结构化要用 `normalSuccs`；
phi arity 的长尾全是 handler 的 spill 合并，不是源码级 join；
循环又少又浅；一半语料只有一个基本块（先把这一半做对就有一半产出）。

### 10.7 profilegen 的第五个静默缺口

`layouts.json` 的 `enums.ContextSlot` 只有 `{MIN_CONTEXT_SLOTS: 0}` ——
profilegen 的 Torque enum 读取器丢掉了 `Slot<Context, T>` 类型的成员并从 0 重新编号。
现在由 `src/ir/context.mjs` 数 `contexts.tq` 里那两个通用 `Slot<Context,…>` 成员
（`SCOPE_INFO_INDEX`、`PREVIOUS_INDEX`）加 extension slot 导出，
并在 980989 个真实 slot 操作上验证，每次 CLI 运行都会报告这个缺口。
和 §9.6 的四个一起，应该回灌进 profilegen。

---

## 11. W3 的层间契约（T7 / T8 / T9 并行开发的前提）

W1/W2 的三次并行之所以能合上，是因为 §8 先把字段名定死了。W3 同样如此，
但多一个问题：§4.3（表达式）和 §4.4（控制流）看起来互相依赖
——「`if` 的条件是什么表达式」既是图的问题也是值的问题。

**拆法：T8 只碰图，T7 只碰值，T9 做 join。**
两边都只以 §8.4 的 IR 为输入，彼此不引用，在 T9 处按 §11.3 的不变式对齐。
下面是契约，字段名即契约。

### 11.0 分层规则（已落地，selftest 应当固化）

```
src/profile  src/listing  src/cache  src/heap  src/load
src/disasm   src/ir       src/recover  src/structure  src/emit   src/cli
        ↑ 这些**不得** import src/verify/ 或 tools/ 下的任何东西
src/verify   tools/        ← 可以 import src/，反向不行
```

理由：`src/verify/` 和 `tools/oracle/` 是唯一会 spawn 真 V8 的地方。
解编译路径必须在**类型上**不可能依赖引擎，而不是靠「现在恰好没依赖」。
已修两条反向边：

* `src/disasm/format.mjs` → `src/verify/bytecode_parser.mjs`（`parseOperand`/`splitOperands`）
  → 共用的文本操作数词汇表移到 **`src/listing/operands.mjs`**，渲染器和解析器各自依赖它；
  `bytecode_parser.mjs` 原样 re-export，所有既有调用方不变。
* `src/cli/dump-ir.mjs` → `tools/ir/units.mjs`
  → loader 移到 **`src/load/index.mjs`**（`loadUnits` / `loadUnitsFromAnyProfile` /
  `environmentFor`），`tools/ir/units.mjs` 变成 re-export shim。
  这个 loader 本来就没有引擎依赖，只是方向错了；它也是 §10.3 的
  `scopeInfoById`（自建 context 的变量名）的唯一来源，W3 三层都要用。

验收后 `node tools/disasm/selftest.mjs` 37/37、`tools/oracle/selftest.mjs` ALL PASS、
`tools/ir/selftest.mjs` 56/56 均不变。

### 11.1 `ir/` → `recover/`：`RecoveredFunction`

T7 的输出。**只含直线代码**：所有控制流归 T8。

```js
{
  ir,                               // 输入，原样带上

  // --- 命名：所有命名决策集中在一处，便于审计和去重
  names: {
    byValue:       Map<ssaId, { name, origin }>,
    byContextSlot: Map<slotValueId, { name, origin, declaredAt }>,
    declarations:  [{ name, kind:'var'|'let'|'const'|'param'|'temp',
                      scope: blockId|'function', origin, values:[ssaId] }],
    collisions:    [{ name, values:[ssaId], resolvedTo:[name] }],
  },
  // origin ∈ 'scopeInfo' | 'param' | 'inferredFromUse' | 'synthetic'
  // 'synthetic' 必须服从一条写在 docs/RECOVER.md 里的确定性规则，
  // 并且同一输入两次运行必须给出同一个名字（O2 往返定点会抓这个）。

  // --- 表达式：不是 Babel AST
  exprs: Map<ssaId, Expr>,          // 缺失 = 这个值不是表达式（纯副作用/结构性）
  duplicable: Set<ssaId>,           // §4.3 允许复制到多个 use 的那一小类
  stmts: Map<blockId, Stmt[]>,      // 块内直线语句，按 effect 全序

  // --- 习语匹配结果
  patterns: [{ kind, blocks:[id], values:[ssaId], instructions:[idx],
               confidence:'exact'|'shape', detail }],
  // kind ∈ 'await'|'yield'|'yieldStar'|'forIn'|'forOf'|'destructure'|'spread'
  //      |'class'|'optionalChain'|'logicalAnd'|'logicalOr'|'nullish'|'ternary'
  //      |'template'|'taggedTemplate'|'objectLiteral'|'arrayLiteral'|'typeof'
  //      |'accessor'|'privateField'|'staticBlock'|'restParameter' ...

  // --- T8 不要再结构化的东西（T9 用来交叉校验，不是 T8 的输入）
  consumed: { blocks:Set, edges:Set, instructions:Set, handlerRanges:Set },

  warnings: [...], stats: {...}
}
```

`Expr`（封闭集合，T9 一对一映射到 `@babel/types`；T7 不需要依赖 Babel）：

```
| { e:'lit', v }                        // null|undefined|bool|number|string|bigint
| { e:'regexp', source, flags }
| { e:'name', name, ref }               // ref:{k:'local'|'param'|'contextSlot'|'global'|'temp', ...}
| { e:'this' } | { e:'newTarget' } | { e:'importMeta' }
| { e:'array',  elements:[Expr | {spread:Expr} | null] }
| { e:'object', props:[{ key:Expr|string, computed, value:Expr,
                         kind:'init'|'get'|'set'|'method'|'spread' }] }
| { e:'fn',    sfiId, name, params, isAsync, isGenerator, isArrow }  // T9 递归进去
| { e:'class', sfiId, name, superClass, members:[...] }
| { e:'unary', op, arg } | { e:'update', op, prefix, arg }
| { e:'bin', op, l, r } | { e:'logical', op, l, r }   // op:'&&'|'||'|'??'
| { e:'assign', op, target, value }
| { e:'cond', test, then, alt }
| { e:'member', obj, prop:Expr|string, computed, optional }
| { e:'call', callee, args:[Expr|{spread:Expr}], optional }
| { e:'new', callee, args }
| { e:'template', quasis:[{raw,cooked}], exprs }
| { e:'tagged', tag, quasi }
| { e:'seq', exprs }
| { e:'await', arg } | { e:'yield', arg, delegate }
| { e:'hole', why, detail, dump }       // 唯一允许的「不知道」
```

`Stmt`：

```
| { s:'expr', expr }
| { s:'decl', kind, decls:[{ id:Pattern, init:Expr|null }] }
| { s:'return', arg } | { s:'throw', arg } | { s:'debugger' }
| { s:'hole', why, detail }
```

每个 `Expr`/`Stmt` 带 `pos:{ sourcePosition, isStatement }`（来自 §8.2）
和 `values:[ssaId]`（可追溯到字节码，source map 和 O1 定位都要）。

### 11.2 `ir/` → `structure/`：`StructuredFunction`

T8 的输出。**只含图的形状，不含任何表达式**。

```js
{
  ir,
  root: Region,
  placed: { blocks:Set<id>, edges:Set<edgeId> },     // 放进树里的
  unstructured: [{ blocks:[id], why, dispatchVar }],
  removed: { generatorDispatchers:[{ block, resumeEdges:[edgeId] }],
             asyncHandlerRanges:[handlerIndex] },
  labels: [{ id, forRegion, usedBy:[...] }],
  warnings: [...], stats: {...}
}

Region =
| { r:'seq',   body:[Region] }
| { r:'block', id }                                  // 叶子：发射 T7 的 stmts[id]
| { r:'if',    test:Test, then:Region, else:Region|null }
| { r:'loop',  form:'while'|'doWhile'|'for'|'forever',
               test:Test|null, init:Region|null, update:Region|null,
               body:Region, label }
| { r:'forIn', left:Target, right:Test, body:Region, label }
| { r:'forOf', left:Target, right:Test, isAwait, body:Region, label }
| { r:'switch', disc:Test, cases:[{ test:Test|null, body:Region }],
                form:'jumpTable'|'compareChain', label }
| { r:'try',   block:Region, param:Target|null, handler:Region|null,
               finalizer:Region|null, handlerIndex }
| { r:'labeled', label, body:Region }
| { r:'break', label|null } | { r:'continue', label|null }
| { r:'unstructured', blocks:[id], dispatchVar, why }   // 兜底，计数不隐藏

Test   = { block, value:ssaId, negate:boolean }   // 「block 末尾这个 SSA 值」
Target = { value:ssaId } | { slotValue:ssaId }
```

**关键设计**：T8 从不说「条件是 `a > b`」，只说「条件是 block 7 终结指令读的那个 SSA 值，取反」。
值到表达式的映射是 T7 的，join 在 T9。这样两边可以零通信并行。

T8 的三条硬约束（都来自实测，不是风格偏好）：

1. **先删 resume 分派器，再做循环结构化**（§10.1）。顺序反了会有 121 个函数
   不可归约；顺序对了是 0 个。分派器识别用 T6 已经导出的
   `ir.contextChain.suspendOfResume` / `suspendByIdIns`，不要重新从 opcode 猜。
2. **用 `normalSuccs`/`normalPreds` 做结构化**（§10.6：异常边占全部边的 20.95%）。
   `succs`/`preds` 含异常边，拿它做支配是对的，拿它做 `if/else` 是错的。
3. **`prediction === ASYNC_AWAIT` 的 handler range 一条都不许发 `try`**（§9.1：
   25189 条里 13713 条是 await 脱糖）。它们进 `removed.asyncHandlerRanges`，
   由 T7 的 `await` 模式消费。

### 11.3 join 不变式（T9 必须断言，T7/T8 必须满足）

这六条是契约的可执行部分，`src/emit/verify.mjs` 跑在每个函数上：

1. **覆盖**：每个可达且未被 `removed` 的块，在 region 树里**恰好出现一次**
   （作为 `{r:'block'}`，或在某个 `unstructured` 区域内）。
2. **join 可解**：树里每个 `Test.value` / `Target.value`，
   `recovered.exprs` 都有条目。缺一个就是 T7 的缺口，报 `hole` 不许静默。
3. **语句唯一**：T8 放过的块，它的每条 `Stmt` 恰好发射一次。
4. **不重复求值**：同一个 `ssaId` 在输出里出现多次，当且仅当它在
   `recovered.duplicable` 里（这是指标 6「12.93% 重复求值」归零的判据）。
5. **`ctx` 禁止出现**：输出里不得有标识符 `ctx`。
   名字恢复不了就发 `/* ctx[d][i] */` 注释 + 显式声明的占位变量（§4.5）。
6. **洞必须计数**：每个 `{e:'hole'}`/`{s:'hole'}`/`{r:'unstructured'}` 进
   `report`，数量出现在指标看板里。correct-but-ugly 可接受，silently-wrong 不可。

### 11.4 `emit/` 的输出 = 现有 oracle 的输入

`src/verify/pipeline.mjs` 已经把解编译器收在
`decompile(jscPath) -> { code, perFunction }` 后面，所以 T9 只要满足这个签名，
三个 oracle 和指标看板一行不用改：

```js
{
  code,                       // 一个文件的 JS
  map,                        // source map（来自 §8.1 的 sourcePositions）
  ast,                        // Babel File 节点，便于程序化检查
  perFunction: [{ sfiId, bytecodeId, name, code, startPosition, endPosition,
                  holes, unstructuredRegions, duplicatedValues,
                  unresolvedNames, patterns }],
  report: { ...§11.3 的六条断言结果, 指标 1/2/5/6/7/9/10 的原始计数 }
}
```

### 11.5 三个任务各自的验收线

不写「跑通了」，写数字。基线见 `tools/metrics/baseline.json`。

| | 必须达到 | 怎么测 |
|---|---|---|
| **T7** | 55.13% 的单块函数（§10.6）表达式**全部**有 `exprs` 条目，0 个 `hole`；全语料 `duplicable` 之外无重复求值；命名 origin 分布可报告，`scopeInfo` 占比 ≥ §10.3 的 98.726% | `tools/recover/selftest.mjs` + `corpus_scan.mjs` |
| **T8** | 18201 条回边 → 循环语句 **100%**（指标 1，基线 0/167）；11208 个跳转表里 10068 个分派器被删除且删除后不可归约数 = **0**；5821 条 CAUGHT + 5655 条 UNCAUGHT handler range → `try` 100%，13713 条 ASYNC_AWAIT → `try` **0 个**（指标 2）；`unstructured` 区域数**报告**出来 | `tools/structure/selftest.mjs` + `corpus_scan.mjs` |
| **T9** | §11.3 六条不变式 0 违反；1039 个文件、239979 个函数**全部**进入输出（指标 5，基线 38.76%）；输出里 `ctx` 出现 **0** 次（基线 1710336）；O1 匹配率（指标 4，基线 20.81%）报告并对比 | `tools/emit/selftest.mjs` + `tools/metrics/run.mjs` |

### 11.6 不要重复造的东西

T6 已经把 T7/T8 会想自己算的都算好了并挂在 IR 上（§10.4）：
`edges`/`inEdges`、`normalSuccs`/`normalPreds`、`idom`/`ipdom`/`domFrontier`、
`loops` + 嵌套森林、`liveIn`/`liveOut`、`effectGraph`、`defUse`、
`contextChain.suspendOfResume`、`blockEntryVersion`/`blockExitVersion`、
每个 `Op` 的 `effect.{reads,writes,throws,callsUserCode,diverges}` 和
`allocationKind ∈ {definite,maybe,cached,none}`。
受约束内联（§4.3）完全建立在最后两个之上，**不要用 opcode 名字做判断**。
