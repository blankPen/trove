# Trove sync 重构 —— Beacon poll 机制落地

- 日期：2026-10-22
- 状态：已实现并通过真实环境验证
- 参考：Beacon poll 捕获机制调研（飞书文档 `M9vfdoWaNovfsjxFhmPcAbfGncO`）

## 1. 目标

把 trove 从"整文件指纹 + 每次全量比对"改成 Beacon 的 poll 骨架：

- 四个工具（Claude Code / Codex / OpenCode / 豆包）全部会话可发现
- 只搬新增字节，文件被改写时换世代重建
- 会话内容无损（raw 字节或数据库全字段导出）
- 同步有时间窗、进度、可断点续传
- 常驻 daemon

## 2. Beacon 骨架与 trove 的差异

Beacon 每个工具一个 `collect.go`，差异只有三点：发现路径、原生格式解析、游标语义；主循环、游标推进、错误语义完全一致。trove 照抄骨架，去掉归一化 mapper，输出 raw：

| Beacon | trove |
|---|---|
| `Store.List()` 发现会话 | adapter `discoverFiles()` / `OpenCodeStore.listSessions()` |
| `store.Read()` 解码记录 + `MapSession` | 直接读原始字节；OpenCode 导出全字段 JSONL |
| 游标 `{last_line, size, mtime, started}` | `{size, mtimeMs, prefixHash, generation}` |
| 4KB 截断、10MiB 轮转 | 无截断、无轮转、永不删除 |
| `Since` 过滤 + 旧游标不动 | 同一语义 |

关键语义（与 Beacon 一致）：

- `size + mtime` 未变 → 跳过，不读内容
- `size` 回退 → 文件被截断/重建 → 重置世代，全量复制
- `size` 相同但 mtime 变 → 就地改写 → 重置世代
- `size` 增长且本地归档前缀哈希一致 → 只追加新增字节
- append 前额外校验**源文件**前 `cursor.size` 字节的哈希：源被就地改写后又增长时，直接追加会拼出从未存在的内容
- 前缀哈希不一致（本地归档缺失/被改）→ 重置，绝不混入旧内容
- vault 文件丢失但源未变 → 也重建（备份自愈）
- 失败/中断只推进已成功部分（append 是"正确前缀"操作）

## 3. 数据源

| 工具 | 发现 | 会话判定 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` + `~/.claude/transcripts/**/*.jsonl` | 两套目录各自一个文件 = 一个会话（实测 0 重叠） |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`、`archived_sessions/**` | 一个文件 = 一个会话 |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session_v2` ∪ `session`；消息取 `session_message` ∪ `message` ∪ `part`（两套序列化都保留，同 id 内容不同） |
| 豆包（办公版） | `.../agent_mode/workspace/.sessions/<id>`、`conversation/<id>` | 一个目录 = 一个会话，抓 board/memory/agents/system/socket |

凭证与运行态缓存硬排除：`settings.json`、`auth.json`、`config.toml`、`*.sqlite*`、`*.key`。
大目录剪枝：`plugins`、`stats*`、`bash-snapshots`、`downloads`、`telemetry` 等，避免遍历 5GB 垃圾。

## 4. 存储

本地：

```
~/.trove/
├── state.json                    游标 + pushed + pulled(原子写)
├── vault/devices/<device>/<harness>/<relPath>   原始字节 / 导出 JSONL
├── tmp/                          OpenCode 导出临时文件
└── logs/daemon.log
```

远端（每设备自描述，对象数尽量少）：

```
<device>/index.json                                  索引：每文件 size/generation/chunks/hash
<device>/meta.json                                   {id,name,lastSeen}
<device>/chunks/<harness>/<key>.<gen>.<off>-<len>.bin 不可变块（4MiB；超长 key 自动改用哈希名）
```

`key = base64url(relPath)`。块路径扁平化，同一 harness 只建一次目录；索引即清单，不再逐文件写 manifest。

## 5. 推送 / 拉取

推送：

1. 遍历 `state.sources`，按块切分本地归档
2. 与已推快照比较，完整块复用（上次的半块因内容变了必须重传）
3. 上传缺失块 → 每 60s 提交一次索引 → 全部完成再提交
4. 索引是远端权威：本地 `state.pushed` 丢失时，只要索引的 generation+size 一致就零重传继续

拉取：

1. 列出远端设备，读每个 `index.json`（不逐会话取清单）
2. 校验索引项：路径无穿越、块从 0 连续铺满、`chunksHash` 一致
3. 同世代且本地已有前缀 → 只下载缺的块；否则整条重建
4. 每块校验 sha256，全部通过后临时文件 rename；断电不留半个会话；续传起点按清单真实块边界对齐
5. 本机设备：本地文件存在即视为权威，绝不回拉覆盖自己（本地缺失时才从远端恢复）
6. 索引写入用「临时文件 PUT + MOVE 原子替换」；损坏索引被当作缺失，push 会从本地状态重建

## 6. 时间窗与进度

- `--since 7d|24h|YYYY-MM-DD|all`，按"会话最近变更时间"过滤；同一会话多文件取最大 mtime
- 时间窗只影响 collect；已归档的旧会话不会因为窗口外被删除
- 进度三阶段 `collect / pull / push`；TTY 单行 `\r`，管道按秒节流，最后一项必输出

## 7. daemon

- `trove daemon start --interval 300 --since 7d`：spawn 独立进程
- 单实例 pid 锁（陈旧 pid 自动接管）+ 跨进程 sync 锁（daemon 与手动 sync 不并发写 vault）
- 每轮状态写 `daemon.status.json`；日志 10MB 轮转
- SIGTERM → abort 信号贯穿 collect/pull/push，循环退出并清理 pid

## 8. 验证

- 135+ 个测试：游标/分块/状态/归档/发现/OpenCode 导出/推送/拉取/同步/进度/daemon/CLI/锁
- 真实本机扫描：Claude 1077 会话、Codex 5、OpenCode 782、豆包 40
- 真实 WebDAV 服务（本地进程）端到端：同步 → 增量 → 第二设备拉取 → 源删除不删远端
- 真实远端（49.235.61.172）：全量 2450 项 / 1.22GB；二次增量 14s；四工具抽样块内容与本地 sha256 一致；完整性 2407/2407、OpenCode 153,406/153,406 行
- daemon 实机多轮：5 秒间隔连续两轮自动收集/推送成功，stop 后 pid 清理

## 9. 已知限制

见 `TODO.md`：首次全量受远端单请求延迟限制（约 40–60 分钟）；豆包 scratch/skills、Claude file-history、OpenCode snapshot 未归档；daemon 未安装为系统服务。
