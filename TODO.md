# TODO

## 已完成（2026-10-23 个人资产层）

- [x] `vault/devices` → `vault/raw`（本地 rename，远端一次 MOVE，不重传）
- [x] `vault/library`：按 `(harness, sessionId)` 归组，Claude 子代理并入主会话
- [x] 每设备索引分片 + 派生统一索引；内容不同时 canonical/variants，豆包按事件 id 求并集
- [x] library 常驻同步；`--no-raw` 只同步 library；拉取校验 sha256
- [x] `skills` 汇总：来源识别（self/github/skillsh/unknown）、内容去重、semver 选最新、保留全部版本
- [x] `lessons/` 占位目录
- [x] 命令：`trove sessions`（改读统一索引）、`trove skills [show]`、`trove library reindex`
- [x] 真实数据：1858 会话 / 208k 事件 / 21 技能；远端清理 1,515 条旧条目与 1,534 个孤儿块
- [x] 164 个测试全绿；本地 WebDAV 端到端通过

## 已完成（2026-10-23 对话层）

- [x] 对话层事件协议 v3：`session/message/reasoning/tool_call/tool_result/meta`，`raw:{path,line}` 回指原始归档
- [x] 四工具映射：Claude Code（projects + transcripts 两种 schema、叶子分支、sidechain）、Codex、OpenCode、豆包
- [x] 增量：raw 变化时重建事件文件并只追加新增字节；缺失/格式过期自动重建
- [x] `sync --no-raw` / `daemon start --no-raw`：只同步对话层，raw 仅本地
- [x] `trove sessions`：跨设备列出会话，支持 `--harness/--device/--grep/--limit/--json`，grep 可搜正文
- [x] 真实数据验证：1907 个会话、20.7 万条事件；本地 WebDAV 端到端覆盖开关、索引、工具配对与回指

## 已完成（2026-10-22 sync 重构）

- [x] Beacon poll 骨架：游标 `size/mtime/prefixHash/generation`、size 回退重置、append-only 增量、部分推进不越界
- [x] 四工具 adapter：Claude Code（projects + transcripts）、Codex（sessions）、OpenCode（新旧表并集）、豆包（agent_mode）
- [x] 块级增量上传：8MiB 块 + 设备索引，重复同步零上传；断点续传
- [x] 跨设备拉取：索引驱动、逐块 sha256 校验、临时文件原子 rename
- [x] 时间窗 `--since 7d/24h/YYYY-MM-DD/all`
- [x] 进度输出（TTY 单行 / 管道节流）与 daemon（单实例、SIGTERM 协作中止、状态/日志）
- [x] daemon 多轮实机验证：两轮自动收集并推送（收集 1/推送 2、收集 0/推送 1），停止后 pid 清理
- [x] 真实 WebDAV 端到端：全量 2450 项 / 1.22GB；二次增量 14s；四工具抽样块内容 sha256 与本地逐一比对一致
- [x] 全量完整性：本机 2407 个文件/会话全部出现在远端索引，0 缺失；OpenCode 导出行数 153,406 == 数据库行数

## 已知限制

1. **首次全量受远端限制**：每个块一次 PUT，实测远端约 0.4MB/s，且长时间连续上传会偶发 ECONNRESET/ECONNREFUSED（服务端会短暂拒绝连接）。已加 5 次指数退避 + 索引断点续传，重跑即可继续；全量 1.22GB 约 40–60 分钟（可能需分几轮）。
2. **豆包只归档会话正文**：`.sessions/<id>/scratch`、`sandbox` 与 `.skills` 是生成物/技能库，未归档（占该目录九成体积）；如需要可加白名单。
3. **Claude `file-history` 未归档**：1797 个编辑器快照文件，不属于会话正文。
4. **OpenCode 外部快照未归档**：`~/.local/share/opencode/snapshot`、`storage`（旧版 JSON 存储）与 DB 内容重复，未重复搬运。
5. **daemon 未安装为系统服务**：`trove init` 会自动拉起 daemon（`--no-daemon` 可跳过，`config.daemon.startOnInit=false` 可关），但重启机器后需重新 `trove daemon start`（launchd/systemd 安装未做）。
6. **同一设备重装后拉取**：本机设备只要本地文件存在就视为权威并跳过；本地文件缺失时才从远端恢复。
7. **远端块丢失但索引完好**：push 不会主动重传（它信任索引）；pull 会因 sha256 校验失败而报错，需人工清掉该设备索引后重推（可见而非静默）。
8. **OpenCode 双序列化体积**：新表 `session_message` 与旧表 `message`/`part` 内容不同（新表缺 role/agent/model/tools 等元数据），为无损两者都存，OpenCode 归档约 990MB（旧行为约 380MB）。
