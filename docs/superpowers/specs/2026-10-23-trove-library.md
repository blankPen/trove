# Trove 个人资产层（raw / library / skills / lessons）

- 日期：2026-10-23
- 状态：已实现并通过真实数据 + 本地 WebDAV 端到端验证
- 取代：`2026-10-23-trove-dialogue-layer.md` 中的 `devices/.../_events` 布局

## 1. 目标

- `raw`：设备 × 工具的事实层，原样字节，可选同步
- `library`：用户个人资产层，合并归组后的会话、技能、学习沉淀，默认同步
- 多设备并发写入不产生覆盖；冲突按确定性规则合并，文件永不删除

## 2. 目录

本地：

```
vault/
├── raw/<device>/<harness>/…                 原始字节（原 devices/）
└── library/
    ├── index.json                           统一索引（派生物，可重建，不上传）
    ├── index/<device>.json                  每设备索引分片（只由本设备写）
    ├── sessions/<harness>/<session>/<device>.jsonl
    ├── skills/<name>/versions/<hash>/…      内容寻址，保留各版本
    ├── skills/<name>/meta/<device>.json     来源 / 版本 / 文件清单
    └── lessons/                             学习沉淀（README 占位）
```

远端：

```
raw/<device>/{index.json,meta.json,chunks/<harness>/…}
library/index/<device>.json
library/sessions/…、library/skills/…
```

## 3. 归组

按 `(harness, sessionId)` 归并同一会话的所有来源文件：

| 工具 | 归组规则 |
|---|---|
| Claude Code | `projects/<proj>/<id>.jsonl` + `projects/<proj>/<id>/subagents/*.jsonl` 合成一个会话；子代理消息带 `thread=agentId`。`transcripts/<stem>.jsonl` 一文件一会话 |
| Codex | `sessions/**`、`archived_sessions/**` 按 `session_meta.payload.id` 归组 |
| OpenCode | `sessions/<id>.jsonl` |
| 豆包 | `.sessions/<id>/**` + `conversation/<id>/**` |

会话 id 以映射后头事件的 `session` 为准（路径推导仅用于文件归组）。

## 4. 索引与合并

- 每台设备构建后写 `library/index/<device>.json`（分片），然后本地合并所有分片生成 `library/index.json`。
- 分片只由本设备写；统一索引是派生缓存，冲突时重建即可。
- 同一键多份变体：
  - hash 相同 → 视为一致，任取一份，`sources` 记录全部设备
  - hash 不同 → 默认取事件超集；豆包按事件身份（`kind|id`，无 id 时 `kind|ts|payload hash`）求并集，生成 `merged.<hash>.jsonl`
  - 未选中的变体保留在索引 `variants` 中，文件不删除
- 跨工具同 id 不合并。

## 5. 技能汇总

- 来源：本设备 raw 中 `claude-code/skills/**` 与 `codex/skills/**`；文件名/目录结构原样保留。
- 去重：技能目录内容 hash（排除 `.git`、`node_modules`、`.DS_Store`）。
- 版本：`SKILL.md` frontmatter 的 `version`；无版本时用 `updatedAt`。
- 来源判定：
  - frontmatter `source` 显式声明
  - `.git/config` 的 `origin`：含 github.com → `github`；含 skill.sh / skills.sh → `skillsh`
  - 无 origin → `self`；其余 → `unknown`
- 最新版本：semver 降序 → `updatedAt` 降序 → hash 字典序；历史版本全部保留。
- 存储：`skills/<name>/versions/<hash>/` + `skills/<name>/meta/<device>.json`。

## 6. lessons

只建目录与 `README.md`，暂不生成内容。后续约定：按主题存放经验/总结，用 `(harness, session, seq)` 引用会话，不复制正文。

## 7. 同步

顺序：collect（raw → library 构建）→ pull raw（可选）→ pull library → push raw（可选）→ push library。

- library 始终同步：本设备的会话文件、技能、索引分片；拉取其他设备分片后本地重建索引。
- `--no-raw`：跳过 raw 的拉取与推送，仅同步 library。
- 优先级：命令行 `--raw/--no-raw` > `config.sync.raw` > 默认 `true`；老配置缺 `sync` 字段按开启处理。
- 会话文件按大小 + mtime 判断是否上传；技能版本内容寻址，天然去重。
- 拉取会话文件后校验 sha256；分片落地后由本地重建统一索引。

## 8. 迁移

1. 本地 `vault/devices` → `vault/raw`（一次性 rename；两边同时存在时拒绝迁移）
2. 远端 `<device>/` → `raw/<device>/`（一次 WebDAV MOVE，保留索引与块）
3. 删除旧 `raw/<device>/<harness>/_events` 派生目录；`state.json` 读入时清理对应条目
4. 远端索引移除 `_events` 条目，并删除其孤儿块
5. 首次 `sync` 构建 library（可从 raw 重建）

## 9. 验证（本机真实数据）

- 构建：1858 个会话 / 208,132 条事件 / 21 个技能，首次 13.9s，二次 0.2s（签名命中，0 写入）
  - Claude 1032、OpenCode 780、豆包 41、Codex 5；子代理文件已并入主会话
- 体积：library 497 MB（sessions 492 MB、skills 1.4 MB），raw 1.7 GB
- 索引：`library/index.json` 可重建；`trove sessions` / `trove skills` / `trove status` 正常
- 远端迁移：4,873 个文件 / 2.44 GB 一次 MOVE；索引 3,982 → 2,467 项；删除 1,534 个孤儿块；抽样 5 个块 sha256 全部一致
- 端到端（本地真实 WebDAV）：library 推送/拉取、raw 开关、技能来源识别、索引重建、跨设备可见、事件回指 raw 全部通过
- 测试：167 个用例全绿；`tsc --noEmit` 与 `pnpm build` 通过

## 10. 已知限制

1. 会话文件按设备固定路径、整体上传；单会话很大时改动会重传整个文件（未做块级续传）。
2. 技能只汇总 raw 里的 Claude/Codex `skills/**`；`~/.agents/skills`、项目内 skills、豆包 `.skills` 未纳入。
3. 无删除传播：源文件删除后 raw 与 library 都保留。
4. 同一会话多设备内容不同时，canonical 可能随更大变体到达而切换；`variants` 完整保留。
5. `library/index.json` 仅本地生成，不上传；跨设备读取依赖分片合并。
