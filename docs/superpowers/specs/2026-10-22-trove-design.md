# Trove — AI 资产归档工具 · 设计文档

- **日期**:2026-10-22
- **⚠️ 已被取代**:本版描述的是整文件指纹 + manifest 的 v1 设计;sync 已按 Beacon poll 骨架重构,见 `2026-10-22-trove-poll-refactor.md`。本文件仅作历史记录。
- **状态**:待评审
- **作者**:brainstorming 会话

---

## 1. 背景与目标

本机运行着多个 AI agent(Claude Code、Codex、豆包等),它们的对话记录、skills、配置散落在各自的隐藏目录里。这些是长期积累、无法重建的**个人资产** —— 一旦误删、换机、磁盘损坏就永久丢失。

Trove 的目标:**把这些资产可靠地、增量地归档到一个受信任的远端(WebDAV),并支持多台设备汇聚到同一份档案库。**

### 成功标准

- 换一台新机器,配好 WebDAV 后,能自动拉回全部历史对话
- 日常同步只传增量,不重传全量
- 同步过程不修改源文件任何一个字节
- 归档内容永不丢失(不存在自动删除路径)
- 常驻后台,新会话在分钟级出现在远端

---

## 2. 非目标(v1 明确不做)

这些是**经过讨论后主动推迟**的,不是遗漏:

| 不做 | 原因 |
|---|---|
| **Codex / 豆包 adapter(v1 不实现)** | 先把单个 adapter 端到端跑通,验证架构成立后再横向扩展。见 §16 的已知缺口 |
| 对话归一化存储(SQLite / 统一 schema) | 归一化模型尚未想清楚。先做保真归档,以后随时能从归档重建 |
| `trove sessions` 命令(会话列表/搜索) | 依赖归一化模型。等模型定了再做,避免造一层到时候要推翻的抽象 |
| 全文索引 / 语义搜索 | 属于消费层,用户明确表示先不考虑 |
| LLM 提炼流水线 | 同上 |
| MCP server(让 agent 主动检索) | 同上 |
| skills / config 的「应用到本机」能力 | 只归档不应用。换机后需手动复制到原生位置 —— 这是已知代价 |
| 任何形式的删除 | 见原则 3 |
| vault 结构重组(按项目/时间统一编排) | 会导致多设备文件重排,必然冲突 |

---

## 3. 核心原则(六条铁律)

### 原则 1:源文件零改写

collect / push 全程**不修改 agent 的原始文件一个字节**。归档是复制,不是转换。

### 原则 2:白名单,不是黑名单

每个 agent adapter 内置一份**明确列出要搬什么**的清单。新目录默认不搬。

> 为什么:agent 升级新增一个 3G 的缓存目录时,白名单自动忽略它,黑名单会自动把它传上去。
> 风险不对称 —— 漏传可以以后补,泄密不可逆。

### 原则 3:只增不删

vault 和远端**都永不删除**。没有 `prune` 命令,没有自动清理,没有例外。本地清理了旧会话,vault 里那份永远留着。磁盘满时 `doctor` 报告占用,但绝不自删。

由此推出一个必须明确的概念:

> **vault 不是源目录的"同步副本",是"曾经出现过的所有内容的累积归档"。**
> 源目录删了 → vault 不动。源目录改了 → vault 追加。

### 原则 4:push 只做增量,绝不整体覆盖

push **只推manifest 判定需要推的文件**。绝不执行"本地 vault 快照覆盖远端 vault 快照"。

原因:本地 manifest 损坏或新设备未拉全时,本地 vault 是残缺子集,整体覆盖会抹掉远端大量数据。

**"本地缺失"永远不等于"远端该删"。**

### 原则 5:凭证只存 config.json,不进 vault

WebDAV 密码明文存 `config.json`(文件权限 600),不依赖系统钥匙串以便跨平台。凭证类文件(`auth.json` 等)在 adapter 层被硬性排除,连本地 vault 都不落地。

### 原则 6:planner 是纯函数

从"扫描结果"到"操作计划"的转换**不含任何 IO、时钟、随机数**。这是把可靠性从"祈祷"变成"证明"的支点(见 §9)。

---

## 4. 实测事实基础

设计基于对目标机器的实际探查,而非假设。以下为关键发现。

### 4.1 体量与信噪比

| 目录 | 总量 | 真正有价值的对话 |
|---|---|---|
| `~/.claude` | **1.4G** | `projects/` **106M**(187 个 jsonl) |
| `~/.codex` | **776M** | `sessions/` **31M** + `archived_sessions/` 2.4M |

**信噪比仅约 6%。** 其余为 `plugins/`(1.2G + 335M)、`logs_2.sqlite`(195M)、`computer-use/`(63M)、`downloads/`(12M)、`telemetry/` 等 —— 全部排除。

### 4.2 Claude Code 结构

```
~/.claude/projects/{转义项目路径}/{uuid}.jsonl
例: -Users-pz-orca-trove / -Volumes-Data2-workspace-pixen
    转义规则:/ → -,- → --,反解时 -- → -,单个 - → /,从左到右扫描无歧义
```

**无独立 meta 行** —— 首行是 `queue-operation`。元数据散落每行:
`sessionId` · `timestamp` · `uuid` · `parentUuid` · `cwd` · `gitBranch` · `version` · `permissionMode`

**会话标题来自 `ai-title` 行**,由 AI 自动生成:
```json
{"type":"ai-title","aiTitle":"HistoryPanel onImageClick prop wiring","sessionId":"..."}
```

类型分布(24MB 样例,4763 行):`assistant` 1268、**`attachment` 1143(占 24%)**、`user` 835、`permission-mode`/`mode`/`last-prompt`/`atis-latch` 各 201、`ai-title` 198、`file-history-delta` 92、`agent-name` 43、`system` 28、`queue-operation` 18。

### 4.3 Codex 结构

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ISO时间}-{uuid}.jsonl
```

**首行即完整 `session_meta`**,含 `session_id` · `cwd` · `timestamp` · `originator` · `cli_version` · `model_provider` · `base_instructions`(完整 system prompt,高价值资产)。

事件类型:外层 `response_item` 180 / `event_msg` 103 / `turn_context` 11 / `session_meta` 10 / `world_state` 3;payload 内层 `function_call_output` 56 / `function_call` 56 / `token_count` 44 / `reasoning` 34 / `message` 34 / `agent_message` 17 / `task_started` 11 / `task_complete` 11 / `user_message` 10。

> **更正一条早期误判**:曾根据 `session_meta` 出现 10 次推断"一个文件承载 10 个会话"。实测确认这 10 条 `session_id` **完全相同**,是每次 resume 重复写入 meta。
> **结论:Claude Code 与 Codex 都是「一个文件 = 一个会话」。**

### 4.4 两个 agent 的共同点与差异

| | Claude Code | Codex |
|---|---|---|
| 文件 ↔ 会话 | 一一对应 | 一一对应 |
| meta 位置 | 散落各行 | 首行完整 |
| 标题 | `ai-title` 行 | 无,需取首条 user message |
| 追加行为 | append | append(resume 时重写 meta) |

**对同步算法而言,两者都是 append-only,这正是增量方案成立的前提。**

### 4.5 豆包

```
~/Library/Application Support/Doubao    2.9G  ← Chromium 内核开销,全垃圾,排除
~/Doubao                               8.0K  ← chats/ skills/ 真正的资产目录(均空)
```

用户基本未使用豆包,**对话格式无法验证**。设计为 `experimental`,默认禁用。LevelDB 可能存有对话(`Default/Local Storage/leveldb/`),但格式为二进制且运行中写入,需实际使用后另行探索。

---

## 5. 架构总览

两级流水线:

```
各 agent 原始目录                  本地 vault                  远端 vault
──────────────────────────  ─────────────────────  ─────────────────────
~/.claude/projects/*.jsonl  ┐                     ┌── push(增量 + 指纹校验)
~/.codex/…(v1 不启用)        ├── collect ──→ devices/{我}/  ──→│
豆包/(v1 不启用)              ┘                     └───→ 统一档案库
                                ↑
                         pull ↓(先于 push,只拉别人)
                      devices/{设备B}/  ←────┘
```

**为什么拆成两级**:

1. **远端成为干净的统一档案库**,而非一堆带设备前缀的碎片 —— "多设备互相看"体验正常
2. `collect` 与 `sync` 可各自独立失败、独立重试
3. daemon 的触发链清晰:agent 目录变化 → collect → vault 变化 → push

---

## 6. 目录结构

### 6.1 本地 `~/.trove/`

**单一镜像库,按设备分区。** 本地结构与远端完全同构 —— push/pull 是同一映射的正反两面。

> **base 可迁移**:默认 `~/.trove`,可用环境变量 `TROVE_HOME` 覆盖整个 base(配置 + vault + manifest + 日志 + tmp 一并迁走)。用途是主盘满了把归档迁到数据盘 —— 例如 `TROVE_HOME=/Volumes/Data2/.trove`。注意不要把 base 塞进 WebDAV 数据根内部,否则 vault 会与远端镜像在服务根内混叠。

```
~/.trove/
├── config.json               配置(设备身份、WebDAV 引用、agent 开关)
│
├── vault/                    ★ 单一镜像库(只增)
│   ├── devices/
│   │   ├── {我的device_id}/  ← collect 写入(本机 agent)
│   │   │   ├── claude-code/projects/{转义项目路径}/{uuid}.jsonl
│   │   │   └── codex/…                (后续 adapter)
│   │   ├── {设备B}/           ← pull 写入
│   │   └── {设备C}/           ← pull 写入
│   └── .trove/
│       └── manifest.json     push 状态(仅本地,不进远端)
│
├── logs/
│   ├── daemon.log            进程日志(滚动)
│   └── sync/2026-10-22.jsonl 每次同步明细
│
└── tmp/                      上传拼接临时文件(完成即删)
```

**为什么合并原先的 vault / inbox 二元结构**:

- 用户心智里只有一件事 ——「我的 AI 资产都在这儿」,不该被劈成两个目录
- `status` 只报一个总数,不必分别汇总
- 未来做检索层时不必合并两个数据源
- **自冲突问题自然消失**:push 只推 `devices/{我}/`,pull 只拉 `devices/{别人}/`,不会把自己的内容重复存一份

**v1 不需要索引层**:`trove status` 显示会话数只需数 `.jsonl` 数量,项目分布只需反解目录名(纯字符串操作),均无需解析文件内容。

### 6.2 vault 内部布局原则

**设备分区之下,保留各 agent 的原生结构,只加 agent 前缀。** 三个目的:

- **保真** — collect 是复制,字节不变
- **不冲突** — 项目路径转义天然含本机用户名,`-Users-pz-orca-trove` 与 `-Users-wang-orca-trove` 永不冲突
- **可追溯** — agent 前缀保留来源

> **禁止**:把 vault 重组成按项目/时间的统一编排。那会导致多设备文件重排、必然冲突。

### 6.3 远端

**与本地 §6.1 同构**(去掉了 manifest,它是纯本地的):

```
/trove/
├── a3f2c81e/                      ← device_id(不可变)
│   ├── meta.json                  ← {id, name, lastSeen}
│   └── claude-code/projects/{转义项目路径}/{uuid}.jsonl
└── b91d4a07/                      ← 另一台设备
    └── ...
```

**目录名用 `device_id` 而非 `device_name`**:后者用户会改,改名会产生新目录导致历史散落。id 一次生成永不变,显示时读该设备自己的 `meta.json` 转成可读名。

**每设备一个 `meta.json`,不使用全局 `devices.json`** —— 后者在多设备并发 push 时会因读-改-写竞态丢失条目,而它只用于存显示名,收益极低、风险明确。

---

## 7. 数据模型

### 7.1 指纹 Fingerprint

```ts
interface Fingerprint {
  size: number       // 字节数
  mtime: number      // 修改时间(ms)—— 仅用于本地缓存判定
  headHash: string   // 前 512 字节的 hash
}
```

`headHash` 是增量正确性的锚点 —— 它证明"远端已有内容确实是本地内容的前缀"。

**字段取舍说明**:

- **不含 `tailHash`** —— 原设计有,但没有任何判定规则用到它。size + headHash 已能判定全部情况(append 增量 / 指纹失效 / 远端截断)。YAGNI,删除。
- **`mtime` 不可跨设备比较** —— 不同文件系统、不同机器的时钟。**`mtime` 只用于本地缓存加速,跨设备判定一律用 `size` + `headHash`。**

### 7.2 manifest

```ts
interface ManifestEntry {
  path: string           // vault 内相对路径
  fingerprint: Fingerprint
  syncedSize: number     // 已确认同步到远端的字节数
  syncedAt: number
}
```

**仅本地保存,per-device,不进远端。** 不含 `deviceId` 字段 —— manifest 本身就是单设备的,冗余。

### 7.3 为什么不需要同步 manifest

早期设想"manifest 随远端走,新机器免全量扫描"。**在「只增不删」前提下,该需求自动消失:**

远端永不删除 → 一台新机器 pull 时,**远端就是完整的真相**:

```
PROPFIND 深度遍历远端 → 全量文件列表
   ↓ 对每个文件,查本地 vault/devices/{对方}/ 是否存在且指纹一致
   ├─ 一致   → 跳过
   └─ 缺失/不同 → 下载
```

**本地文件系统本身即状态存储**,新设备零预热直接工作。这消除了"多设备 manifest 并发写冲突"这一整类问题。

---

## 8. adapter 设计

### 8.1 接口

**v1 只实现 Claude Code 一个 adapter。** 接口本身仍按可插拔设计 —— 如果单 adapter 跑不通,做三个也只会得到三倍的烂摊子。先验证抽象成立,再横向扩展。

adapter 是**纯声明式**的,不含任何同步逻辑:

```ts
interface Source {
  id: string                    // 'claude-code'
  displayName: string
  root: string                  // 扫描根目录
  patterns: Pattern[]           // 白名单:哪些路径进 vault
  exclusions: Exclusion[]       // 硬性排除(凭证等)
  mapToVaultPath(absPath: string): string
}
```

接一个新 agent = 新增一个描述文件 + 一组 fixture 测试,**不改动任何同步逻辑**。

> **未来扩展的准入门槛**:新 adapter 必须先有 fixture 测试覆盖其白名单产出,才允许合并。否则一个错误的 glob 会静默漏备份,比不做更危险。

### 8.2 内置白名单(v1:仅 Claude Code)

**Claude Code** (`~/.claude`)

| 路径 | 处理 |
|---|---|
| `projects/**/*.jsonl` | ✅ 纳入(106M) |
| `history.jsonl` | ✅ 纳入(540K) |
| `skills/**`, `CLAUDE.md`, `RTK.md` | ✅ 纳入 |
| `plans/**`, `tasks/**`, `file-history/**` | ✅ 纳入 |
| `settings.json` | ❌ **排除** |
| `plugins/**` | ❌ 排除(1.2G,可由 marketplace 重新 install) |
| `downloads/`, `telemetry/`, `paste-cache/`, `backups/`, `daemon.log`, `shell-snapshots/` | ❌ 排除 |

**为什么 `settings.json` 直接排除而非脱敏**:

脱敏就是改写,与原则 1(源文件零改写)直接冲突 —— 同一份数据上跑两套规则,迟早不一致。而这文件只有 7.3K,**排除的代价远小于一个可能泄密的例外**。换机后重新配一次即可。

**Codex**(`~/.codex`)与**豆包**(`~/Doubao`):见 §16「已知资产缺口」,后续以 adapter 形式逐个加入。

### 8.3 凭证处理

- WebDAV 密码明文存 `config.json`,文件权限 **600**(仅属主可读写)—— 跨平台统一,不依赖 macOS Keychain / keytar
- 密码来源优先级:`--password` flag → `TROVE_PASSWORD` 环境变量 → 交互式 `@clack` 隐藏输入
- 凭证类文件属于**代码级硬排除**,连本地 vault 都不落地
- v1 中 `settings.json` 直接排除,故当前无任何脱敏逻辑 —— **保持零例外**

---

## 9. 增量与冲突算法

### 9.1 planner:纯函数决策

```
输入:扫描结果[] + manifest + 远端探测结果
输出:操作计划[] —— { path, action: 'skip' | 'append' | 'full', offset?, reason }
无 IO · 无时钟 · 无随机数
```

判定规则:

```
指纹完全一致                    → skip
size 只增 且 headHash 未变       → append(offset = syncedSize)
其他(size 变小 / headHash 变了) → full
```

### 9.2 读取时跳过残行

活跃会话文件正在被追加写入,读取时可能落在半行 JSON 上。

**读取规则:只取到最后一个完整换行符,丢弃末尾残行。** 残行下次同步时自然被补上。

### 9.3 offset 续传前的强制校验

这是**唯一可能静默损坏数据**的位置 —— offset 假设一旦破裂,写入的是错位拼接,不报错,只是内容报废。

```
记着已同步 offset=1000,准备续传
   ↓
拉远端前 512 字节 ──→ 与本地前 512 字节比对
   ├─ 相同 → 确认纯追加,从 1000 续传  ✅
   └─ 不同 → 假设破裂,降级为全量重传  🔄 (绝不尝试拼接)
```

**只比 size 不足以保证** —— size 相同但内容不同的情况真实存在。因此用内容比对。

**不依赖 WebDAV 的 ETag** —— 多数 WebDAV 服务端(含坚果云)对分块上传的 ETag 支持不可靠,可能返回 null。

### 9.4 Range PUT 降级

WebDAV 的 Range PUT 支持不统一。`init` 的连通性探测会判定:

- 支持 → `Content-Range` 只传增量
- 不支持 / 探测失败 → 拉全量到 `~/.trove/tmp/` → 拼接 → 整份 PUT

**探测不到时默认走"不支持"路径** —— 慢一点,但正确。

### 9.5 dry-run 与真实同步同源

`--dry-run` 停在 planner 之后。因为 planner 是纯函数,**预览和真实同步走完全相同的决策代码**,不存在"预览与实际不一致"这类经典缺陷。

### 9.6 pull 的无状态实现

见 §7.3。`sync` 顺序为 **先 pull 再 push**:先取回远端最新,再推自己的增量,消除互相覆盖的时间窗口。

---

## 10. CLI 命令

| 命令 | 作用 |
|---|---|
| `trove init` | 初始化:设备身份 → WebDAV → 数据范围 → 验证 → 装 daemon |
| `trove config` | 查看/修改配置(`get` / `set` / `path` / `sources`) |
| `trove collect` | agent 原始目录 → 本地 vault |
| `trove sync` | vault ↔ 远端(pull → push) |
| `trove daemon <start\|stop\|restart\|status\|logs>` | daemon 生命周期 |
| `trove doctor` | 诊断 |
| `trove status` | 同步总览 |
| `trove logs` | 同步明细日志 |

### 10.1 `trove init` 六步

```
1. 设备身份    device_id(uuid,首次生成后不变) + device_name(默认 hostname)
2. WebDAV     url / username / password(密码写入 config.json,权限 600)
3. 数据范围    勾选 agent → 展示各 agent 白清单(可逐条增减)
4. 远端布局    确认 {device_id}/{agent}/... 并创建目录
5. 连通验证    PROPFIND 根目录 → 检查读写 → 写探针文件→ 读回 → 删
               同时探测 Range PUT 支持能力,结果记入 manifest
6. daemon     是否安装启动项
```

**第 5 步必须做真实写入测试** —— 只 PROPFIND 通过不代表能 PUT。写探针、读回、删除,才算真的通了。

**第 6 步默认不跑首次全量同步** —— 137M 首次上传耗时长,塞在 init 里体验差。首次同步由用户显式触发 `trove sync`。

### 10.2 `trove config`

```jsonc
// ~/.trove/config.json
{
  "device": { "id": "a3f2c81e", "name": "pz-macbook" },
  "remote": {
    "url": "https://dav.example.com/trove/",
    "username": "webdav",
    "password": "***"
  },
  "sources": {
    "claude-code": { "enabled": true },
    "codex":       { "enabled": true },
    "doubao":      { "enabled": false }
  },
  "include": [],        // 手动追加白名单(叠在 adapter 内置清单之上)
  "exclude": [],        // 手动排除
  "sync": {
    "settleDelay": 30,        // 秒,文件静默多久才算写完
    "concurrency": 4,          // 并发上传数
    "minFileAge": 10,          // 秒
      }
}
```

`include` / `exclude` **叠加**在 adapter 内置清单之上,配置只能增不能减内置项 —— 保证用户始终知道自己在同步什么。

### 10.3 `trove sync`

```
trove sync                    pull → push
  --push-only / --pull-only
  --dry-run只打印计划,不传字节
  --force                     忽略指纹,强制全量重传
  --concurrency N             默认 4
```

**顺序是 pull 在前、push 在后** —— 先取回远端最新,再推自己增量,消除互相覆盖的时间窗口(见 §9.6)。

```
① SCAN    遍历本地白名单 → vault 文件列表 + 指纹
② PULL    PROPFIND 深度遍历远端 → 跳过 devices/{我}/ → 与本地 vault/devices/{对方}/ 比对 → 下载缺失/不同的
③ PLAN    planner(纯函数):vault × manifest → push 操作计划
④ EXEC    并发上传;失败重试 3 次(指数退避);单文件失败不中断整轮
⑤ REPORT  合并 pull 与 push 结果:下载/上传/跳过/失败各多少
```

> ② 与 ③ 是两套独立判定:pull 用「远端列表 × 本地现状」,push 用「本地 vault × manifest」。二者都用指纹比对,但不共享计划。
> **② 必须跳过自己的设备目录** —— 本机内容已在 vault 里,再拉一遍就是重复。

### 10.4 `trove status`

```
设备 pz-macbook (a3f2c81e)                 上次同步 2 分钟前 ✓成功

本地归档  [pz-macbook]
          claude-code  187 个会话 · 106 MB
          [work-mac]
          claude-code  312 个会话 · 31 MB
远端      499 个会话 · 142 MB   [来自 2 台设备]

待同步 3 个文件 · 1.2 MB
  xxx.jsonl    增量 +45 KB          ← 活跃会话,offset 续传
  yyy.jsonl    全量 2.1 MB          ← 指纹失效,重传
  zzz.jsonl    新文件 380 KB
```

### 10.5 `trove doctor`

| 检查项 | 说明 |
|---|---|
| WebDAV 连通性 | PROPFIND + 真实写入/读回/删除 |
| Range PUT 支持 | 探测并记录,决定上传策略 |
| 凭证泄漏扫描 | 检查 vault 与远端是否出现 `auth.json`、含 key 的字段 |
| manifest 完整性 | 校验指纹可重算、条目与实际文件一致 |
| 磁盘空间 | vault / tmp 占用 |
| 源目录可访问性 | 各 adapter 的 root 是否存在、是否可读 |

---

## 11. daemon 设计

### 11.1 监听范围严格等于白名单

```
监听 ~/.claude/projects/  ~/.claude/skills/  ~/.codex/sessions/ ...
不监听 ~/.claude/plugins/ ← 1.2G、数千文件
```

**否则会持续 stat 插件树,白烧 IO,还可能与 agent 自身的文件监控冲突。**

### 11.2 settle delay:何时算写完

```
agent 写入文件        → 标记 pending
      ↓ 每 5s 扫 pending 队列
   距最后一次变化 > settleDelay(默认 30s)?
      ├─ 否 → 继续等
      └─ 是 → 读取(只取到最后一个完整换行,丢弃残行)
                → collect 到 vault → vault 变化 → push
```

**两级去重**:agent 目录 → vault(collect),vault → 远端(push)。同一秒写入 50 次也只触发一次 collect。

### 11.3 空闲成本与注册

- 目标空闲 CPU **< 0.1%**;chokidar 事件驱动 + 空队列时轮询降频
- macOS:launchd agent,`KeepAlive` + `RunAtLoad`,崩溃自动重启
- 日志:`~/.trove/logs/daemon.log`;同步明细:`~/.trove/logs/sync/YYYY-MM-DD.jsonl`

---

## 12. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript** | WebDAV 客户端生态比 Go 成熟;`webdav` v5.11.0 上月仍活跃,自带类型 |
| 运行时 | Node 22(主)/ Bun 1.3(可选) | 两条分发路径都通 |
| WebDAV | `webdav` npm 包 | ✅ 活跃 ✅ 纯 JS 无原生依赖 ✅ 自带 TS 类型 |
| | ~~`webdav-fs`~~ | ❌ 停更于 2022 |
| | ~~`node-webdav`~~ | ❌ 停更于 2023 |
| manifest 存储 | **JSON**(非 SQLite) | `better-sqlite3` 是原生模块,会破坏 Bun 单文件编译。JSON 天然可 diff、可调试、原子写入 |
| 文件监听 | chokidar | 事实标准 |
| 分发 | `npm i -g` 主路径 / `bun build --compile` 可选 | 主路径便于改源码;后者产出独立二进制 |

---

## 13. 测试策略

**核心保障:`planner` 是纯函数,因此无需 WebDAV 服务器即可测试核心正确性。**

| 层 | 方式 |
|---|---|
| `planner` | 输入 fixture 列表 + manifest → 断言决策。覆盖:跳过 / 增量 / 全量 / 指纹失效 / size 变小 / head 变化 |
| adapters | 给定 fixture 源目录 → 断言产出的文件清单与脱敏结果 |
| 残行处理 | 构造截断末行的 fixture → 断言被丢弃且下次能补齐 |
| WebDAV | 用 `webdav` 包的 server 模式起本地服务器做集成测试 |
| 端到端 | 真实小样本目录走完整 collect → push → pull → 校验字节一致 |

**最高价值的测试**:大文件追加同步后的字节级一致性(本地 vs 远端 hash 相同)。

---

## 14. 实施阶段(供 writing-plans 使用)

本 spec 涵盖多个子系统,需分阶段落地。**每个阶段结束时系统都可用**,不存在半成品状态。

### 阶段 1:单机归档闭环(最小可用)

范围:CLI 骨架、config、Claude Code adapter、collect、WebDAV push/pull、planner、status

- 只支持单设备、单个 agent
- 增量先用「全量比对 + 整传」,不实现 offset 续传
- 验证目标 WebDAV 的真实行为(读写、PROPFIND 深度遍历、大文件上传)
- **产出**:一个会话文件写完后,能在另一台机器拉回来且字节一致

> 阶段 1 刻意**不做** offset 续传。先用最笨的方式验证"归档正确性",正确性成立后再优化传输。

### 阶段 2:增量优化

范围:指纹系统、`append` 动作、head 512 字节校验、Range PUT 探测与降级、残行处理、`--dry-run` / `--force`

- 核心验收:大文件(25MB 级)反复追加同步后,本地与远端 hash 一致
- 核心测试:`planner` 的决策表全部覆盖

### 阶段 3:多设备

范围:device 分区布局、`pull` 无状态实现、`--push-only` / `--pull-only`、`meta.json`

- 验收:两台设备各自产生会话,互不覆盖,任一设备能拉到对方的

### 阶段 4:daemon

范围:chokidar 监听(仅白名单路径)、settle delay、两级去重、launchd 注册、进程日志、健康心跳

- 验收:产生新会话后分钟级出现在远端,空闲 CPU < 0.1%
- **同时解决**:daemon 死亡与「上次同步成功」的区分(见 §16)

### 阶段 5:Codex adapter

范围:`~/.codex` 白名单、`sessions/` 与 `archived_sessions/` 映射、`auth.json` 硬排除

- 准入门槛:fixture 测试覆盖白名单产出
- **需先决策**:Codex 记忆系统(`memories_1.sqlite`)的同步方式,见 §16

### 阶段 6:运维完善

范围:`doctor`、`logs`、`config` 交互完善、错误重试与断点、WebDAV 限流处理

---

## 15. 已否决的方案

| 方案 | 否决理由 |
|---|---|
| 归一化 SQLite 作为主存储 | 解析不可逆、丢失原始结构;且 SQLite 热文件难同步 |
| push 时"本地快照覆盖远端" | 本地残缺时会抹掉远端数据(见原则 4) |
| `prune` / 任何删除命令 | 归档工具的删除是唯一不可逆操作 |
| vault 结构重组(按项目/时间) | 多设备文件重排必然冲突 |
| 黑名单式扫描 | 未知目录会被自动上传 |
| Go / Rust | TS 的 WebDAV 生态更成熟;Rust 对本项目是过度工程 |
| 依赖 WebDAV ETag 做增量 | 多数服务端不可靠 |
| 全局 `devices.json` | 多设备并发 push 会丢失条目,改为每设备 `meta.json` |
| `settings.json` 脱敏后入库 | 脱敏即改写,违反原则 1;直接排除 |
| fingerprint 携带 `tailHash` | 无判定规则使用,YAGNI 删除 |
| 直接复制 SQLite 主库 + WAL | 会得到逻辑不一致的撕裂快照 |
| vault / inbox 双目录 | 增加认知负担且易自重复;合并为单一镜像库 |
| v1 建索引层 | `status` 只需数文件与反解目录名,无需解析内容 |

---

## 16. 已知资产缺口

**本节具名记录当前设计明确不保护的资产。** 之所以单列一节,是因为**静默的资产丢失比明确报错更危险** —— 用户会合理地以为"它被备份了",实际没有。

### 16.1 Codex 整体未纳入(v1 不实现 adapter)

`~/.codex/sessions/`(31M)与 `archived_sessions/`(2.4M)**当前完全未保护**。设计决策:先验证单 adapter 架构成立。

### 16.2 Codex 记忆与目标系统 ★

实测发现 Codex 有两个**正在运行的记忆库**:

| 库 | 表 | 内容字段 | 当前状态 |
|---|---|---|---|
| `memories_1.sqlite` | `stage1_outputs` | `raw_memory` · `rollout_summary` · `usage_count` · `selected_for_phase2` | **0 行** |
| `goals_1.sqlite` | `thread_goals` | `objective` · `status` · `token_budget` · `tokens_used` | **0 行** |

> WAL 分别为 14M / 9M,初看像有大量数据;**复制后连同 WAL 读取确认表内无有效行**。Codex 尚未积累记忆。

**风险**:一旦 Codex 开始积累记忆,这就是高价值资产,而当前零保护。

**技术障碍**:活跃 SQLite + WAL **不能直接复制** —— 主库与 WAL 抄到一半会得到逻辑不一致的快照,不报错但内容错乱。安全归档需 `VACUUM INTO` 生成一致性副本,**这是原则 1 的唯一例外**(字节不再相同,但逻辑一致 —— 远好于字节一致而内容撕裂)。

**v1 决策:排除。** 阶段 5 实现 Codex adapter 时必须解决。

> **建议补救**:`doctor` 增加一项检查 —— 这两个库一旦出现数据行就告警。**让缺口可见,而不是静默。**

### 16.3 豆包

`~/Library/Application Support/Doubao` 2.9G 全是 Chromium 内核开销(Safe Browsing、ShaderCache、PKIMetadata…),已正确排除。真正的资产目录 `~/Doubao/{chats,skills}` **当前为空且格式未验证**,等实际使用后再探索。

### 16.4 skills 只归档不应用

vault 里的 skills 躺在 `devices/{对方}/claude-code/skills/`,**本机 agent 永远不会去那里读**。换机后需手动复制到 `~/.claude/skills/` 才生效。

这是用户明确选择的已知代价(「先只做同步」)。同样地,路径转义使远端会话**无法被本机 agent resume** —— 拉下来的目录名对不上本机任何真实路径。

### 16.5 为保真付出的存储代价

Claude Code 会话中 `attachment` 类型行约占 **24% 体积**。因原则 1 不做去重,**这些冗余持续消耗存储与带宽**。这是保真的代价,不是缺陷 —— 但用户应知情。

---

## 17. 未决问题与后续

### v1 之后

- Codex adapter(阶段 5),含记忆系统的 `VACUUM INTO` 方案
- 豆包实际使用后的格式探索与 adapter 实现
- `trove sessions` —— 待归一化模型确定后实现
- 全文索引 / 语义搜索层
- MCP server:让 agent 主动检索历史资产
- LLM 提炼流水线:对话 → skill / 决策记录
- `trove export`:导出单段对话为 Markdown

### 需要实机验证的风险点

1. **目标 WebDAV 服务端的 Range PUT 支持** —— 若不支持,大文件增量退化为全量拼接,性能显著下降
2. **大文件 PROPFIND 性能** —— 数万文件时的深度遍历耗时
3. **活跃会话的写入模式** —— 是否存在非尾部写入(将破坏 offset 假设)
4. **Claude Code 是否会改写已有 jsonl 行** —— 当前样本未见,但需长期观测

### 设计中待补的机制

- **daemon 健康与同步成功需区分** —— 当前 `status` 显示「上次同步 ✓ 成功」,但 daemon 若已崩溃,显示仍是绿色。需要心跳时间戳。
- **WebDAV 限流与配额** —— 429 / 507 状态码未处理,`--concurrency 4` 可能被服务端拒绝。
- **本地 vault 生命周期未定义** —— 只增不删 + 长期积累会持续增长;是否支持从远端重建本地,留待后续。