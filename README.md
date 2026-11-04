# trove

AI 会话资产归档工具:把本机 Claude Code / Codex / OpenCode / 豆包的会话**无损**归档到 WebDAV 或 S3 兼容对象存储,并支持多设备增量同步。

## 用法

```bash
# 首次配置(设备名、远端后端、凭证)
# 默认会拉起 daemon 并立即跑首轮同步;只写配置用 --no-daemon
# 交互式:trove init 会先问远端类型(WebDAV / S3),再按类型问对应字段
trove init
trove init --url https://dav.example.com/ --username u --password p
trove init --url https://dav.example.com/ --username u --password p --no-daemon

# S3 兼容对象存储(阿里云 OSS / 腾讯云 COS)
trove init --type s3 --provider aliyun --region cn-hangzhou \
  --bucket my-bucket --access-key-id AKID --secret-access-key SK --no-daemon
trove init --type s3 --provider tencent --region ap-guangzhou \
  --bucket my-bucket-1250000000 --access-key-id AKID --secret-access-key SK --no-daemon
# 私有 S3 兼容部署(MinIO 等):自定义 endpoint + path-style 寻址
trove init --type s3 --endpoint http://127.0.0.1:9000 --force-path-style \
  --region us-east-1 --bucket my-bucket --access-key-id AKID --secret-access-key SK --no-daemon

# 同步:默认全量;日常建议限定时间窗
trove sync --since 7d
trove sync --since all          # 首次全量归档
trove sync --pull-only          # 只拉取其他设备
trove sync --push-only          # 只推送本机
trove sync --no-raw             # 只同步 library(raw 只归档到本地)
trove sync --raw                # 强制同步 raw(覆盖配置)
trove config set sync.raw false # 默认只同步 library,可被 --raw 覆盖
trove sync --quiet              # 不显示逐项进度

# 概览与检索
trove status                    # 本地 / 远端 / daemon / 待同步
trove sessions                  # 列出 library 会话(最近 50 个)
trove sessions --grep PATH      # 在标题/摘要/目录/模型/正文里搜
trove sessions --harness opencode --json
trove skills                    # 汇总后的技能(最新版本)
trove skills show review        # 某技能的全部版本与来源
trove library reindex           # 从设备分片重建统一索引

# 知识库消费层(skill + CLI/MCP 查询)
trove whoami                    # 用户画像 / 偏好 / 近期方向
trove lessons search "飞书 编辑" # 检索经验/实体/偏好/决策
trove lessons show <path>       # 读单条 lesson
trove sessions search "COS 签名" # FTS5 会话检索(1–6ms)
trove sessions search "SignatureDoesNotMatch" --exact  # 精确 grep(2–5s)
trove sessions show <id> --around "SignatureDoesNotMatch"
trove index build               # 构建/更新会话检索索引
trove mcp                       # 启动 stdio MCP(7 个只读工具)
trove skill install             # 安装 skill 到 ~/.claude/skills 与 ~/.agents/skills
trove usage                     # trove 自身 LLM 消耗的 token 用量
trove usage --since 7d --json   # 限定时间窗,机器可读

# 常驻服务:间隔/时间窗默认取 config.daemon,显式参数优先
trove config set daemon.intervalSeconds 300
trove config set daemon.since 7d
trove config set daemon.startOnInit false   # init 不再自动启动
trove daemon start                          # 等价于每 300s、时间窗 7d
trove daemon start --interval 60 --since 24h
trove daemon restart                        # 停止后按同样参数重新拉起
trove daemon status
trove daemon stop
```

`trove status` 输出四段:

- **本地**:各工具已归档的会话数与体积
- **远端**:5 秒超时探测,显示可达性、设备数与各设备上次在线时间
- **daemon**:运行状态、间隔、时间窗、上次/下次同步与最近一轮结果
- **待同步**:raw 层按工具分会话/文件数;library 按「会话 / 技能 / 索引」分类计数(只给计数,不逐条列)。
  会话数按 `sessionKey` 去重,同一会话的多个文件算 1 个;Claude 子代理文件没有会话归并规则,会被算作独立会话。
  `config.sync.raw=false` 时只显示「raw 同步已关闭」与 library 待同步。

## 知识库消费层(skill + MCP)

`trove mcp` 暴露 7 个只读工具，`trove skill install` 安装配套 skill；CLI 与 MCP 一一对应：

| MCP 工具 | CLI | 用途 |
|---|---|---|
| `trove_whoami` | `trove whoami` | 用户画像/偏好/近期方向 |
| `trove_lessons_search` | `trove lessons search` | 经验/实体/偏好/决策 |
| `trove_lesson_get` | `trove lessons show` | 读单条 lesson |
| `trove_lessons_list` | `trove lessons list` | 浏览目录 |
| `trove_sessions_search` | `trove sessions search` | 历史会话 |
| `trove_session_get` | `trove sessions show` | 读会话片段 |
| `trove_status` | `trove status --json` | 索引/数据状态 |

检索底层：Node 22 内置 `node:sqlite` 的 **FTS5 + BM25**，中文按 2-gram 预处理。lessons 用进程内索引（约 280ms 冷构建）；sessions 用持久化增量索引 `~/.trove/cache/search.sqlite`（本机缓存，可删除重建，不参与同步）。报错码/函数名/路径等精确标识符用 `--exact` 线性 grep 兜底。

接入：

```bash
claude mcp add trove -- trove mcp
trove skill install --target both
```

## 支持的数据源

| 工具 | 位置 | 归档内容 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`、`~/.claude/transcripts/**/*.jsonl` | 两套互不重叠的会话原始 JSONL + skills/plans 等小资产 |
| Codex | `~/.codex/sessions/**/*.jsonl`、`archived_sessions/**` | rollout 原始 JSONL + skills |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session_v2`/`session_message` 与旧表 `session`/`message`/`part` 的并集,逐会话导出确定性 JSONL(两套序列化都保留,保留全部列) |
| 豆包(办公版) | `~/Library/Application Support/DoubaoWork/.../agent_mode/workspace` | `.sessions/<id>` 的 board/memory/agents 轨迹 + `conversation/<id>` |

凭证类文件(`settings.json`、`auth.json`、`config.toml`、`*.key` 等)在适配器层硬排除。

## 同步模型(Beacon poll 骨架)

- **游标**:`{size, mtimeMs, prefixHash, generation}`。size+mtime 未变直接跳过;文件增长只搬新增字节;size 回退/同尺寸改写/前缀哈希不符 → 换世代全量重建。
- **无损**:本地 vault 是源文件的原始字节副本;OpenCode 是数据库全字段导出(新旧表并集,实测 782 会话 / 153,406 行 / 990MB)。WebDAV 远端按 4MiB 分块(大请求不稳),S3 一个文件一个对象,拉取时都校验 sha256。
- **增量**:WebDAV 远端只传新增块,块路径扁平到 `<device>/chunks/<harness>/`,避免每文件多次 MKCOL;S3 按文件覆盖写,大文件走 Multipart Upload。清单并入设备索引(`<device>/index.json`)。实测二次全量扫描 2450 项仅 14s、上传 2 项。
- **只增不删**:远端和本地 vault 默认不删除;源文件被删后归档仍保留。唯一的删除入口是 `trove clean`(显式确认,只删索引不再引用且超过 24 小时的旧对象)。
- **时间窗**:`--since 7d|24h|2026-10-01|all` 按会话最近变更时间过滤,避免首次全量过大。
- **进度**:collect / pull / push 三阶段,TTY 单行刷新,管道按秒节流。
- **daemon**:单实例 pid 锁、跨进程 sync 锁、SIGTERM 协作中止、状态写 `~/.trove/daemon.status.json`、日志轮转。间隔/时间窗/init 是否自动启动由 `config.daemon.{intervalSeconds,since,startOnInit}` 决定(默认 `300 / 7d / true`),`daemon start --interval/--since` 显式参数优先于配置。`daemon restart` 先优雅停止再按同样参数拉起;旧进程没停干净时不会起第二个实例。

## library(个人资产层)

`raw/` 是设备事实,`library/` 是合并后的个人资产,随同步一起走:

```
~/.trove/vault/
├── raw/<device>/<harness>/…                原始字节(设备 × 工具)
└── library/                                个人资产(同步)
    ├── index.json                          统一索引(派生物,可重建)
    ├── index/<device>.json                 每设备索引分片(只由本设备写)
    ├── sessions/<harness>/<session>/<device>.jsonl
    ├── skills/<name>/versions/<hash>/…     内容寻址,保留各版本
    ├── skills/<name>/meta/<device>.json    来源与版本
    └── lessons/                            学习沉淀(同步)
```

- **归组**:按 `(harness, sessionId)` 归并同一会话的多份 raw——Claude 主文件 + `subagents/*.jsonl`、豆包 `.sessions` + `conversation`。
- **冲突**:每台设备只写自己的文件和分片,远端不存在并发覆盖。同一会话内容不同时,索引选 canonical(事件超集;豆包按事件 id 求并集),其余进 `variants`,文件永远保留。
- **索引**:`index/<device>.json` 是权威,`index.json` 由本地合并生成;索引冲突只需重建,不会丢数据。
- **技能**:按目录内容 hash 去重,来源由 `SKILL.md` frontmatter 与 `.git/config` origin 判定(`self/github/skillsh/unknown`);最新版本按 semver → updatedAt → hash 选择,历史版本保留。
- **lessons**:按主题沉淀经验,内容用 `(harness, session, seq)` 引用会话。与 sessions/skills 一起同步;没有设备分片,多设备各自 learn 时同路径文件按最后写入覆盖,拉取只在本地缺失时恢复,不会覆盖本机刚生成的内容。

事件 schema 仍是 `session/message/reasoning/tool_call/tool_result/meta`,带 `raw:{path,line}` 回指原始文件。

## 同步模型补充

- library **始终同步**(约 500 MB):推送本设备的会话文件、技能、lessons 与索引分片,拉取其他设备的分片与文件。
- raw 是否上传/拉取按 **命令行 > `config.sync.raw` > 默认 true** 决定;关闭时只同步 library,raw 只归档到本地。
- 配置示例:`trove config set sync.raw false`;`trove sync --raw` 可临时覆盖。
- 索引分片按设备隔离,拉取时落盘后本地重建统一索引。

## LLM 用量统计

trove 自己调用 LLM 的场景(手动 `trove learn`、daemon 每轮同步后的经验提取)会把每次调用的 token 用量追加到 `~/.trove/usage.jsonl`:时间、任务(如 `learn:summarize`)、模型、输入/输出/合计 tokens。`trove usage` 按任务与模型汇总,`--since` 限定时间窗,`--json` 输出机器可读结果。

该台账只统计 trove 自身调用 LLM 的消耗,不包含被归档会话里的 usage 字段;Jev 打分走 TypeSafe API,响应不含 token 用量,因此不计入。台账只留本机,不参与同步。

## 本地布局

```
~/.trove/
├── config.json              设备身份与远端凭证(600)
├── state.json               游标 + 推送/拉取水位 + library 记录(原子写)
├── usage.jsonl              trove 自身 LLM 调用的 token 用量(只追加,不同步)
├── daemon.pid / daemon.status.json
├── vault/raw/<device>/<harness>/...       原始字节归档
├── vault/library/                         个人资产(会话/技能/索引/lessons)
├── tmp/                     OpenCode 导出与 library 重建临时文件
└── logs/daemon.log
```

远端布局(索引与设备元信息一致;raw 文件按后端区分):

```
raw/<device>/index.json                            索引(含每文件块清单与哈希)
raw/<device>/meta.json                             设备名 / lastSeen
raw/<device>/chunks/<harness>/<key>.<gen>.<off>-<len>.bin  WebDAV:不可变块
raw/<device>/files/<harness>/<relPath>             S3:完整文件(控制台可直接浏览)
library/index/<device>.json                        每设备索引分片
library/sessions/…、library/skills/…               个人资产
```

WebDAV 服务端没有原生分片上传,只能按 4 MiB 块存;对象存储一个会话文件就是一个对象,
路径即原始相对路径,桶里能直接打开会话原文。索引项的 `layout` 字段区分两种布局,老索引缺省按分块解释。

## 远端后端

| 后端 | 配置方式 | 说明 |
|---|---|---|
| WebDAV | `trove init --url … --username … --password …` | 默认后端,兼容自建与第三方网盘 |
| 阿里云 OSS | `--type s3 --provider aliyun --region cn-hangzhou --bucket …` | S3 兼容,走 virtual-hosted 寻址 |
| 腾讯云 COS | `--type s3 --provider tencent --region ap-guangzhou --bucket …` | S3 兼容;Bucket 名需带 `-<appid>` 后缀 |

交互式配置(`trove init` / `trove config`)会先问远端类型,再按类型问对应字段 —— 选 S3 时依次问厂商、地域、Bucket、AccessKey,不选就沿用现有配置。

**换后端与历史数据迁移**:索引、设备元信息与 library 布局在两种后端下一致,raw 文件布局按后端区分。`state.json` 里的 `remoteId` 记录了推送水位属于哪个远端;检测到后端变了,旧水位自动作废,历史数据会整份重推(不会"以为推过了"而静默丢数据)。首次切到新后端时跑一次 `trove sync --since all` 即可。S3 切到单对象布局后,旧的 `chunks/` 对象不会自动删除,需要时手工清理。

**清理远端旧对象**:`trove clean` 扫描当前远端,删除不再被任何设备索引引用、且最后修改时间早于 24 小时的对象(旧布局分块、已无引用的会话/技能文件)。

```bash
trove clean --dry-run   # 只列出
trove clean             # 列出后交互确认,默认否
trove clean --yes       # 直接删除
```

安全边界:设备索引缺失时整个设备跳过;library 任一分片读取失败则整个 library 跳过;`lessons/**`、`merged.*.jsonl`、技能 `meta/*.json` 一律保留;24 小时内上传的对象、时间缺失的对象不删。切换远端后的第一次 `trove sync` 结束时(TTY 环境)会询问一次是否清理,默认不清理;daemon 永不触发清理。

## 开发

```bash
pnpm test          # 单元 + 真实 WebDAV 服务集成 + 真实本机会话扫描
pnpm typecheck
pnpm build
```
