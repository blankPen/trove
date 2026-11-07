<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/logo-dark.png">
  <img src="docs/logo/logo-light.png" width="112" alt="trove">
</picture>

# trove

### 每一段对话，都是一座宝库。

**Claude Code、Codex、OpenCode、豆包的会话——无损归档到你自己的 WebDAV 或 S3，**<br>
再合并成跟着你所有设备走的个人资产库。

[![Release](https://img.shields.io/npm/v/trove-cli?label=release&color=111111)](https://www.npmjs.com/package/trove-cli) [![Stars](https://img.shields.io/github/stars/blankPen/trove?style=flat&color=111111)](https://github.com/blankPen/trove/stargazers) [![License](https://img.shields.io/badge/license-MIT-111111)](LICENSE)<br>
![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-000000?logo=node.js&logoColor=white) ![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white) ![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black) ![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)

[English](README.md) · **简体中文**

<br>

</div>

<br>

## trove 适合你吗？

每个 AI 编码工具都把历史记录存在你控制不了的地方。Claude Code 写 `~/.claude/projects` 下的 JSONL，Codex 写 `~/.codex/sessions`，OpenCode 在一个 SQLite 数据库里，豆包在工作区目录里。换电脑、重装工具，原始字节还在，**但那些真正值钱的东西——你在做什么、做过什么决定、学到了什么——哪儿都没有**。

trove 把这些原始素材变成你留得住的东西：

- **无损归档。** 本地 vault 是每个源文件的逐字节副本。不做摘要、不丢内容、进来的时候不改写一个字节。
- **存你自己的地方，不是别人的。** WebDAV（Nextcloud、坚果云、自建 davfs）或任意 S3 兼容存储（阿里云 OSS、腾讯云 COS、MinIO）。不用注册账号，没有遥测，中间没有别人的服务器。
- **增量，而且一直保持增量。** `{size, mtime, 前缀哈希}` 组成的游标意味着：没变就跳过，变大只传新增字节，被原地重写就整份重建。
- **多设备。** 每台设备只写自己的文件和索引分片，两台机器同步不会互相覆盖。把笔记本的会话拉到桌面上，把桌面的技能推到笔记本。
- **是资产库，不是垃圾桶。** 会话按 `(工具, 会话 id)` 归并，技能按内容哈希去重且保留所有版本，抽取出的经验——偏好、项目、调试套路——变成你能读能搜的 Markdown。
- **从自己的历史里学习。** 一个 LLM 读那些你根本没空回看的会话，把它们提炼成 17 类记忆：你的编码风格、你做的项目、踩过的坑、做过的决定。

如果你丢过一段对话、想在另一台机器上找到某个会话，或者想问过「上个月我到底怎么决定的」，你就需要它。如果只有十几段会话而且从不回头看，那就不需要。

## 快速开始

**1 · 安装。**

```sh
npm i -g trove-cli      # 提供 `trove` 命令
npx trove-cli --help    # 也可以免安装试用
```

npm 上不带 scope 的 `trove` 是别人的包，所以本项目发布为 **`trove-cli`**，命令行还是 `trove`。需要 Node.js 22.13 或更高版本（`node:sqlite` 从该版本起不再需要实验开关）。

**2 · 指向远端。** 跑交互式配置，它会先问你远端是哪一类，再按类型问对应字段：

```sh
trove init
```

或者跳过提问：

```sh
trove init --url https://dav.example.com/ --username u --password p
trove init --type s3 --provider aliyun --region cn-hangzhou \
  --bucket my-bucket --access-key-id AKID --secret-access-key SK --no-daemon
```

**3 · 同步。**

```sh
trove sync --since 7d
```

配置到这儿就完了。默认会拉起 daemon，在后台把归档保持最新。

## 支持的数据源

| 工具 | 会话存放位置 | 归档内容 |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl`、`~/.claude/transcripts/**/*.jsonl` | 两套互不重叠的会话存储，外加 skills、plans、tasks 和 `CLAUDE.md` |
| **Codex** | `~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/**/*.jsonl` | rollout 原始 JSONL + skills |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | `session_v2`/`session_message` 与旧表 `session`/`message`/`part` 的并集，逐会话导出确定性 JSONL（两套序列化都保留，保留全部列） |
| **豆包**（办公版） | `~/Library/Application Support/DoubaoWork/.../agent_mode/workspace` | `.sessions/<id>` 的 board/memory/agents 轨迹 + `conversation/<id>` |

凭证类文件（`settings.json`、`auth.json`、`config.toml`、`*.key` 等）在适配器层硬排除，不会离开你的机器。任何工具都能单独关掉：`trove config set sources.<id>.enabled false`。

## 整体结构

```
你的工具                 你的机器                    你的存储
──────────              ──────────                ──────────
Claude Code ─┐
Codex       ─┤        ┌──────────────────┐    ┌──────────────────┐
OpenCode    ─┼──────▶ │  ~/.trove/vault   │───▶│  WebDAV / S3     │
豆包        ─┘        │                  │    │                  │
                     │  raw/    设备事实 │    │  raw/    设备事实 │
                     │  library/ 合并资产│    │  library/ 合并资产│
                     └──────────────────┘    └──────────────────┘
                              ▲
                              │ 一个游标，一次同步，多台设备
```

**raw/ 是机器看见的东西。** 每个源文件的原始字节，按设备分目录。它是事实，不是加工品。

**library/ 是它真正的含义。** 跨工具、跨设备合并成一条规范化的会话流，按内容哈希收拢的技能，统一索引，以及从这些素材里抽取出的经验。

两层一起同步。`raw` 是大头，如果你愿意可以只留在本地——`trove config set sync.raw false` 只同步资产库，`--raw` / `--no-raw` 可以在单次运行时覆盖这个设置。

## 它做了什么

### 无损、增量的同步

- **每个文件一个游标**——`{size, mtime, 前缀哈希, 世代}`。没变就跳过；变大只搬新增字节；变小、同尺寸改写、前缀哈希不符，就在新的世代下整份重建。
- **进来的时候逐字节不变。** vault 里是原始字节，不是它的某种渲染。OpenCode 从数据库导出，新旧两套 schema 的每一列都保留（实测 782 会话 / 153,406 行 / 990MB）。
- **WebDAV 存块，S3 存对象。** WebDAV 没有原生分片上传，所以远端文件按不可变的 4 MiB 分块存；S3 一个文件一个对象，你能在桶控制台直接打开会话读原文。两种方式拉取时都校验 sha256。
- **分块路径是扁平的。** 块落在 `<device>/chunks/<tool>/`，这样一次同步不用为每个文件做一次 `MKCOL`。S3 上大文件走 Multipart Upload。
- **实测**：二次全量扫描 2450 项耗时 14s、上传 2 项。

### 多设备互不冲突

每台设备只写自己的文件和自己的索引分片，所以永远不会并发覆盖。同一会话在两台设备上内容不同时，索引会选一个 canonical（事件超集），其余进 `variants`——所有版本都保留，一个都不丢。

索引本身是派生物：`index/<device>.json` 是权威，`index.json` 由本地合并生成；索引可以重建，重建不等于丢数据。

### library 层

```
~/.trove/vault/
├── raw/<device>/<tool>/…            原始字节（设备 × 工具）
└── library/                          个人资产（同步）
    ├── index.json                    统一索引（派生物，可重建）
    ├── index/<device>.json           每设备索引分片（只由该设备写）
    ├── sessions/<tool>/<session>/<device>.jsonl
    ├── skills/<name>/versions/<hash>/…   内容寻址，保留各版本
    ├── skills/<name>/meta/<device>.json
    └── lessons/                      经验沉淀（同步）
```

事件 schema 仍是 `session / message / reasoning / tool_call / tool_result / meta`，带 `raw: {path, line}` 回指原始文件。

### lessons——会话真正教会你的东西

这部分不只是备份。trove 拿 LLM 读你根本没回看过的会话，把结果写成 Markdown，按 17 类记忆、5 个大类组织：

| 分类 | 类型 |
|---|---|
| **偏好** | 用户画像、编码风格、写作风格、对话风格、近期事项 |
| **实体** | 项目、人物、组织、工具、技术栈 |
| **经验** | 调试模式、操作流程、陷阱坑、纠正教训 |
| **事件** | 决策 |
| **资源** | 文档、代码仓库、链接 |

每一类都有自己的合并规则，所以重跑时该更新的更新、该追加的追加。每条记忆都标着来源会话，`trove learn --list` 能看到抽取器到底加了什么、改了什么。

```sh
trove learn -n 10              # 从最近 10 个未学习会话里提取
trove learn --list             # 审计上一次提取
trove learn-memo               # 把 Claude Code 自带的记忆文件学进来
trove learn-recent             # 聚合你近期的工作方向
trove refresh                  # 重建分层概览
```

提取需要一个 OpenAI 兼容端点，配一次就好：

```sh
trove config set llm.baseUrl https://api.deepseek.com/v1
trove config set llm.model deepseek-chat
trove config set llm.apiKey sk-…
```

之后 `trove usage` 会按任务和模型报告这部分的花费。

### 不打扰你的 daemon

```sh
trove daemon start --interval 300 --since 7d
trove daemon status
trove daemon restart
trove daemon stop
```

每台机器一个实例（pid 锁）、跨进程 sync 锁、`SIGTERM` 协作中止、状态写 `~/.trove/daemon.status.json`、日志轮转。间隔、时间窗、`init` 是否自动启动都由 config 决定（`config.daemon.{intervalSeconds,since,startOnInit}`，默认 `300 / 7d / true`），显式参数优先于配置。通过 `trove config` 改动配置会自动重启运行中的 daemon，让新的启动参数生效。learn 是独立的一圈循环，有自己的间隔（`config.daemon.learnIntervalSeconds`、`learnBatch`）。

### 检索与概览

```sh
trove status                    # 本地、远端、daemon、待同步
trove sessions --grep refactor  # 搜标题、摘要、目录、模型
trove sessions --harness codex --json
trove skills show review        # 某技能的全部版本与来源
trove library reindex           # 从设备分片重建统一索引
trove usage --since 7d --json
trove whoami                    # 用户画像、偏好、近期方向
trove lessons search "飞书 编辑" # FTS5 检索经验
trove lessons show <path>       # 读单条 lesson
trove sessions search "COS 签名" # FTS5 会话检索
trove sessions search "SignatureDoesNotMatch" --exact  # 线性精确检索
trove sessions show <id> --around "SignatureDoesNotMatch"
trove index build               # 构建/更新会话检索索引
trove status --json             # 机器可读概览
```

`trove status` 报四件事：每个工具在本地归档了多少（数量和体积）、远端是否可达（5 秒探测、设备数、最后在线时间）、daemon 的状态和最近一轮结果、还剩什么没同步（按会话 / 文件 / 技能分类计数）。

### 检索后端：本地 qmd 或阿里百炼云端

默认走 [qmd](https://github.com/tobi/qmd)：BM25 + 查询扩展 + HyDE + 本地向量 + LLM 重排，全程离线。5 个记忆类目注册成 qmd collection，共用一份索引（`~/.trove/cache/qmd.sqlite`），由 `trove learn` 增量重建。嵌入模型是 `Qwen3-Embedding-0.6B`（GGUF、q8），经 `node-llama-cpp` 本地运行；qmd 还需要它的查询扩展（1.7B）与重排（0.6B）模型，合计约 2.3 GB，首次下载到 `~/.cache/qmd/models`，仅该次下载需要联网。

也可以把向量换成阿里百炼云端：不下载、不启动任何本地模型，检索改为 FTS5 词法 + 云端向量 RRF 融合，索引缓存到 `~/.trove/cache/cloud-vectors.sqlite`：

```sh
trove config set learn.search.provider dashscope
trove config set learn.search.dashscope.apiKey sk-xxx   # 百炼 API Key
# 可选：dashscope.model（默认 text-embedding-v4）、dashscope.dimension（默认 1024）、
#       dashscope.baseUrl（默认北京地域；国际站改为 dashscope-intl 域名）
trove daemon restart   # 启动时按新配置重建向量索引
```

云端按 token 计费（text-embedding-v4 约 0.5 元/百万 token，含 100 万 token 新用户免费额度），只有索引增量更新和每次查询会消耗。`provider=local` 时本地配置仍生效：`learn.search` 的 `enabled`、`model`、`host`（作为 `HF_ENDPOINT` 的 Hugging Face 镜像，默认 `https://hf-mirror.com`）、`minScore`。降级可靠：无网络、缺模型/key、索引为空或损坏都回退纯 FTS5，命令不会报错。

注意：本地混合检索要走一遍本地模型，冷查询是秒级而不是毫秒级；qmd 会缓存查询扩展，同一查询重复问会快很多。云端模式每次查询多一次网络往返（通常几十到几百毫秒）。

### 给 agent 的知识库（skill + MCP）

`trove mcp` 通过 stdio 暴露 7 个只读工具；`trove skill install` 把配套 skill 安装到 `~/.claude/skills` 与/或 `~/.agents/skills`。CLI 与 MCP 一一对应：

| MCP 工具 | CLI | 返回 |
|---|---|---|
| `trove_whoami` | `trove whoami` | 用户画像、偏好、近期方向 |
| `trove_lessons_search` | `trove lessons search` | 经验：偏好、实体、经验、决策 |
| `trove_lesson_get` | `trove lessons show` | 单条 lesson，可按小节或行范围读取 |
| `trove_lessons_list` | `trove lessons list` | 浏览某个类目 |
| `trove_sessions_search` | `trove sessions search` | 历史会话；精确标识符加 `--exact` |
| `trove_session_get` | `trove sessions show` | 命中位置附近的事件 |
| `trove_status` | `trove status --json` | 索引与数据新鲜度 |

检索底层是 Node 22 内置 `node:sqlite` 的 **SQLite FTS5 + BM25**，中文按 2-gram 预处理。lessons 用进程内索引（约 280ms 冷构建）；sessions 用持久化增量索引 `~/.trove/cache/search.sqlite`（本机缓存，可删除重建，不参与同步）。报错码、函数名、路径等精确标识符用 `--exact` 线性 grep 兜底——它会覆盖索引只保留前 1KB 的工具输出。

```bash
claude mcp add trove -- trove mcp
trove skill install --target both
```

### 删除必须显式

默认两边都不删任何东西。你删掉的源文件仍然留在归档里；唯一的删除入口是 `trove clean`，它只删没有任何索引引用、且超过 24 小时的远端对象。

```sh
trove clean --dry-run   # 只列出
trove clean             # 列出后交互确认（默认否）
trove clean --yes       # 直接删
```

安全边界：设备索引缺失时整台设备跳过；library 任一分片读取失败则整个 library 跳过；`lessons/**`、合并后的会话文件、技能 metadata 一律保留；24 小时内上传的对象、没有时间戳的对象不删。daemon 永不触发清理。

## 命令速查

| 命令 | 作用 |
|---|---|
| `trove init` | 首次配置：设备名、远端类型、凭证 |
| `trove rename <name>` | 重命名当前设备（设备 id 与已归档路径不变） |
| `trove sync` | 收集本机会话并同步（collect → pull → push） |
| `trove clean` | 清理不再被索引引用的远端旧对象（超过 24 小时） |
| `trove status` | 概览：本地、远端、daemon、待同步 |
| `trove sessions` | 列出和检索 library 会话 |
| `trove whoami` | 用户画像、偏好、近期方向 |
| `trove lessons` | 对经验做 `search` / `show` / `list` |
| `trove sessions search` | FTS5 会话检索；精确标识符加 `--exact` |
| `trove sessions show` | 读取命中位置附近的事件 |
| `trove index build` | 构建/更新会话检索索引 |
| `trove mcp` | 启动 stdio MCP 服务 |
| `trove skill` | 安装/卸载 trove skill |
| `trove skills` | 列出汇总后的技能，或 `show <name>` 看全部版本 |
| `trove library reindex` | 从设备分片重建统一索引 |
| `trove learn` | 提取经验，或 `--list` 审计上一轮 |
| `trove learn-memo` | 学习 Claude Code 自带的记忆文件 |
| `trove learn-recent` | 聚合近期工作方向 |
| `trove refresh` | 重建 lessons 分层概览 |
| `trove usage` | trove 自身 LLM 调用的 token 用量 |
| `trove config` | 交互式配置，或 `get`/`set`/`path` |
| `trove daemon` | `start`、`restart`、`stop`、`status` |

`trove sync` 的常用参数：`--since 7d|24h|2026-10-01|all`（只收集之后有变更的会话）、`--pull-only`、`--push-only`、`--raw` / `--no-raw`、`--quiet`。

## 远端后端

| 后端 | 配置方式 | 说明 |
|---|---|---|
| **WebDAV** | `trove init --url … --username … --password …` | 默认后端，兼容自建与第三方网盘 |
| **阿里云 OSS** | `--type s3 --provider aliyun --region cn-hangzhou --bucket …` | S3 兼容，走 virtual-hosted 寻址 |
| **腾讯云 COS** | `--type s3 --provider tencent --region ap-guangzhou --bucket …` | S3 兼容；Bucket 名需带 `-<appid>` 后缀 |
| **任意 S3 兼容** | `--type s3 --endpoint … --force-path-style --region … --bucket …` | MinIO 等私有部署 |

交互式配置会先问远端类型，再按类型问对应字段。

**换后端不会丢东西。** 索引、设备元信息与 library 布局在两种后端下一致，只有 raw 文件布局按后端区分。`state.json` 里的 `remoteId` 记录了推送水位属于哪个远端——检测到后端变了，旧水位自动作废，历史数据整份重推（不会「以为推过了」而静默跳过）。切换后跑一次 `trove sync --since all` 即可。旧布局留下的 `chunks/` 对象不会自动删除。

## 本地布局

```
~/.trove/
├── config.json              设备身份与远端凭证（权限 600）
├── state.json               游标 + 推送/拉取水位 + library 记录
├── usage.jsonl              trove 自身 LLM 调用的 token 用量（只追加，不同步）
├── daemon.pid / daemon.status.json
├── vault/raw/<device>/<tool>/…   归档的原始字节
├── vault/library/                个人资产（会话 / 技能 / 索引 / lessons）
├── tmp/                    导出与重建的临时文件
└── logs/daemon.log
```

远端布局：

```
raw/<device>/index.json                            索引（含每文件块清单与哈希）
raw/<device>/meta.json                             设备名 / lastSeen
raw/<device>/chunks/<tool>/<key>.<gen>.<off>-<len>.bin   WebDAV：不可变块
raw/<device>/files/<tool>/<relPath>                     S3：完整文件
library/index/<device>.json                        每设备索引分片
library/sessions/…、library/skills/…               个人资产
```

## 开发

```sh
pnpm test          # 单元测试 + 真实 WebDAV 服务 + 真实本机会话扫描
pnpm typecheck
pnpm build
```

## 发版

合并到 `main` 即自动发版（`.github/workflows/release.yml`）：在 PR 里改好 `package.json` 的 `version`，CI 会装依赖 → 构建 → 跑测试 → 发布到 npm → 打 tag `v<version>` 并生成 GitHub Release（附带 npm 包 tarball）。

一次性配置（npm 侧）：npmjs.com → 包的设置 → Trusted Publisher → GitHub Actions，填 `blankPen` / `trove-cli` / `release.yml`，并允许 `npm publish`。之后 CI 用 OIDC 直接发布，不需要长期 token。仍用 token 的话：仓库 Settings → Secrets and variables → Actions → 新建 `NPM_TOKEN`（granular access token，Read and write（publish and stage）并勾选 Bypass 2FA）。只用 stage only 的 token 只会把版本暂存，需要 `npm stage approve <stage-id> --otp <code>` 才会真正上线。

重复触发是幂等的：npm 上已有该版本就跳过发布，GitHub Release 已存在就跳过建 Release，两样都做完就整体跳过。

## 许可

[MIT](LICENSE)
