# Trove Web 界面

- 日期：2026-11-04
- 状态：设计已定，待实现
- 关联 ADR：[0001](../../adr/0001-web-frontend-independent-project.md) · [0002](../../adr/0002-web-sync-reuses-vault-lock.md) · [0003](../../adr/0003-web-reads-local-vault-only.md)

## 1. 目标与边界

给 trove 加一个本地 web 界面，用来直观阅读已经沉淀下来的东西。

**v1 内容只读**。可以看、可以搜、可以把路径复制走，但不能增删改 sessions /
lessons / skills 的内容。唯一的写操作是运维动作（同步、daemon 生命周期），
它们是显式按钮触发的，不是内容管理。

范围外：mcp 管理（trove 目前完全没有采集 mcp，见 §9）、远程访问、鉴权、
多用户、内容编辑。

## 2. 界面

五个页签，全部读本地 `~/.trove/vault`：

| 页签 | 看什么 | 数据源 |
| --- | --- | --- |
| 总览 | 设备、远端、daemon 状态、待同步计数、四个库的数量、trove 自身 token 用量 | `status.ts` + `daemon.ts` + `usage.ts` |
| 会话 | 会话列表（按 harness / 设备 / 关键词筛）、点开看完整事件流 | `library/index.json` + `library/sessions/**` |
| 沉淀 | 18 类记忆的目录树、每条带 frontmatter 与正文预览、可全文搜 | `library/lessons/**` |
| 技能 | 38 个技能的版本谱系、每个版本的文件清单与内容 | `library/skills/**` |
| 用量 | trove 自己调 LLM 的 token 台账，按任务 / 模型分组 | `~/.trove/usage.jsonl` |

会话详情是**滚动渐进加载**：后端按 `offset/limit` 分页吐事件，前端滚到底自动
拉下一页，直到该会话全部事件读完。

## 3. 架构

```
web/                        前端独立工程(React + Vite + TS)
  src/pages/{Overview,Sessions,Lessons,Skills,Usage}.tsx
  src/api.ts                唯一的后端调用入口
  vite.config.ts            build.outDir = ../dist/public,dev.proxy /api → :8787
src/server/                 后端(Node 内置 http,零新依赖)
  index.ts                  startServer()
  routes.ts                 路由表
  overview.ts / sessions.ts / lessons.ts / skills.ts / usage.ts / daemon.ts
  sse.ts                    SSE 进度通道
  progress.ts               Progress 实现 → SSE
  truncate.ts               事件字段截断
src/runtime.ts              loadRuntime(config/remote/adapters),cli 与 server 共用
trove web                   CLI 子命令,拉起后端并伺服 dist/public
```

前端产物落在 `dist/public/`，`package.json` 的 `files: ["dist"]` 原样覆盖，
npm 包自带界面，无需用户构建。

开发态两个进程：后端 `node dist/main.js web`（:8787），前端 `pnpm dev`（:5173，
vite 把 `/api` 代理到 8787）。

## 4. 后端 API

全部 `GET` 无副作用，除三个运维 `POST`。

### 4.1 读

```
GET /api/overview
  → { device, remote:{type,desc}, daemon:{running,pid,intervalSeconds,since,
      lastRunAt,nextRunAt,lastError}, counts:{sessions,skills,lessons},
      pending:{raw:{files,bytes},library:{...}}, usage:{calls,totalTokens,...} }

GET /api/sessions?harness=&device=&q=&limit=&offset=
  → { total, items:[{harness,session,title,firstText,cwd,model,startedAt,
      bytes,events,devices,variants}] }
  q 非空 = 正文深度搜索(见 §6.3)，耗时 2~4s

GET /api/sessions/:harness/:session
  → { harness,session,title,cwd,model,startedAt,sources,canonical,
      variants,eventTotal,bytes }

GET /api/sessions/:harness/:session/events?offset=&limit=
  → { offset,limit,eventTotal,events:[Event] }

GET /api/lessons
  → [{ category,label,count,items:[{path,title,type,tags,scope,source,
      createdAt,updatedAt,preview}] }]

GET /api/lessons/file?path=<相对 lessons 根>
  → { path, content }

GET /api/skills
  → [{ name,latest,source,version,devices,updatedAt,
      versions:[{hash,updatedAt,files:[{rel,size}]}] }]

GET /api/skills/file?name=&hash=&rel=
  → { content }

GET /api/usage?since=all
  → { total:{calls,promptTokens,completionTokens,totalTokens},
      byTask:{...}, byModel:{...} }

GET /api/daemon
  → { running,pid,status:{...} }
```

### 4.2 运维

```
POST /api/sync          → { jobId }          触发一次同步(后台跑)
GET  /api/sync/:jobId/events                   SSE 进度
POST /api/daemon/restart → { pid,wasRunning } 重启 daemon
```

SSE 事件类型：

```
event: phase   data: {"name":"collect","detail":"..."}
event: item    data: {"label":"...","current":10,"total":100,"bytes":1234}
event: locked  data: {"pid":6012}
event: done    data: {"collected":{...},"pulled":{...},"pushed":{...},"durationMs":28322}
event: error   data: {"message":"..."}
```

## 5. 同步与锁（ADR-0002）

web 进程内直接调 `sync()`，抢 `~/.trove/state.json.lock`。

- 抢不到锁 → job 发 `locked` 事件（带持锁 pid），服务端每 2s 探测锁文件，
  最多等 120s，锁释放后自动重试一次；超时则 `error`。
- 抢到锁 → 用 `Progress` 接口把 `phase`/`item` 推成 SSE。
- 同一时刻只允许一个活跃 job（模块级状态）。

daemon 重启复用 `restartDaemon()`，参数取自 `config.daemon`。`startDaemon`
spawn 的是 `process.argv[1] daemon run ...`，在 web 进程里 `argv[1]` 就是
trove 入口，无需额外处理。

## 6. 实现约束

### 6.1 安全

- **只监听 127.0.0.1**，不提供 `--host` 参数。要在别的机器上看，自己做端口转发。
- **绝不返回 `config.json` 的内容**。远端信息只经 `describeRemote()` 出
  （endpoint + bucket，无凭证）。S3 密钥、WebDAV 密码永远不出进程。
- lessons 与 skills 的文件读取必须做**路径穿越校验**：lessons 的 `path` 必须
  落在 `library/lessons/` 内；skills 的 `rel` 必须落在该版本 `meta` 声明的
  文件清单内（不能只拼路径）。

### 6.2 事件截断

会话事件里有超长字段——本机最大的一条 `tool_result.output` 是 **101 MB**
（一个 MCP agent 把整份 transcript 塞进了工具结果）。直接吐给浏览器会炸。

服务端对每个事件的字符串字段（`text`、`result.output`、`tool.input`、
`parts[].text`）截到 **64 KB**，并在事件上标 `__truncated` 记录原长度。
原件仍在磁盘，UI 显示 vault 相对路径，用户可自行去取。

截断发生在**服务端读取时**，不在前端：省一次 100 MB 的传输。

### 6.3 搜索

三档，全部复用现成实现，不建索引：

| 范围 | 实现 | 耗时（本机实测） |
| --- | --- | --- |
| 会话元信息 | 内存过滤 `index.json` | 46 ms |
| 会话正文 | `listSessions({grep})`，流式扫约 690 MB / 2367 个会话文件 | 1.9 s（命中）～3.6 s（落空） |
| lessons 正文 | 缓存约 900 个文件的 frontmatter 与正文（2.1 MB）后过滤 | <100 ms |
| skills 正文 | 缓存 38 个技能的全部文件内容（2.2 MB）后过滤 | <100 ms |

会话正文搜索**不建持久索引**。这是明知的取舍：每次搜索重扫 691 MB。
先按这个做，性能不够再谈索引（见 §9）。

### 6.4 lessons 与 skills 的目录口径

- lessons 顶层五类（preferences / entities / experiences / events / resources）
  加 `archive/`。`archive/` 单独一档，不混进五类计数。
- 本机快照（2026-11-04）：preferences 6 / entities 312 / experiences 349 /
  events 0 / resources 222 / archive 17，共 906 条。daemon 仍在跑，数字会涨。
- 实体与资源有二级目录（projects / people / … / docs / repos / links）。
- skills 的**索引键是真名，目录名是 `safeSessionName(真名)`**。`buildSkills()`
  写盘用 safe 名，但 `meta/*.json` 里的 `name` 是真名，合并索引时用的是真名。
  本机 38 个技能名恰好都安全，两者相同；换台机器可能不一致，**取文件必须
  过 `safeSessionName()`**。

### 6.5 用量的口径

`/api/usage` 只统计 **trove 自身**调用 LLM 的消耗（learn 提取、summarize 等），
数据来自 `~/.trove/usage.jsonl`。

**不统计归档会话的 token 消耗**。会话事件里确实带 `usage` 字段
（Claude Code / OpenCode 有，Codex 的 `token_usage_record` 被映射器当运行态
丢掉了），但 trove 从不聚合它，v1 也不做。

本机 `usage.jsonl` 目前**不存在**——`learn` 因为没配 `llm.baseUrl/model/apiKey`
一直在失败。界面要给出这个空态的说明，而不是显示成"0 次调用"。

## 7. 前端

React 19 + Vite 8 + TypeScript。依赖：

- `react` / `react-dom`
- `react-markdown` —— 渲染 lessons 的 markdown。它默认不放开裸 HTML
  （要额外 `rehype-raw`），比 `marked` 少一个 XSS 面，自写 markdown 渲染器
  不值得。
- `react-router-dom` —— hash 路由，会话详情可分享（`#/sessions/claude-code/xxx`）。

不用虚拟滚动库：单会话最大 4736 条事件（实测），普通渲染够用；渐进加载本身
已经把 DOM 规模压下来了。

样式不引 CSS 框架，手写 CSS 变量 + 少量工具类。

## 8. 发布与开发

```
pnpm-workspace.yaml         packages: ["web"]
package.json scripts
  build        tsc -p tsconfig.json && pnpm --filter @trove/web build
  build:server tsc -p tsconfig.json
  dev:server   tsc -w -p tsconfig.json
  dev:web      pnpm --filter @trove/web dev
  prepublishOnly  pnpm build
```

`web/package.json` 的 `dev` 跑 vite（5173），`build` 跑 vite build 到
`../dist/public`（`emptyOutDir: true`，只清 `dist/public`，不碰 tsc 产物）。

后端没构建时 `trove web` 仍能起，只是 `/api` 之外没有界面；此时给一个提示页。

## 9. 已知限制与后续

| 限制 | 说明 | 何时该动 |
| --- | --- | --- |
| 会话正文搜索每次重扫 691 MB | 1.9~3.6 s | 用户抱怨慢时建持久索引 |
| 事件字段截断在 64 KB | 原文在磁盘，UI 给出路径 | 需要看全文时加按需取原字段的接口 |
| Codex 事件没有 token | 映射器把 `token_usage_record` 当运行态丢掉 | 哪天要精确统计 Codex 用量时改映射器 |
| lessons / skills 内容缓存在内存 | 外部改了文件不会立刻反映 | 加 mtime 检查 |
| `usage.jsonl` 可能是空的 | learn 未配置 LLM 时一直是空 | 配了 LLM 就有数据，不是 bug |
| mcp 无从查看 | trove 完全不采集 mcp | 需要时新增采集，与 skills 平行 |
| 无鉴权、无远程访问 | 只绑 127.0.0.1 | 要远程看时再设计 |

## 10. 验证

- 后端：`tests/server/` 覆盖每个路由的正常路径与两个边界——
  lessons/skills 的路径穿越必须被拒；事件字段必须被截断。
- 端到端：`trove web` 起真服务，用本机约 2367 个会话 / 约 900 条 lessons /
  38 个技能跑一遍五个页签。
- 性能：会话正文搜索耗时、lessons/skills 首屏耗时，与 §6.3 的实测值对齐。
