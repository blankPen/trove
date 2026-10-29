# TODO

## 待办

- [x] 参考 [分层架构方案](https://feishu.doubao.com/docx/WoxKd0aeroqotexUoLgctahHnxI) 完成分层架构改造与验证
- [x] 优化 sync 策略：远端模式改为可配置（可选），不配置时仅做本地 `.trove` 目录同步（需相应改动 `init` / `sync` 等逻辑流程）
- [x] `config` 配置改为与 `init` 一致的交互式（现有 `config set` 可保留）
- [x] 重做 `preferences/` 提取：围绕「当前使用用户」做用户形象分析提取。`profile` 提取用户信息（我是谁 / 年龄 / 职责 / 工作背景 / 人际关系），其余提取编码风格、写作风格、对话风格、最近事项等；提取规则与 prompt 需重点打磨

## 已完成（2026-10-29 偏好提取重做）

- [x] `preferences/` 由 4 类改为 5 类：删 `reply_format`，新增 `dialogue_style`（对话风格）与 `recent_matters`（最近事项），均为 `patch` 合并到固定文件
- [x] `profile` 提取提示词聚焦六维度「我是谁/年龄/职责/工作背景/人际关系」，并强调「围绕当前使用用户、只写会话中真实出现的信息」
- [x] 其余三类（编码/写作/对话风格）与「最近事项」各给专属提取口径；`recent_matters` 合并提示词额外保留「近期」时效语义（过期旧事项可移除）
- [x] 把 schema 的 `extractionPrompt` 死字段接活：偏好类提取在 `extractCategory` 里按 type 注入各类型提取口径到真实 LLM 提示词
- [x] 同步更新 `sidecar.ts` 偏好目录 brief（去掉「回复格式」，补「画像/对话风格/最近事项」）
- [x] TDD：新增 `tests/lessons/preferences.test.ts` 5 条用例（画像六维度、其余四类口径与文件名、五类集合、recent 时效、提示词注入 LLM）
- [x] 真实核验：全量 303 测试全绿 + `tsc --noEmit` 通过；重建 dist 冒烟确认 5 类新集合 + 画像提示词；真实 DeepSeek 跑一次 `preferences` 提取，`profile` 产出「姓名/年龄/岗位/工作背景/团队关系」，`dialogue_style`/`recent_matters` 正常产出

## 已完成（2026-10-29 交互式 config）

- [x] 裸 `trove config` 进入与 `init` 一致的交互式流程:设备名 / WebDAV 地址 / 用户名 / 密码,`initialValue` 取当前配置
- [x] 密码留空保留原值;地址留空进入本地模式;非交互环境报错并提示 `config set`
- [x] `config set` / `get` / `path` 子命令保留,与裸命令的 `.action()` 共存
- [x] TDD:`tests/config-interactive.test.ts` 3 条用例(改写/密码留空保留/非交互退出 1)
- [x] 真实 CLI 验证:`config path`/`set`/`get` 往返正常,裸 `config` 非交互环境 exit 1

## 已完成（2026-10-29 本地模式）

- [x] `SyncOptions.remote` 改为 `RemoteStore | null`,四段远端拉/推与设备 meta 写全部闸在 `opts.remote` 存在时;本地 collect 与 state 落盘始终执行
- [x] `loadRuntime` 不再因缺远端抛错,url/password 任一缺失即返回 `remote: null`
- [x] `cmdInit` 的 `--url` 改为可选:不填进入本地模式(跳过密码校验与连通探针),填了仍要求密码
- [x] `cmdSync` 本地模式追加「本地模式(未配置远端,仅本地 .trove 归档)」提示
- [x] TDD:sync null-remote 用例(仅 collect/零拉零推/远端零写入)+ cli 两条用例(sync 降级不报错、init 无 url 本地模式)
- [x] 真实 CLI 验证:临时 TROVE_HOME 下 `init`(无 url)落空 remote 配置、`sync` 归档 1 项零拉零推且不触远端

## 已完成（2026-10-29 分层架构改造）

- [x] Sidecar 分层存储 L0/L1/L2：`src/core/lessons/sidecar.ts` 新增 `.abstract.md`(L0 ≤256 字) / `.overview.md`(L1 ≤4000 字,含 H1+Brief+Quick Navigation) / 正文(L2)
- [x] 根 + 5 类目录（preferences/entities/experiences/events/resources）共 12 个 sidecar 文件
- [x] 新鲜度机制：子写 `pending_child_changes` 递增,跨 10% 阈值触发整目录刷新;`trove refresh` 强制重建
- [x] write 管线接入：`applyOperations` 由旧 `updateOverview` 改为 `touchSidecars`
- [x] 新增 `trove refresh` 命令
- [x] 真实 vault 验证：`node dist/main.js refresh` 产出 12 个分层文件,Quick Navigation 统计与磁盘一致

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
