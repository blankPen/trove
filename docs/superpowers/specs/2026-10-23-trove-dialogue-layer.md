# Trove 对话层（统一会话视图）

- 日期：2026-10-23
- 状态：**已被 `2026-10-23-trove-library.md` 取代**；`_events` 布局已迁移到 `library/`，事件 schema 与映射器继续沿用
- 关联：`2026-10-22-trove-poll-refactor.md`（raw 同步骨架）

## 1. 目标与边界

在保留 raw 归档的前提下，新增一层统一事件，用于跨工具列出、检索会话：

- raw 是权威：对话层只做语义投影，任何未映射内容都能用事件里的 `raw:{path,line}` 回查
- 不做字节无损、不做会话还原；事件文件可随时从 raw 重建
- raw 同步可开关：关闭时只推拉对话层，raw 只归档到本地

## 2. 存储

```
vault/devices/<device>/<harness>/            raw 原始字节
vault/devices/<device>/<harness>/_events/    对话层
    <sessionKey 可读名>.<sha256 前 8 位>.jsonl
```

事件文件与 raw 同属一个 harness bucket，直接复用现有 push/pull/块级增量，不需要新的远端布局。

- 一行一个事件，首行固定是 `kind: "session"` 头
- 重建方式：raw 变化时全量重建到临时文件，再交给 `archiveFile`：
  内容前缀一致时只追加新增字节；raw 被改写/截断时换世代重建
- 自愈：事件文件缺失或 `formatVersion` 变化时，下一轮自动重建

## 3. 事件 schema（信封 v1，映射器版本 4）

```json
{
  "v": 1,
  "ts": "2026-10-22T13:12:54.338Z",
  "seq": 12,
  "harness": "claude-code",
  "session": "afaa6773-…",
  "kind": "message | reasoning | tool_call | tool_result | session | meta",
  "role": "user | assistant | system | tool",
  "id": "原生记录 id",
  "text": "正文",
  "parts": [{ "type": "image", "mime": "image/png" }],
  "tool": { "name": "Bash", "call_id": "toolu_1", "input": {} },
  "result": { "call_id": "toolu_1", "status": "ok", "output": "…" },
  "usage": { "input": 1, "output": 1, "cache_read": 1, "cache_write": 1, "reasoning": 1 },
  "model": { "id": "claude-opus-5", "provider": "anthropic" },
  "cwd": "/path",
  "thread": "子代理 / sidechain / 豆包 agent",
  "raw": { "path": "claude-code/projects/x.jsonl", "line": 37 },
  "extra": {}
}
```

- `raw.path` 相对 `vault/devices/<device>/`；`line` 为 1 基行号
- 图片等二进制只保留类型引用，二进制在 raw 里
- `usage` 只保留非零值；不存成本（价目表会变，消费端自己算）
- 未知记录进 `meta` + `extra`，不静默丢弃

## 4. 四工具映射

| 工具 | 输入 | 规则 |
|---|---|---|
| Claude Code `projects/` | 每文件一会话 | `message.content` 块 → message/reasoning/tool_call/tool_result/image；取**最后一个** `last-prompt.leafUuid` 沿 `parentUuid` 回溯活动分支；`isSidechain` 消息带 `thread`；顶层 `toolUseResult` 是重复，不映射 |
| Claude Code `transcripts/` | 另一种 schema | `user` → message；`tool_use` → tool_call；`tool_result` → tool_result；会话 id 取文件名 |
| Codex | rollout JSONL | `session_meta` 建头；`response_item` 映射；`event_msg` 是重复、`turn_context/world_state` 是运行态，不映射；`ordinal` 作 seq |
| OpenCode | 逐会话导出 JSONL | `session_v2/session` 建头；`session_message` 展开 `data.content`；旧表 `message/part` 是第二套序列化，不重复映射（raw 可查） |
| 豆包 | 会话目录 | `assignment.md` 的 `## [ts] 需求` 块 → user；`trajectory.jsonl` → message（源无时间戳，标 `ts_derived`）；`tool-results/*.txt` → tool_result；board/memory/socket 不映射 |

映射器位于 `src/core/events/{claude,codex,opencode,doubao}.ts`，都是纯函数（输入文件文本，输出事件数组）。

## 5. raw 同步开关

- `sync --no-raw`：push 只上传 `_events/`，pull 只下载 `_events/`；raw 仍然归档到本地（对话层的来源）
- `daemon start --no-raw` / `daemon run --no-raw`：子进程参数透传
- 默认值：开（行为与之前一致）

## 6. sessions 命令

```bash
trove sessions [--harness <id>] [--device <id>] [--grep <text>] [--limit <n>] [--json]
```

- 扫描 vault 中所有设备的 `_events/*.jsonl`，只读首行；有 `--grep` 时继续扫正文，命中即停
- 匹配字段：标题、首条用户文本、目录、模型、会话 id、正文文本、工具名/参数/输出
- 默认显示 50 条，`--limit 0` 不限；按开始时间倒序

## 7. 验证

- 单元/集成：155 个测试全绿；覆盖四工具映射、分支还原、sidechain、增量追加、自愈、raw 开关、sessions 过滤、status 口径
- 真实数据：本机 1.75GB raw 生成 1908 个会话、207,469 条事件；Claude 1083、OpenCode 780、豆包 40、Codex 5
- 本地 WebDAV 端到端：`--no-raw` 时远端索引只有 `_events/`；打开后 raw 进入索引；`sessions/--grep` 命中工具参数；事件回指 raw 行号可解析
- 抽样回查：随机事件的 `raw.path + line` 能在 raw 中解析到对应记录

## 8. 已知限制

1. Claude `transcripts/` 没有 assistant 文本，对话层只有用户输入与工具链
2. 豆包缺模型、Token、成本、目录、标题；只有 assignment 有原始时间戳
3. 图片只保留引用，不内联；URL 型附件需源头仍可访问
4. `meta` 记录（mode/权限等运行态）在对话层被跳过，raw 可查
5. 对话层不计入 `status` 的「已归档」体积，也不算 raw 待同步项；library 的待推送单独按「会话 / 技能 / 索引」计数
