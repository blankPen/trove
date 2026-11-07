# Agent Hooks 机制调研：Claude Code / Codex / Hermes / Beacon 与 trove 的可借鉴点

> 调研日期：2026-11-06
> 调研对象：`NousResearch/hermes-agent`、`Asymptote-Labs/agent-beacon`、Claude Code Hooks 官方文档、Codex Hooks 官方文档
> 目的：判断 trove 在「自动上下文注入 / 自动检索 / 内容打标 / 主动触发学习」四件事上该不该做、该怎么做

---

## 一、结论摘要

1. **Hooks 已经是 coding agent 的事实标准协议**。Claude Code 有 30+ 个事件，Codex 有 14 个，两者的事件名、matcher 结构、`hookSpecificOutput.additionalContext` 注入方式几乎一致。Hermes 作为自研 agent，把 hook 做到了更细的粒度（工具结果改写、LLM 输出改写、验证门）。
2. **上下文注入只有三种落点**：会话启动（`SessionStart`）、每轮提交（`UserPromptSubmit`）、工具结果后（`PostToolUse`）。三家都在用，但没有一家把「每轮自动检索」做成默认行为——原因是有严格预算和污染风险（见第四节）。
3. **真正稀缺的不是采集，是「写什么」和「何时写」**。Beacon 采集 20+ harness，但沉淀走「打分 → 候选 → 人工批准」；Hermes 采集靠自身，沉淀走「每 10 轮提醒 + 回合后 fork 复盘」。两者都把**写入质量**当成核心问题，而不是采集覆盖率。
4. **对 trove 最重要的三条**：
   - trove 的会话采集走磁盘 transcript，比 hook 采集更全更便宜，**不应该用 hook 重复采集**；hook 只该做磁盘拿不到的事：低延迟注入、回合结束触发学习。
   - 注入要分级：稳定的进系统提示/会话启动，动态的进每轮，且有硬预算（1–2KB）和「只给 id + 一行摘要、详情让模型再 get」的分层。
   - 学习触发要「事件 + 阈值」双条件，写入要分级（自动写低风险，高风险进审核队列），否则经验库会被低质条目淹没。

---

## 二、调研对象与方法

| 对象 | 定位 | 调研方式 |
|---|---|---|
| Claude Code | 商业 coding agent，hook 协议的事实标准 | 官方文档全文（33 个事件、决策控制、退出码语义） |
| Codex | OpenAI coding agent，hook 协议与 Claude 高度对齐 | 官方 hooks 文档 + 仓库 `config.schema.json` 交叉验证 |
| hermes-agent | Nous Research 自研 agent，主打「自我改进」 | 源码：`agent/`、`hermes_cli/hooks.py`、`website/docs/user-guide/features/hooks.md` |
| agent-beacon | 跨 harness 的会话采集 + 记忆层 | 源码：`cli/beacon/internal/endpoint/hooks/*.go`、`agent-skills/skills/*` |

---

## 三、三层机制拆解

### 3.1 Claude Code：全生命周期钩子

**事件覆盖**（部分）：

| 节奏 | 事件 |
|---|---|
| 会话级 | `SessionStart`、`SessionEnd`、`Setup` |
| 轮次级 | `UserPromptSubmit`、`UserPromptExpansion`、`Stop`、`StopFailure` |
| 工具级 | `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`PermissionRequest`、`PermissionDenied` |
| 子代理 | `SubagentStart`、`SubagentStop`、`TaskCreated`、`TaskCompleted`、`TeammateIdle` |
| 上下文治理 | `PreCompact`、`PostCompact`、`InstructionsLoaded` |
| 环境变化 | `CwdChanged`、`FileChanged`、`DirectoryAdded`、`ConfigChange`、`PreModelSwitch`、`PostModelSwitch` |
| 其他 | `Notification`、`MessageDisplay`、`WorktreeCreate/Remove`、`Elicitation*` |

**能力矩阵**：

| 能力 | 字段 | 说明 |
|---|---|---|
| 注入上下文 | `hookSpecificOutput.additionalContext` | 被包进 `<system-reminder>` 插到触发点；单条上限 **10,000 字符** |
| 纯文本注入 | `UserPromptSubmit` / `SessionStart` 的 stdout | 直接作为上下文 |
| 阻断 | 顶层 `decision: "block"` + `reason`，或 exit 2 | exit 1 是**非阻断**错误，策略钩子必须用 exit 2 |
| 改写入参 | `PreToolUse.permissionDecision` + `updatedInput` | allow / deny / ask / defer |
| 改写结果 | `PostToolUse.updatedToolOutput` | 出站入参拦截、入站结果脱敏 |
| 继续对话 | `Stop` 返回 `additionalContext` | 让模型处理反馈后再停 |
| Handler 类型 | `command` / `http` / `mcp_tool` / `prompt` / `agent` | 支持 `async`、`timeout`、`onFailure: block` |

**几个必须知道的坑**：

- 注入超过 10,000 字符会被**落盘成文件 + 2,000 字符预览**，并且**不会主动要求模型去读**——即超限等于丢上下文。
- 中途事件（`PostToolUse` / `UserPromptSubmit`）注入的文本会写进 transcript；`--resume` 时是**重放旧文本**，不会重跑 hook。只有 `SessionStart` 在 resume/fork 时会重新执行，`source` 为 `resume` / `fork`。**要注入「当前状态」就必须挂 `SessionStart`。**
- `UserPromptSubmit` 不能替换 prompt，只能追加。
- 文档明确建议注入写成**事实陈述**而非命令式系统指令，否则可能触发 prompt-injection 防御。

### 3.2 Codex：与 Claude 对齐，但取舍更克制

**14 个事件**：`SessionStart`、`SessionEnd`、`SubagentStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreModelRequest`、`PostModelRequest`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`、`Interrupt`。

与 Claude 的差异点：

| 维度 | Codex 的做法 | 启示 |
|---|---|---|
| 注入预算 | `additionalContextLimit` **按 token 计**，默认 2,500，超出落盘并给恢复元数据 | 比字符数更贴近真实成本 |
| 模型调用级钩子 | 独有 `PreModelRequest` / `PostModelRequest`（带 `token_usage`、`status`） | 可做成本归因；但不能注入、不能阻断 |
| 中断 | `Interrupt` 事件，超时 1 秒（上限 3 秒） | 极短的钩子只能做记录 |
| 信任模型 | 非 managed hook 必须人工信任，**信任绑定 hook 内容 hash**，改动后需重新信任 | 安装器必须幂等且内容稳定，否则反复弹信任 |
| 企业下发 | `requirements.toml` 里 `allow_managed_hooks_only = true` + `managed_dir` | 组织级强制策略的标准姿势 |
| 配置格式 | `hooks.json` 与 `config.toml` 内联二选一，同层同时存在会合并并告警 | 配置文件要能跟用户既有配置共存 |
| 插件钩子 | 插件根目录 `hooks/hooks.json`，注入 `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` | 与 Claude 生态兼容是刻意设计 |

**能力差异**：`PreToolUse` 支持 `deny` / `allow`，**`ask` 尚未支持**；`PostToolUse` 返回 `decision:block` 会用反馈**替换工具结果**；`PermissionRequest` 用 `decision.behavior` 而非 `permissionDecision`。

### 3.3 Hermes：自研 agent 的钩子做成了插件总线

Hermes 有**四套**钩子系统：Gateway hooks（`HOOK.yaml` + `handler.py`）、Plugin hooks（`ctx.register_hook()`）、Shell hooks（`config.yaml` 的 `hooks:` 块）、Outbound webhooks。

最值得看的是 **plugin hooks 目录**，它把 hook 分成了三类语义：

| 类别 | 代表 hook | 行为 |
|---|---|---|
| 观察者 | `post_tool_call`、`post_llm_call`、`pre_api_request`、`on_stream_delta` | 返回值被忽略，只做记录 |
| 变换器 | `transform_tool_result`、`transform_terminal_output`、`transform_llm_output` | 第一个有效字符串**替换**原内容 |
| 指令/控制 | `pre_tool_call`、`pre_llm_call`、`pre_verify` | 可 `block` / `approve` / `modify` |

关键细节：

- `pre_tool_call` 返回值 `block` 优先于 `approve`，`modify` 会**浅合并**进工具参数。回调超时（默认 30s）时 **fail closed（阻断工具）**；其他有界钩子 fail open。
- `pre_llm_call` 每次推理前触发，返回字符串会**拼进用户消息**；返回 `{"action":"block"}` 可以直接结束本轮、不发起推理。
- 还有一个独立于 hook 的机制：`ctx.register_system_prompt_section()`——插件可以注册**有界、缓存安全**的系统提示段落（单段 ≤4,000 字符，总计 ≤8,000 字符、≤32 段），只在**新会话渲染一次**，压缩后从已持久化的完整提示恢复，不会每轮重新读插件状态。

这条最关键：**Hermes 把「稳定知识」放进缓存友好的系统提示前缀，把「动态上下文」留给 `pre_llm_call`**。这是在 prompt cache 时代做上下文注入的正确分层，trove 直接照抄即可。

### 3.4 hermes-agent 的学习闭环（不是 hook，但最值得借鉴）

Hermes 的「自我改进」由三个机制拼成：

1. **计数提醒（nudge）**：`_memory_nudge_interval = 10` 轮、`_skill_nudge_interval = 10` 次工具迭代；到阈值就在下一轮提示模型「考虑保存记忆/技能」。
2. **回合后后台复盘**：每个回合结束，**fork 一个 agent**，把对话快照重放一遍，问它「有没有该保存的记忆或技能」，写操作直接落到 memory / skill 存储，**不污染主对话、不动 prompt cache**。代价约 **30K token/次**，所以对 cron 等无人值守场景直接关闭。
3. **质量护栏**，这是整套里最有价值的部分：
   - **路由规则**：`USER.md` 只放「用户是谁」（偏好、风格、明确表达的习惯）；`MEMORY.md` 只放「环境事实」（工具怪癖、项目约定、配置坑）。一条事实只能进一个库。
   - **证据规则**：只保存能指到具体用户消息或工具结果的事实；**禁止**从话题、语气、使用的工具推断用户特质；一次性的请求不能升格成长期偏好，除非用户说了「以后都」「记住」「我讨厌 X」。
   - **技能形态规则**：技能是「一类任务的最优做法」，不是事故叙事；禁止复述仓库 AGENTS.md 已经写过的内容；禁止为每次会话建一个 `references/` 文件。

### 3.5 Beacon：采集与记忆层

**采集**：为每个 harness 装 hook，把事件归一化成统一 schema（`prompt.submitted`、`tool.invoked`、`command.executed`、`approval.*`），入口处脱敏，支持 `full` / `redacted` 内容保留模式。

它对 Claude Code 装 **10 个事件**（`SessionStart`、`UserPromptSubmit`、`PreToolUse`（带工具 matcher）、`PostToolUse`、`PostToolUseFailure`、`Stop`、`SubagentStart/Stop`、`PermissionRequest`、`SessionEnd`）。

但它对 Codex **只装 2 个**：`SessionStart`（补 OS 用户会话上下文）和 `Stop`（补 `last_assistant_message`）——源码注释写得很直白：

> Hooks supply only what Codex's OTLP export lacks... OTLP already reports the session, prompts, tools and turn.

**这是整份调研里最重要的一条工程判断：不要用 hook 重复采集已经有更便宜来源的数据。**

**记忆**：三段式

| 阶段 | 机制 | 关键设计 |
|---|---|---|
| 沉淀（distill） | 给 trace 打分（`task_success ≥ 0.50` 且均分 `≥ 0.60` 才算候选）→ 生成候选 → **从原始 trace 起草 lesson** → 人工逐条确认 | 打分模型只说「像不像可复用」，不说「该写什么」；**lesson 由 agent 读证据写，人批准** |
| 召回（recall） | MCP `search_memory` / `get_memory` / `get_memory_context`，或 CLI | **由 skill 驱动**，不是 hook 自动注入；skill 里写死了「什么时候查、最多查几次、冲突时以仓库文档为准」 |
| 提升（promote） | 把已批准的记忆写成 `.agents/skills/<slug>/SKILL.md` 提交到仓库 | 高频、跨任务的约定从「按需召回」升级为「harness 自动加载」 |

记忆分类是固定枚举：`workflow` / `correction` / `debugging_pattern` / `gotcha` / `convention`——这就是「内容打标」最省事的落点。

另外 Beacon 有 `intel_lookup` / `intel_check` 工具，用于查 MCP server / 插件的风险情报。它的产品文档里明确写着「查不到 **不等于** 安全」，这个措辞值得学。

---

## 四、横向对比

| 维度 | Claude Code | Codex | Hermes | Beacon |
|---|---|---|---|---|
| 事件数 | 30+ | 14 | 4 套系统，plugin 侧 20+ | 按 harness 适配 |
| 上下文注入 | `additionalContext`，10,000 字符后落盘 | `additionalContext`，默认 2,500 token 后落盘 | `pre_llm_call` + 系统提示段落（≤4,000 字符/段） | **无自动注入**，靠 skill 主动查 |
| 阻断 | `decision:block` / exit 2 / `permissionDecision` | `deny` / exit 2（`ask` 未支持） | `pre_tool_call` block，超时 fail closed | 无（只采集） |
| 内容改写 | `updatedInput` / `updatedToolOutput` | `updatedInput` / `PostToolUse` 替换结果 | modify args / `transform_*` | 无 |
| 学习触发 | 无内置，靠 skill 与用户 | 无内置 | 计数 nudge + 回合后 fork 复盘 | 打分 + 人工审批 |
| 跨 harness | 否 | 否 | 否 | **是（20+）** |
| 企业下发 | settings 层级 | `requirements.toml` + managed hooks | profile 级 | MDM / Jamf |

**三家共同的克制**：

- 没有一家默认做「每轮全量自动检索注入」。Claude Code 和 Codex 只提供机制，Beacon 只在 skill 里写「什么时候该查」，Hermes 用 nudge 提醒模型自己决定。
- 没有一家把「自动写入长期记忆」设成默认。Beacon 强制人工批准，Hermes 虽然有自动写入，但用路由规则 + 证据规则 + 频率阈值三重约束。

---

## 五、值得借鉴的六个设计模式

### 模式 A：注入分层（静态进前缀，动态进轮次）

**做法**：稳定的项目约定、用户画像、高频经验 → 系统提示 / `SessionStart`；与当前任务相关的动态检索结果 → `UserPromptSubmit`；与刚执行的工具相关的提示 → `PostToolUse`。

**为什么**：系统提示前缀能命中 prompt cache，几乎零边际成本；每轮注入会破坏缓存且累积污染。Hermes 的 `register_system_prompt_section` 把这个边界写成了硬约束（单段 4,000 字符、冻结于会话创建、压缩后从持久化副本恢复）。

**对 trove**：`profile.md`、高频 lessons 的索引（标题 + 一行 + id）走 `SessionStart`；具体检索走按需工具，不要每轮塞全文。

### 模式 B：注入预算 + 溢出策略

**做法**：Claude 用 10,000 字符、Codex 用 2,500 token，超限落盘并给「文件路径 + 短预览 + 恢复元数据」。Claude 明确不主动让模型读文件——所以**超限约等于丢弃**。

**为什么**：注入内容会一直占着上下文直到压缩，属于「永久成本」；而检索结果的价值是即时的。

**对 trove**：预算按 1–2KB 设计，格式固定为「结论一行 + 来源 id + 是否需要 get」。**永远不要注入完整 lesson 正文**。宁可注入 5 条各 200 字，也不要 1 条 1000 字。

### 模式 C：hook 只补磁盘拿不到的信息

**做法**：Beacon 对 Codex 只装 2 个 hook，因为 OTLP 已经有会话、prompt、工具、轮次数据。

**为什么**：重复采集意味着双份存储、双份脱敏逻辑、双份一致性维护，而且 hook 在关键路径上，多挂一个就多一份延迟风险。

**对 trove**：trove 已经通过 file adapter 读 `~/.claude/projects/**/*.jsonl` 和 Codex transcript。**hook 不承担采集职责**，只做两件事：启动时注入、停止时打标记入队。

### 模式 D：主动学习 = 事件 + 阈值双条件

**做法**：
- Beacon：会话结束 → 打分 → 超过阈值才进候选池。
- Hermes：每 10 轮 / 每 10 次工具迭代触发一次提醒；回合结束 fork 复盘，但跳过 cron 等无人值守场景（因为 30K token/次）。

**为什么**：纯事件触发（每个 `Stop` 都跑一遍）成本线性爆炸；纯定时触发会错过真正有价值的会话。双条件是成本与召回率的平衡点。

**对 trove**：`Stop` hook 只做**轻量标记**（写一行元数据：session_id、turn 数、是否有报错/纠正信号、是否触发了工具失败），真正的提取由 daemon 批量跑。这与 trove 现有的队列 + `trove learn -n` 天然契合。

### 模式 E：写入分级

**做法**：

| 级别 | 触发条件 | 处理 |
|---|---|---|
| 自动 | 低风险、可验证（如「这个仓库用 bun test」） | 直接写入，可回滚 |
| 审核 | 涉及用户偏好、跨项目结论 | 进候选队列，人工批准 |
| 提升 | 高频命中、跨任务 | 从 lessons 提升为 skill / CLAUDE.md 片段 |

**为什么**：Hermes 的注释说得很清楚——没有 grounding 规则时，reviewer 会把「一次性请求」写成「长期偏好」，把猜测写进记忆，然后**污染之后每一个会话**。

**对 trove**：trove 已经有 `curator` / `decisions` / `evidence` / `sidecar` 这些构件，把这套分级映射上去即可，不需要新造。

### 模式 F：内容打标的最小充分集

从 Beacon 和 Hermes 归纳，真正有用的标签只有五个维度：

| 维度 | 取值 | 用途 |
|---|---|---|
| 类型 | `workflow` / `correction` / `debugging_pattern` / `gotcha` / `convention` | 决定召回优先级与注入位置 |
| 作用域 | `user` / `project` / `global` | 决定是否跨仓库注入 |
| 来源 | harness + session_id + 时间 | 可追溯、可过期 |
| 置信度 | 证据强度（用户明确说过 / 推导 / 单次观察） | 决定写入级别 |
| 时效 | stable / decaying（带 staleDays） | 决定是否参与召回 |

**不要**做的：自由文本标签、多级嵌套分类、给每条 lesson 打十个 tag。标签是用来做**过滤**的，不是用来做**描述**的。

---

## 六、对 trove 的落地方案

### 6.1 自动上下文注入（推荐，P0）

| 项 | 设计 |
|---|---|
| 挂载点 | `SessionStart`（主）+ `UserPromptSubmit`（可选，默认关闭） |
| 触发 | `SessionStart` 的 `source` 为 `startup`/`resume`/`fork` 时都执行（这样 resume 能刷新） |
| 内容 | ① 用户画像摘要（≤300 字）② 当前仓库相关的 top-5 lesson 索引（标题 + 一行 + id）③ `trove_status` 的索引新鲜度 |
| 预算 | ≤1,500 字符；超了按优先级截断，不落盘 |
| 输出 | `hookSpecificOutput.additionalContext` |
| 失败策略 | 任何异常 → 静默 exit 0，绝不阻断会话启动 |
| 延迟 | 硬超时 1.5s；超时直接返回空 |

**必须处理的风险**：

- 注入文本要写成事实（「本机经验库里关于 X 的记录是……」），不要写成指令。
- 检索结果是不可信数据，trove skill 现有规则已经覆盖，注入时要在文本里重申一次。
- 不要把 `profile.md` 全文注入——它可能过期，且体量大。

### 6.2 自动检索（有条件推荐，P1）

**推荐做法：不做「每轮全文检索注入」，做「每轮轻量提示 + 模型自主 get」**。

理由：

1. 每轮注入会破坏 prompt cache，且 Claude Code 的 `UserPromptSubmit` 默认 30s 超时是**串行等待**，用户能感知。
2. 三家头部产品都没做默认每轮检索，不是没想到，是算过账。
3. trove 已经有 skill 路由，模型知道什么时候该查。

**折中方案**（如果确实想做）：

- 在 `UserPromptSubmit` 里只做**关键词抽取 + 索引命中判断**（不跑 embedding、不读正文），命中时注入「可能有 3 条相关经验：<id> / <一行>」，让模型自己决定是否 `get`。
- 预算 ≤500 字符，超时 800ms，命中率低于阈值就不注入。

### 6.3 内容打标（推荐，P0，是所有其他能力的前提）

**新增字段**（在 lesson frontmatter 上）：

```yaml
kind: workflow | correction | debugging_pattern | gotcha | convention
scope: user | project | global
confidence: stated | inferred | observed   # 用户明说 / 推导 / 单次观察
source: { harness, session_id, at }
decay: stable | decaying
```

**写入侧规则**（照抄 Hermes 的 grounding 规则）：

- 只写能指到具体证据的结论；证据不足 → `confidence: inferred`，不进自动注入。
- 一次性的请求不升格为偏好，除非用户用了「以后都 / 记得 / 我讨厌」这类表述。
- 「用户是谁」与「环境是什么」必须分库（trove 已有 profile 与 lessons 的区分，只需在写入口加强校验）。

**收益**：注入侧可以按 `scope=project AND confidence!=inferred AND decay=stable` 过滤，把噪声挡在注入之前。**没有打标就不该做自动注入。**

### 6.4 主动触发学习（推荐，P1）

**分两段：**

**第一段：`Stop` hook 打标记（轻量，必做）**

- 读 `last_assistant_message`（Claude/Codex 都提供，不用读 transcript）
- 只写一行到 trove 队列：`{session_id, turns, signals: {tool_failure, user_correction, files_changed}, ended_at}`
- 不做任何 LLM 调用，硬超时 500ms

**第二段：daemon / cron 批量提取（复用现有 `trove learn`）**

- 按「signal 加权 + 最近优先」排序，取前 N 个跑提取
- 每个会话抽完打 `processed` 标记，避免重复

**不建议照抄 Hermes 的「回合后 fork 复盘」**：30K token/次、每轮都跑，对本地 CLI 的成本模型不成立。trove 的价值在于**跨会话批量**，不在于**单轮即时**。

**可选增强**：参考 Hermes 的 nudge——在 trove skill 里写「每完成一个中等规模任务，问一句是否要沉淀」，把「何时学」的决策交给模型，成本为零。

### 6.5 明确不建议做的

| 不做 | 理由 |
|---|---|
| 用 hook 采集会话正文 | 磁盘 transcript 更全、更便宜、不占关键路径 |
| 每轮自动注入完整 lesson | 缓存破坏 + 上下文污染 + 延迟可感知 |
| 全自动写入长期记忆 | Hermes 和 Beacon 都用规则或人工审批兜底；无约束自动写入会持续污染 |
| 为每个 harness 做深度定制 hook | 先做 Claude Code 一个，Codex 复用同一份 `additionalContext` 协议；其余 harness 用磁盘采集 |
| 自建 OTel 上报 | 需要服务端，且 Beacon 的 OTLP 路线已被证明是重工程；trove 是本地工具 |

---

## 七、实施路线

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **P0-a** | lesson 打标字段 + 写入侧 grounding 校验 | 现有 `schema.ts` / `write.ts` | 1–2 天 |
| **P0-b** | `trove context --task <text> --format hook` 子命令：输出 `additionalContext` JSON | 现有 search | 1 天 |
| **P0-c** | `trove hooks install/uninstall/status`（Claude Code 优先，写 `~/.claude/settings.json`，幂等） | P0-b | 1–2 天 |
| **P1-a** | `Stop` 打标记 hook + 队列 signal 字段 | P0-c | 1 天 |
| **P1-b** | `UserPromptSubmit` 轻量命中提示（默认关闭，需显式开启） | P0-b | 1–2 天 |
| **P2** | Codex hooks 适配（事件名与协议几乎一致，复用同一 bin） | P0-c | 1 天 |
| **P2** | lesson → skill 提升（Beacon 的 promote 模式） | P0-a | 2 天 |

---

## 八、待决策清单

1. **自动注入的默认开关**：默认开（体验好，但有噪声风险）还是默认关（用户要显式 `trove hooks install`）？建议：安装后默认开，但只注入「索引 + 画像摘要」，不注入正文。
2. **`SessionStart` 注入的内容边界**：是否包含 `profile.md` 摘要？它的过期风险由谁兜底？
3. **是否做 `UserPromptSubmit` 自动检索**：建议先做 P1-b 的「轻量提示」版本，观察命中率再决定要不要升级。
4. **写入分级的具体阈值**：哪些类型可以自动写？建议只有 `convention` 且 `confidence=stated` 可以自动写。
5. **跨 harness 优先级**：Codex 用户占比多少？如果低，P2 可以延后。
6. **是否需要企业下发**（对照 Codex 的 `allow_managed_hooks_only`）：如果 trove 要在团队内推广，hook 安装器要考虑被 MDM 管理的情况。

---

## 九、附录：事件与字段速查

### Claude Code 注入相关字段

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "……"
  }
}
```

阻断：

```json
{ "decision": "block", "reason": "……" }
```

### Codex 注入相关字段

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "……"
  }
}
```

配置（`~/.codex/config.toml`）：

```toml
[[hooks.SessionStart.hooks]]
type = "command"
command = "trove context --format hook"
timeout = 5
additionalContextLimit = 2500
```

### Hermes 插件钩子签名

```python
def register(ctx):
    ctx.register_hook("pre_llm_call", my_memory_callback)   # 返回字符串 → 拼进用户消息
    ctx.register_hook("post_tool_call", my_logger)          # 返回值忽略
```

### Beacon 记忆类型枚举

`workflow` / `correction` / `debugging_pattern` / `gotcha` / `convention`

### 关键数值汇总

| 项 | 值 | 来源 |
|---|---|---|
| Claude `additionalContext` 上限 | 10,000 字符 | Claude Code 文档 |
| Codex `additionalContextLimit` 默认 | 2,500 token | Codex 文档 |
| Claude `UserPromptSubmit` 默认超时 | 30s | Claude Code 文档 |
| Hermes 记忆 nudge 间隔 | 10 轮 | `agent_init.py` |
| Hermes 技能 nudge 间隔 | 10 次工具迭代 | `agent_init.py` |
| Hermes 回合后复盘成本 | ~30K token/次 | `turn_finalizer.py` 注释 |
| Beacon 候选阈值 | `task_success ≥ 0.50` 且均分 `≥ 0.60` | `beacon-memory-distill` |
| Hermes 系统提示段落上限 | 4,000 字符/段，8,000 字符总计 | Hermes 文档 |
