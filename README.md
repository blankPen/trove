# trove

AI 会话资产归档工具:把本机 Claude Code / Codex / OpenCode / 豆包的会话**无损**归档到 WebDAV,并支持多设备增量同步。

## 用法

```bash
# 首次配置(设备名、WebDAV 端点、凭证)
# 默认会拉起 daemon 并立即跑首轮同步;只写配置用 --no-daemon
trove init --url https://dav.example.com/ --username u --password p
trove init --url https://dav.example.com/ --username u --password p --no-daemon

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

# 常驻服务:间隔/时间窗默认取 config.daemon,显式参数优先
trove config set daemon.intervalSeconds 300
trove config set daemon.since 7d
trove config set daemon.startOnInit false   # init 不再自动启动
trove daemon start                          # 等价于每 300s、时间窗 7d
trove daemon start --interval 60 --since 24h
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
- **无损**:本地 vault 是源文件的原始字节副本;OpenCode 是数据库全字段导出(新旧表并集,实测 782 会话 / 153,406 行 / 990MB)。远端块按 4MiB 切分(大请求不稳),拉取时逐块校验 sha256。
- **增量**:远端只传新增块;清单并入设备索引(`<device>/index.json`),块路径扁平到 `<device>/chunks/<harness>/`,避免每文件多次 MKCOL。实测二次全量扫描 2450 项仅 14s、上传 2 项。
- **只增不删**:远端和本地 vault 都不删除;源文件被删后归档仍保留。
- **时间窗**:`--since 7d|24h|2026-10-01|all` 按会话最近变更时间过滤,避免首次全量过大。
- **进度**:collect / pull / push 三阶段,TTY 单行刷新,管道按秒节流。
- **daemon**:单实例 pid 锁、跨进程 sync 锁、SIGTERM 协作中止、状态写 `~/.trove/daemon.status.json`、日志轮转。间隔/时间窗/init 是否自动启动由 `config.daemon.{intervalSeconds,since,startOnInit}` 决定(默认 `300 / 7d / true`),`daemon start --interval/--since` 显式参数优先于配置。

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
    └── lessons/                            学习沉淀(占位)
```

- **归组**:按 `(harness, sessionId)` 归并同一会话的多份 raw——Claude 主文件 + `subagents/*.jsonl`、豆包 `.sessions` + `conversation`。
- **冲突**:每台设备只写自己的文件和分片,远端不存在并发覆盖。同一会话内容不同时,索引选 canonical(事件超集;豆包按事件 id 求并集),其余进 `variants`,文件永远保留。
- **索引**:`index/<device>.json` 是权威,`index.json` 由本地合并生成;索引冲突只需重建,不会丢数据。
- **技能**:按目录内容 hash 去重,来源由 `SKILL.md` frontmatter 与 `.git/config` origin 判定(`self/github/skillsh/unknown`);最新版本按 semver → updatedAt → hash 选择,历史版本保留。
- **lessons**:目录先留空,后续按主题沉淀经验,内容用 `(harness, session, seq)` 引用会话。

事件 schema 仍是 `session/message/reasoning/tool_call/tool_result/meta`,带 `raw:{path,line}` 回指原始文件。

## 同步模型补充

- library **始终同步**(约 500 MB):推送本设备的会话文件、技能与索引分片,拉取其他设备的分片与文件。
- raw 是否上传/拉取按 **命令行 > `config.sync.raw` > 默认 true** 决定;关闭时只同步 library,raw 只归档到本地。
- 配置示例:`trove config set sync.raw false`;`trove sync --raw` 可临时覆盖。
- 索引分片按设备隔离,拉取时落盘后本地重建统一索引。

## 本地布局

```
~/.trove/
├── config.json              设备身份与 WebDAV 凭证(600)
├── state.json               游标 + 推送/拉取水位 + library 记录(原子写)
├── daemon.pid / daemon.status.json
├── vault/raw/<device>/<harness>/...       原始字节归档
├── vault/library/                         个人资产(会话/技能/索引/lessons)
├── tmp/                     OpenCode 导出与 library 重建临时文件
└── logs/daemon.log
```

远端布局:

```
raw/<device>/index.json                            索引(含每文件块清单与哈希)
raw/<device>/meta.json                             设备名 / lastSeen
raw/<device>/chunks/<harness>/<key>.<gen>.<off>-<len>.bin  不可变块
library/index/<device>.json                        每设备索引分片
library/sessions/…、library/skills/…               个人资产
```

## 开发

```bash
pnpm test          # 单元 + 真实 WebDAV 服务集成 + 真实本机会话扫描
pnpm typecheck
pnpm build
```
