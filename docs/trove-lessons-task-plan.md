# trove Lessons 层 · 任务计划拆分

> 对应方案文档：飞书《trove Lessons 层设计方案》（`feishu.doubao.com/docx/UOvrdUkTjoqjgFx0bSMcL2npnRe`，revision 24）
> 本文件用途：把「从 AI 会话自动沉淀可复用经验」这个大需求拆成**可核对目标、可验证达标**的阶段任务，供后续持续开发时逐阶段核对与验收。
> 阅读方式：先看「阶段总览」了解全貌 → 按顺序做，每个阶段做完先过它自己的「验收标准」→ 全部做完过「全局端到端验收」。

---

## 0. 文档约定与关键决策点

### 0.1 拆分原则

1. **以功能可验证为准**：每个阶段都有「达成目标 + 验收标准 + 自然语言用例」，用例面向「给什么输入、期望看到什么输出」，不要求描述代码实现。
2. **LLM / 打分不依赖真实模型**：提取链路大量依赖 LLM 与 Jev 打分，验收用例统一用「注入固定 JSON 响应」的方式验证流程正确性，不依赖真实模型返回（见阶段 0 的测试策略）。
3. **一期只做「沉淀」，二期只做「设计预留」**：向量检索（P7~P10）本期不实现，只确认目录与接口预留。

### 0.2 目录结构口径（实体化设计，唯一口径）

目录结构只采用**实体化设计**（`entities/` + `experiences/` + `preferences/` + `events/` + `resources/`）；方案早期的 scope 分层版属历史设计，不再考虑。细节命名以本节为准：

```text
vault/library/lessons/
├── INDEX.md                    # L0 全局索引（≤200 行，每条 1-2 行）
├── .overview.md                # L1 全局概览（≤4000 字符）
│
├── preferences/                # 偏好库
│   ├── profile.md              #   用户画像（patch 合并）
│   ├── writing_style.md        #   写作风格（patch 合并）
│   ├── coding_style.md         #   编码风格（patch 合并）
│   └── reply_format.md         #   回复格式（patch 合并）
│
├── entities/                   # 实体库（卡片式）
│   ├── projects/{slug}/        #   项目：overview.md / config.md / commands.md / decisions.md
│   ├── people/{name}.md        #   人
│   ├── organizations/{name}.md #   组织
│   ├── tools/{name}.md         #   工具
│   └── tech/{name}.md          #   技术栈
│
├── experiences/                # 经验库
│   ├── debug-{slug}.md         #   调试模式（add 独立）
│   ├── workflow-{slug}.md      #   操作流程（patch 合并）
│   ├── gotcha-{slug}.md        #   陷阱坑（add 独立）
│   └── correction-{slug}.md    #   纠正教训（add 独立）
│
├── events/                     # 决策记录
│   └── YYYY-MM-DD-decided-{slug}.md   # add 独立，不合并
│
├── resources/                  # 资料库
│   ├── docs/{slug}.md
│   ├── repos/{slug}.md
│   └── links/{slug}.md
│
└── archive/                    # 被取代的旧记忆（不进 INDEX.md）
    ├── preferences/ entities/ experiences/ events/ resources/
```

### 0.3 关键决策点（开发前需用户拍板）

| # | 决策点 | 方案默认 | 影响阶段 | 说明 |
|-|-|-|-|-|
| D1 | **已定：引入 LangGraph JS** | 引入 `@langchain/langgraph`（`SqliteSaver` 断点续跑） | 0、9 | **已拍板引入**，核心理由是健壮性更强：① Checkpointer 断点续跑，提取中途挂掉可从断点恢复、不丢进度；② StateGraph 显式状态机 + 条件边，流程可控可观测；③ Send API + reducer 追加，多提取器并行不互相覆盖；④ 二期可平滑切 `PostgresSaver`。阶段 0/9 按 LangGraph 落地，不再保留「自研 pipeline」分支。 |
| D2 | **已定：DeepSeek（OpenAI 兼容）** | `@langchain/openai`，`baseURL=TEXT_MODEL_BASE_URL`（`https://api.deepseek.com/v1`），`model=TEXT_MODEL`（`deepseek-v4-flash`），密钥 `TEXT_MODEL_API_KEY` | 0、4、5、6 | 端点/模型/密钥均已在 `.env` 配置，直接接入，无需再选型。仍抽象成 `LlmProvider` 接口以便测试 mock 与后续切换。 |
| D3 | **已定：TypeSafe Jev** | 走 `jev-latest`，密钥 `TYPESAFE_API_KEY` 已在 `.env` | 4 | 端点已就绪，按 `jev-latest` 接入，可用真实打分。保留「打分恒通过」降级开关用于本地调试，默认使用真实打分。 |
| D4 | **lessons 的落盘与同步边界** | lessons 写入本地 vault，由现有 sync 引擎同步到远程 | 1、7 | 确认 lessons 文件是否纳入现有 library 同步范围（本计划默认：纳入，复用 `library/sync.ts`，不新建同步逻辑）。 |
| D5 | **方案事件类型 → 现有 schema 映射** | 见 0.4 | 3 | 方案用 `user_message/tool_call/command/tool_result/error`，现有 `EventKind` 是 `session/message/reasoning/tool_call/tool_result/meta`，需先定映射。 |

### 0.4 事件类型映射（阶段 3 前置确认）

方案过滤表里的「事件类型」是抽象概念，落地到现有 `EventKind` 时需按下表对齐，**未对齐前阶段 3 无法验收**：

| 方案概念 | 现有 `EventKind` / `EventRole` 判定 | 是否保留 |
|-|-|-|
| `user_message` | `message` 且 role=user | ✅ 保留 |
| `tool_call` | `tool_call` | ✅ 保留 |
| `command` | `message` 且 role=user(命令即用户输入,不单独判定) | ✅ 保留 |
| `tool_result` | `tool_result` | ⚠️ 仅保留失败结果 |
| `error` | `tool_result` 且 `result.status === 'error'` | ✅ 保留 |
| `token_usage` / `metric` | `meta`(usage 等) | ❌ 丢弃 |
| `session` 开始/结束 | `session` | ❌ 丢弃 |

> D5 已定案:`command` 并入 `user_message`(`message` 且 role=user),`error` 即失败 `tool_result`(`result.status === 'error'`);`assistant` 消息 / `reasoning` / 成功 `tool_result` 一律丢弃。

---

## 1. 阶段总览

| 阶段 | 名称 | 对应方案 | 达成目标（一句话） | 依赖 |
|-|-|-|-|-|
| 0 | 基础能力与依赖 | 3.2 / 3.8 | 立起 LlmProvider / StorageAdapter / LangGraph 编排三个可测底座 | 无 |
| 1 | 目录骨架与 frontmatter 规范 | P1 | 能初始化 lessons 目录，产出规范化的记忆文件模板 | 0 |
| 2 | Memory Schema 定义 | P2 | 10 类记忆的 Schema（类型/路径/合并策略/提示词）可加载可校验 | 0 |
| 3 | 会话选择与事件加载过滤 | P3 前半 | 从会话正确挑出待提取会话，过滤噪声、按规则截断 | 0 |
| 4 | 会话摘要、分类与打分 | P3 中段 | 对会话产出摘要/分类/打分，低于阈值自动跳过 | 0、3 |
| 5 | 多类型经验提取 | P3 后半 | 5 个提取器产出带 evidence 的候选记忆 | 0、2、4 |
| 6 | 合并与冲突处理 | P4 | 产出 add/patch/append/skip 四种操作，冲突走归档 | 2、5 |
| 7 | 文件写入与索引更新 | P5 | 记忆落盘、INDEX.md/.overview.md 正确更新 | 1、6 |
| 8 | 审计日志与查看命令 | P6 | 每次提取产出可回溯的 memory_diff，`trove learn --list` 可查 | 6、7 |
| 9 | 编排接入 + 触发 + 断点续跑 | P3 触发 | 端到端跑通：手动/定时触发提取，中断可续跑 | 3~8 |
| 10 | 向量索引与语义检索（二期） | P7~P10 | 仅设计预留，不实现 | — |

**一期（阶段 0~9）是 MVP，阶段 10 不做。**

---

## 2. 各阶段详细任务

### 阶段 0 · 基础能力与依赖

**达成目标**
1. 有一个 `LlmProvider` 抽象（一期实现接 DeepSeek，见 D2），能「给提示词 + 期望 JSON 输出 → 拿到解析后的 JSON」，并能注入 mock（返回固定 JSON）供测试使用。
2. 有一个 `StorageAdapter` 抽象，本地文件系统实现可写入并读回一致内容；远端不另建 WebDAV adapter，而是复用既有 `RemoteStore`/`WebDavStore`（见「落地决策」）。
3. 编排层落地为 LangGraph `StateGraph`（阶段 9 接线），阶段 1~8 的逻辑作为纯节点函数实现，不依赖编排接线方式。
4. 依赖安装完成、类型检查通过、既有全量测试不回归。

**验收标准**
- [x] `npx tsc --noEmit` 零错误。
- [x] `npx vitest run` 全量通过（现有 34 个文件、183 个用例不回归）。
- [x] 新增依赖（按 D1/D2 决策）已写入 `package.json` 且可正常构建。
- [x] 能读到 `.env` 里的 `TEXT_MODEL_BASE_URL` / `TEXT_MODEL` / `TEXT_MODEL_API_KEY` / `TYPESAFE_API_KEY` / `TYPESAFE_MODEL`；缺配置时给明确报错，不静默失败（项目当前无 dotenv 依赖，用 Node 22 `--env-file` 或进程环境变量）。
- [x] `LlmProvider` 有 mock 实现，测试里不发起任何真实网络请求即可验证「提示词 → 结构化 JSON」链路。
- [x] `StorageAdapter` 的本地实现能把一个文件写入磁盘并读回一致内容；WebDAV 实现对现有 `WebDavStore` 的改造，通过既有 WebDAV 集成测试。

**自然语言用例**
- `用例 0-1` 用 mock 的 `LlmProvider`（配置为「输入任意提示词都返回 `{"a":1}`」），调用一次生成：期望拿到对象 `{a:1}`，且过程中无任何网络请求。
- `用例 0-2` 通过 `StorageAdapter` 本地实现，向路径 `experiences/debug-test.md` 写入字符串 `"hello"`：期望磁盘上出现该文件且读回内容为 `"hello"`。
- `用例 0-3` WebDAV 往返契约由既有 `webdav-store.integration.test.ts` 覆盖（写入→读取→删除、JSON 往返、区间上传），不另建 lessons WebDAV adapter。

**落地决策（Stage 0 已定）**
- `StorageAdapter` 只保留 `read` / `write` / `exists` 三个最小方法，`LocalStorageAdapter` 用原子写（临时文件 + `rename`），根目录即 lessons 目录、路径相对其解析（如 `experiences/debug-test.md`）。
- 远端不建冗余 WebDAV adapter：D4 已定 lessons 只写本地 vault、远端由既有 sync 引擎承担，`WebDavStore` 已经实现 `RemoteStore` 七原语，无需再套一层。
- `LlmProvider` 用**纯 JSON Schema**（`Record<string, unknown>`）描述输出，不引入 zod；DeepSeek 走 `ChatOpenAI.withStructuredOutput`，mock 用注入回调返回固定对象。

---

### 阶段 1 · 目录骨架与 frontmatter 规范

**达成目标**
1. 能一键初始化出 0.2 的完整 lessons 目录骨架（空目录 + `INDEX.md` + `.overview.md` 模板）。
2. frontmatter 规范落地：三类记忆文件（经验/实体/决策）各有正确的前置字段与默认值（`type` / `title` / `tags` / `scope` / `source` / `created_at` / `updated_at` / `superseded_by`）。
3. `INDEX.md` 与 `.overview.md` 有初始模板，结构符合 L0/L1 约定（INDEX 每条 1-2 行、overview ≤4000 字符）。

**验收标准**
- [x] 初始化后目录结构与 0.2 完全一致（含 `archive/` 及所有子目录）。
- [x] 一个经验文件、一个实体文件、一个决策文件分别能生成合法 frontmatter，`type` 取值正确（`experiences/debug_pattern`、`entities/project`、`events/decision`）。
- [x] 生成的 `INDEX.md` 初始为空索引但分区标题齐全（Preferences / Entities / Experiences / Events / Resources）。
- [x] `scope` 字段取值受约束（`global` 或 `project:<slug>`），非法值会被拒绝或警告。

**自然语言用例**
- `用例 1-1` 对一个空 vault 执行初始化：期望 `vault/library/lessons/` 下出现全部目录、`INDEX.md`、`.overview.md`，且没有多余文件。
- `用例 1-2` 重复初始化一次：期望不报错、不破坏已有文件（幂等）。
- `用例 1-3` 给一个 debug_pattern 记忆生成文件头：期望 frontmatter 含 `type: experiences/debug_pattern`、`scope`、`created_at`、`updated_at`、`source` 字段，且缺省值合理。
- `用例 1-4` 尝试写入 `scope: 火星`：期望被拒绝或给出明确警告，且不落盘。

---

### 阶段 2 · Memory Schema 定义

**达成目标**
1. 定义方案要求的记忆类型 Schema，每类包含：`type` 标识、写入目录、文件名规则、`merge_op` 策略（add/patch/append）、提取提示词、合并提示词（patch 类才需要）。
2. Schema 可被程序加载并校验完整性（缺字段、缺提示词能报出）。
3. 覆盖：偏好 4 类（profile / writing_style / coding_style / reply_format）、实体 5 类（project / people / organization / tool / tech）、经验 4 类（debug_pattern / workflow / gotcha / correction）、决策 1 类（decision）、资源 3 类（doc / repo / link）——共 17 类；其中「经验 4 类」与「实体 5 类」是核心。

**验收标准**
- [x] 每类 Schema 能被加载，字段齐全（缺任一必填字段会明确报错而非静默）。
- [x] 每类 Schema 的 `merge_op` 与 0.2 目录表一致（如 debug_pattern=add、writing_style=patch、resources/repo=append 等）。
- [x] 提取提示词与合并提示词能从 Schema 中取出，且引用到 `{summary}/{events}/{existing}` 等占位符。
- [x] 文件名规则正确（如 `debug-{slug}.md`、`YYYY-MM-DD-decided-{slug}.md`）。

**自然语言用例**
- `用例 2-1` 列出全部 Schema：期望返回 ≥17 类，且 `preferences/writing_style`、`experiences/debug_pattern`、`events/decision`、`entities/project` 均在其中。
- `用例 2-2` 删除某 Schema 的 `extraction_prompt` 后加载：期望报出「缺少提取提示词」并指明是哪一类。
- `用例 2-3` 取 `experiences/debug_pattern` 的写入规则，输入标题「ECONNRESET 时指数退避重试」：期望得到文件名 `debug-econnreset-retry.md`（slug 语义化，具体 slug 由实现定，但前缀 `debug-` 正确）。

---

### 阶段 3 · 会话选择与事件加载过滤

**达成目标**
1. 能按游标从待处理队列选出「已完成且值得提取」的会话，过滤掉太短、进行中、简单问答、无错误/纠正的会话。
2. 能加载会话事件并过滤噪声：保留 5 类有内容事件，丢弃 token_usage/metric/session 等；失败 tool_result 保留、成功 tool_result 丢弃。
3. 截断策略落地：按时间排序取首尾各 40 条（≤80 条），每条文本截断到 1200 字符（长输出保留前后各 600，中间省略）。

**验收标准**
- [x] 会话过滤规则全部生效：`event_count < 5` 丢弃、`updated_at` 距今 <5 分钟丢弃、user_message ≤2 且无 error/tool_call 丢弃、无 error 且无 correction 丢弃。
- [x] 事件过滤按 0.4 映射表执行（`command`/`error` 映射需先按 D5 定案）。
- [x] 截断后事件数 ≤80，且「首 40 条为最早、尾 40 条为最晚」。
- [x] 单条事件文本 ≤1200 字符，超长时中间以 `...` 省略。
- [x] 该阶段不调 LLM，纯确定性逻辑，可用普通单元测试覆盖。

**自然语言用例**
- `用例 3-1` 给一个只有 3 个事件的会话：期望被「太短」过滤，不进入后续提取。
- `用例 3-2` 给一个 `updated_at` 是 2 分钟前的会话：期望被「进行中」过滤。
- `用例 3-3` 给一个只有 2 条 user_message、无 error、无 tool_call 的会话：期望被「简单问答」过滤。
- `用例 3-4` 给一个含 200 条事件的会话，其中 150 条是 token_usage/metric、30 条成功 tool_result、20 条 user_message/tool_call/error：期望过滤后只保留有内容事件，且总数 ≤80，首尾各取 40。
- `用例 3-5` 给一条 5000 字符的超长 tool_result：期望截断到 1200 字符，头部保留前 600、尾部保留后 600，中间有省略标记。

**落地决策（Stage 3 已定）**
- 公开接口 `selectSession(events, now?)` 返回判别联合：`{status:'selected', events}` 或 `{status:'skipped', reason}`，reason 取 `too_short`/`in_progress`/`simple_qa`/`no_learning_signal`；同时导出 `filterEvents`/`truncateEvents`/`truncateText`/`isContentfulEvent` 供分项验证。
- `updated_at` 无会话级字段，取事件里最大可解析 `ts`（毫秒），据 `now` 判「距今 <5 分钟 → 进行中」；无有效 `ts` 记 0（视为早已结束）。
- 「纠正」在阶段 3 用关键词启发式判定（`不对/错了/纠正/改成/应该是/应该用/wrong/incorrect/instead/…`，落在 user 消息文本上），阶段 5 由 LLM 精化。
- 截断：`truncateEvents` 按 `seq` 排序取首 40 + 尾 40；`truncateText` 超 1200 时返回「前 600 + `...` + 后 600」（省略标记 3 字符叠在 1200 内容预算之上）。

---

### 阶段 4 · 会话摘要、分类与打分

**达成目标**
1. 对保留会话生成结构化摘要：`topic / intent / outcome / keySteps / hasError / hasCorrection / hasWorkflow`。
2. 摘要产出后做分类：判断 preferences / entities / experiences / events / resources 五类里哪些值得提取。
3. Jev 打分（TypeSafe `jev-latest`）：`task_success ≥ 0.50` 且 `mean_score ≥ 0.60` 才继续；不达标会话跳过并记录。
4. 全部 LLM/打分依赖可 mock，验收不依赖真实模型。

**验收标准**
- [x] 摘要字段完整，`outcome` 取值在 `success/failure/partial/trivial` 内，简单问答会话 `outcome=trivial`。
- [x] 分类结果为五类布尔值，且至少一个为真才继续；全假则结束。
- [x] Jev 阈值生效：`task_success<0.5` 或 `mean_score<0.6` 的会话被跳过（有记录），不进入提取。
- [x] Jev 打分按 TypeSafe `jev-latest` 接入（真实端点可跑），仍有 mock 供单测；保留「打分恒通过」降级开关但默认关闭。

**自然语言用例**
- `用例 4-1` 给一个「修 WebDAV ECONNRESET」的会话事件，mock LLM 返回固定摘要 JSON：期望摘要正确解析，且 `hasError=true`。
- `用例 4-2` 给一个「简单问答」会话，mock 返回 `outcome: trivial`：期望后续不再进入提取。
- `用例 4-3` 分类结果五类全 false：期望直接结束，不产生任何候选记忆。
- `用例 4-4` Jev mock 返回 `task_success=0.3`：期望该会话被跳过并出现在跳过记录里。
- `用例 4-5` Jev mock 返回 `task_success=0.8, mean_score=0.7`：期望继续进入提取。

---

### 阶段 5 · 多类型经验提取

**达成目标**
1. 五个提取器（Preference / Entity / Experience / Event / Resource）按分类结果并行/依次执行，各自产出结构化候选记忆。
2. 每条候选记忆带 `evidence`（来源事件编号），不凭空编造。
3. 敏感信息过滤：密钥/token/密码/内部主机名不进入记忆。
4. 质量过滤：太短、太泛、太琐碎的直接 skip。

**验收标准**
- [x] 五个提取器都能从「摘要 + 事件 + 现有记忆」产出符合各自 Schema 的 JSON（字段完整）。
- [x] 每条记忆含 `evidence`，且 evidence 引用的事件号在输入事件范围内。
- [x] 含 `password=xxx`、`token=yyy` 的事件提取后不包含这些敏感值。
- [x] 提取器只处理分类为真的类型（分类 false 的提取器不执行）。

**自然语言用例**
- `用例 5-1` 给一个「用户说『回复用简体中文』」的会话（分类只开 preferences），mock 提取器返回一条 writing_style：期望产出候选记忆 `{category: writing_style, preference: "简体中文回复"}`，带 evidence。
- `用例 5-2` 同一个会话分类里 entities=false：期望 Entity 提取器不执行，不产出实体候选。
- `用例 5-3` 事件里出现 `AWS_SECRET_ACCESS_KEY=AKIA...`：期望提取结果里不含该密钥值。
- `用例 5-4` 给一个「用户纠正 AI 说不对应该用 set -e」的会话：期望产出 correction 类型候选，标题含语义，且 evidence 指向纠正那条事件。

---

### 阶段 6 · 合并与冲突处理

**达成目标**
1. 对每条候选记忆，与同类型现有记忆做相似度匹配，产出四种操作之一：`add / patch / append / skip`。
2. `patch` 走 LLM 智能合并（去重、冲突以新为准、保留 evidence），不丢现有内容。
3. 冲突处理：结论冲突时不覆盖，旧记忆标 `superseded_by` 指向新记忆，旧文件移入 `archive/`。
4. 质量过滤：标题过短（<10 字符）、重复、太泛的 skip。

**验收标准**
- [x] `add` 类记忆即使与现有相似也新建（每条独立，如 debug_pattern / gotcha / correction / decision）。
- [x] `patch` 类记忆（profile / writing_style / workflow / project）正确合并，保留新旧信息，更新 `updated_at`。
- [x] `append` 类（resources 三小类 doc / repo / link）直接追加末尾，不去重。
- [x] 冲突记忆：新记忆进正式目录、旧记忆进 `archive/` 且 `superseded_by` 指向新路径、`INDEX.md` 不再含旧记忆。
- [x] skip 被记录进审计（阶段 8），有跳过原因。

**自然语言用例**
- `用例 6-1` 提取到一条新 debug_pattern，现有记忆里没有同类：期望操作=`add`，指向正式目录新文件。
- `用例 6-2` 提取到 writing_style「简体中文回复，技术名词可保留英文」，现有已存「简体中文回复」：期望操作=`patch`，合并后既有原偏好又有新增，且不重复。
- `用例 6-3` 提取到一条与现有「结论冲突」的记忆：期望旧文件移入 `archive/`、旧 frontmatter `superseded_by` 指向新文件、新文件落正式目录。
- `用例 6-4` 提取到标题仅 4 字符的候选：期望操作=`skip`，不落盘。

---

### 阶段 7 · 文件写入与索引更新

**达成目标**
1. 按写入路径规则把记忆写成 `.md` 文件，frontmatter 规范化，正文格式一致。
2. `add/patch/append` 三种操作正确落盘；`skip` 不落盘。
3. `INDEX.md` 更新：add 加一行（标题+路径+摘要+tags+分类）、patch 更新摘要、append 不加行、skip 不进索引。
4. `.overview.md` 更新：统计各类文件数 + 最近更新列表，≤4000 字符。

**验收标准**
- [x] 记忆文件路径与 0.2 规则一致（`experiences/debug-{slug}.md`、`entities/projects/{slug}/overview.md` 等）。
- [x] 写入文件含正确 frontmatter + 正文，`updated_at` 在 patch 时更新。
- [x] `INDEX.md` 行数与新增 add 记忆数一致，条目含标题/路径/一句话摘要/tags。
- [x] `.overview.md` 统计数字与磁盘实际文件数一致。

**自然语言用例**
- `用例 7-1` 执行一次 `add` 操作（新增 debug_pattern）：期望出现 `experiences/debug-xxx.md`，且 `INDEX.md` 的 Experiences 分区多了一行。
- `用例 7-2` 执行一次 `patch` 操作：期望目标文件内容更新，`updated_at` 变化，`INDEX.md` 该行摘要同步更新。
- `用例 7-3` 执行一次 `append` 操作（追加 resources）：期望文件末尾多了新条目，但 `INDEX.md` 行数不变。
- `用例 7-4` 有 3 个偏好、2 个项目、5 条经验：期望 `.overview.md` 统计为「偏好 3 / 项目 2 / 经验 5」，与磁盘一致。

---

### 阶段 8 · 审计日志与查看命令

**达成目标**
1. 每次提取结束写 `memory_diff.json`：含 session_id、project、extracted_at、operations（adds/updates/appends/skips）与 summary 计数。
2. 提供查看命令，能列出最近一次或指定会话的提取 diff，含跳过原因。

**验收标准**
- [x] `memory_diff.json` 结构与方案一致，`summary` 计数与 operations 实际条数一致。
- [x] adds 每条含 `uri/title/evidence`；updates 含 `before/after`；skips 含 `reason`。
- [x] 查看命令能显示「本次新增几条、更新几条、追加几条、跳过几条」，跳过项带原因。

**自然语言用例**
- `用例 8-1` 一次提取新增 1 条、更新 1 条、跳过 1 条：期望 `memory_diff.json` 的 summary 为 `{adds:1, updates:1, appends:0, skips:1}`，且 skips 含 `reason`。
- `用例 8-2` 执行查看命令：期望输出人可读的 diff 摘要，列出新增了什么、跳过了什么、为什么跳过。
- `用例 8-3` 一次提取无任何记忆产出（全 skip）：期望 summary 全 0，查看命令显示「本次无新增记忆」而非报错。

---

### 阶段 9 · 编排接入 + 触发 + 断点续跑（端到端打通）

**达成目标**
1. 用 LangGraph `StateGraph` 把阶段 3~8 的节点串成完整 pipeline，状态 schema 与方案 §3.3 一致，节点间状态传递正确。
2. 三种触发全部可用：
   - 手动：`trove learn <session-id>` 对指定会话提取一次；
   - 定时：daemon poll 拉取到新会话、归一化完成后自动触发（触发语义已修订为「独立 learn 循环、只自动学新会话、历史全手动」，见 §5 第 14 条）；
   - 会话结束：会话标记 completed 后延迟 5 分钟触发（与定时可合并实现）。
3. Checkpointer 断点续跑：提取中途中断，用同一 thread_id 可从中断处继续，不重复写入已完成记忆。
4. 端到端可跑通：一条真实/构造会话 → 提取 → 落盘 → 更新索引 → 写审计日志。

**验收标准**
- [x] `trove learn <session-id>` 对单会话跑通全链路（用 mock LLM 验证）。
- [x] daemon 同步完成后能触发提取（可验证 daemon 日志/状态里出现提取记录）。
- [x] 中断续跑：在合并阶段人为中断，重新执行能从断点继续，且已写入文件不被重复 add。
- [x] 未达提取阈值的会话（阶段 4 过滤）在端到端下不产生任何文件与索引变更。

**自然语言用例**
- `用例 9-1` 执行 `trove learn <某会话>`：期望在 lessons 目录出现该会话提取出的记忆文件、INDEX.md 更新、memory_diff 生成。
- `用例 9-2` 对同一会话重复执行 `trove learn`：期望不重复新增（相同记忆被去重/合并，文件不翻倍）。
- `用例 9-3` daemon 运行中，向 Beacon 拉取一条新会话：期望 daemon 在同步后自动触发提取，无需人工干预。
- `用例 9-4` 在提取流程第 6 步（合并）处中断：期望重启后能续跑完成剩余步骤，且最终结果与一次性跑完一致。

---

### 阶段 10 · 向量索引与语义检索（二期，仅预留）

**达成目标**
1. 确认二期检索的目录/接口预留不影响一期（如 `find()` 接口签名、向量字段 Schema 已文档化）。
2. 本期不实现 P7~P10，只在方案/代码里留好扩展点与边界说明（记忆 <50 条时用关键词+目录导航即可）。

**验收标准**
- [ ] 二期检索设计要点（Intent Analysis → 向量搜索 → Rerank → L0/L1/L2 组装）已沉淀在文档，标注「未实现」。
- [ ] 一期代码不含任何向量检索实现，也不因预留而引入额外依赖。

**自然语言用例**
- 本期无（二期不做）。

---

## 3. 全局端到端验收（一期整体达标）

以下用例横跨多个阶段，作为一期「真正完成」的最终核对清单：

- [x] `端到端-1` 准备一条包含「调试错误 + 用户纠正 + 明确偏好」的会话 → 走完整个 pipeline → 期望：产出至少一条 debug_pattern（add）、一条 preference（patch/新增）、审计日志记录完整、INDEX.md 与 .overview.md 更新一致。
- [x] `端到端-2` 准备一条「纯闲聊、无错误、无纠正」的会话 → 期望：在过滤/打分/分类任一环节被跳过，lessons 目录无任何新增文件，审计日志 summary 全 0。
- [x] `端到端-3` 连续处理同一条会话两次 → 期望：第二次不产生重复记忆（add 类幂等、patch 类合并后稳定）。
- [x] `端到端-4` 提取出的任一记忆文件 → 期望：能被「L0 摘要（INDEX 行）→ L1 概览（overview）→ L2 详情（.md 全文）」三级读到，且 INDEX 行里的路径能正确指向该文件。
- [x] `端到端-5` 全量跑 `npx tsc --noEmit` 与 `npx vitest run` → 期望：零错误、既有用例与新增用例全绿。
- [x] `端到端-6`（实践验证）真实端点冒烟：真实 DeepSeek + 真实 TypeSafe Jev 对一条「中途 error + 用户纠正 + 最终成功」的会话跑完整 `runLessonExtraction` → 产出 5 条记忆（偏好 1 + 实体 2 + 经验 2），1 条被 `title_too_short` 正确过滤；同时顺带验证确定性过滤：无 error 事件且无纠正关键词 → `no_learning_signal`、任务未成功 → `low_score`（taskSuccess 0.2）。

---

## 4. 依赖关系与建议顺序

```
阶段 0（底座）
   ├─▶ 阶段 1（目录/规范）  ─────────────┐
   ├─▶ 阶段 2（Schema）                  │
   ├─▶ 阶段 3（事件加载过滤）            │
   │       └─▶ 阶段 4（摘要/分类/打分）  │
   │              └─▶ 阶段 5（提取）     │
   │                     └─▶ 阶段 6（合并）┤
   │                            └─▶ 阶段 7（写入/索引）┤
   │                                   └─▶ 阶段 8（审计）
   └─────────────────────────────────────────────▶ 阶段 9（编排/触发/续跑，聚合 3~8）
```

- **可并行**：阶段 1 与阶段 2 互不依赖；阶段 3 可与 1、2 并行。
- **串行主干**：4 → 5 → 6 → 7 → 8 是严格串行。
- **阶段 9 最后做**：它把 3~8 串起来，是端到端收口，必须等前面全部验收通过。

---

## 5. 风险与未决项

1. ~~D1（是否引入 LangGraph）~~ **已定：引入 LangGraph**，理由健壮性更强（见 §0.3 D1）。阶段 0/9 按 LangGraph 落地，不再留「自研 pipeline」分支。
2. **D5（事件类型映射）** 的 `command` / `error` 两行**尚未落地**，是阶段 3 编码前的硬前置，否则过滤表无法实现。
3. **D2/D3 端点已就绪并已验证**：DeepSeek（`deepseek-v4-flash`）与 TypeSafe Jev（`jev-latest`）均在 `.env` 配好。真实端点冒烟已完成（见 §3 `端到端-6`）：LLM 全链路可解析、Jev 打分合理（任务未成功给低分、成功会话过关）、提取质量达标，不再依赖 mock 判定。
4. 目录结构只采用实体化设计，scope 分层版属历史设计不考虑；若后续调整目录，需回到 0.2 同步更新全部阶段。
5. **命名细节待统一**：`experiences/`（复数）与文档个别处 `experience/`（单数）混用，本计划统一用复数，落地时以 0.2 为准。
6. **已修复：本机分片被云端陈旧副本覆盖**（`sync.ts` 的 `pullLibrary` bug，导致 `trove learn` 报「没有找到会话」）。根因：分片文件 `library/index/<device>.json` 在 `isSelf` 判断之前就无条件 `writeAtomic` 覆盖本机——会话文件有「本机权威」保护、分片没有；于是「本机 build 出新分片 → 被云端旧快照覆盖 → 又 push 回云端」形成自我维持的滞后循环，统一索引继承陈旧。已按 TDD 修复（分片写入加「本机权威」保护，3 个用例见 `tests/library-pull.test.ts`），并用真实 state 重建分片验证：分片 1871→1968、统一索引 1895→1992，均恢复最新且包含当前会话。
7. **已修复：learn 产出的记忆 `frontmatter.source` 恒为 `null`**。根因：`write.ts` 的 `renderFile` 从未接收 source 参数、`graph.ts` 的 write 节点也未把 `sessionId` 传给 `applyOperations`，导致 `renderFrontmatter` 走到 `source ?? null` 降级。已按 TDD 打通透传：`WriteDeps` 新增可选 `source`、add/patch 分支传入、write 节点传 `state.sessionId`；用例见 `tests/lessons/write.test.ts`（add/patch 带 source 两条）与 `tests/lessons/graph.test.ts`（端到端 source 断言）。真实 learn 验证：产出 frontmatter 为 `source: "02682b49-…"`。
8. **已修复：记忆正文是一长串纯文本、不够结构化**。根因：`schema.ts` 的 `extractionPrompt` 是死代码从未被 `extract.ts` 使用，实际提取提示词与 `CANDIDATE_SCHEMA` 的 content 均无结构化约束。已按 TDD 在 `extract.ts` 双管齐下：提取提示词加「1~3 个 `##` 小节 + 每节 1~3 条 `-` 要点」要求、`CANDIDATE_SCHEMA.content.description` 同步加结构化 Markdown 描述；用例见 `tests/lessons/extract.test.ts`。真实 learn 验证：正文产出 `## 背景 / ## 要点 / ## 结论` + `-` 要点结构。

9. **已优化：learn 去重机制（2026-10-29 优化点 1）**。入口层 `runLessonExtraction` 以 `audit/<裸 session>.json` 为幂等键：已提取过的会话默认跳过（`already_learned`），`--force` 强制重跑；CLI `learn` 加 `--force` 选项，输出区分「已学习跳过」与「未达阈值跳过」。用例见 `tests/lessons/learn.test.ts`（force 旁路）、`tests/lessons/learn-cli.test.ts`（端到端-3 默认跳过 + force 重跑）。

10. **已优化：重复学习自动合并（优化点 2）**。append 类记忆（resources 三小类）由「无条件追加」改为「相同正文已存在则幂等跳过」，重跑/重复学习不翻倍；add 类原已幂等（同路径跳过）、patch 类原已 LLM 合并。用例见 `tests/lessons/merge.test.ts`（append 幂等）。

11. **已优化：覆盖所有记忆场景（优化点 3）**。`selectSession` 新增 `hasResourceSignal`（检测 `https?://` 与 `skill://`），资源型会话（仅含 URL/skill 引用、无 error/纠正）不再被 `simple_qa` / `no_learning_signal` 一刀切挡下。真实数据实证：20 会话批量 learn 中 7 个 URL/skill 会话此前全被确定性过滤挡下、resources 记忆零产出；放行后单个 skill:// 会话即产出偏好 2 + 实体 12 + 经验 5 + 资源 6 共 25 条记忆，覆盖偏好/实体/经验/资源四类场景。用例见 `tests/lessons/select.test.ts`（3 个资源信号放行）。

12. **已优化：resources 完全可溯源（优化点 4）**。`renderEvents` 补 `raw.path:line`（raw 原会话文件+行号）与 `tool.input`（含 URL）；`extract.ts` 对 resources 类别强制 content 含来源（URL/文件路径）。真实验证：resources 记忆正文含本地路径、`skill://`、`https://skills.sh/...`、`raw/<device>/doubao/.../trajectory.jsonl:63` 等可溯源地址。用例见 `tests/lessons/analyze.test.ts`（renderEvents 溯源）、`tests/lessons/extract.test.ts`（resources 提示词）。

13. **已知风险（真实数据暴露，未修复）**：(a) 6 个相似 tabbit/飞书会话 Jev 打分波动，部分 low_score 被跳过（Jev 对相似内容打分不一致）；(b) 2 类真实 ERR——`LLM 返回无法解析为 JSON`（workflow content 超长被截断）、`Jev 打分失败 HTTP 400 max_tokens_exceeded`（事件过多超 token 上限）；(c) 幂等键用裸 session id，跨 harness 同 id 会话会碰撞（误判已学习）。

14. **设计变更（待实现）：learn 自动机制与 sync 解耦，只自动学新会话、历史全手动（2026-10-29）**。
    - 现状问题（真实数据暴露）：(a) `learnNewSessions` 内联在 daemon `afterSync` 并被 `await`，sync 主循环被 learn 阻塞；(b) 无时间窗/无配额，候选 = 全部未审计会话——实测 1890 个未审计中 1388 个通过阶段 3 确定性过滤，重启后首次 `afterSync` 会串行跑完这 1388 条完整流水线（每条多次 LLM+Jev），持续数小时且阻塞 sync；(c) 触发只依赖 `audit/<id>.json` 存在性，无「新会话」判据。
    - 决策：回填策略 = **只自动学新会话，历史全手动**（历史用 `trove learn <id>` 补）；落地 = 把 learn 从 `afterSync` 拆出，成为 daemon 进程内与 sync 并列的独立调度循环。
    - 机制：sync 完成后把「本轮新归档/变更的会话 id 集合」交给 learn 调度器（需 `CollectResult` 暴露 id 列表，当前只有 `sessions` 计数，小改）；learn 循环按 `learnInterval` tick，每 tick 最多 `learnBatch`（默认 3）条，single-flight 防重叠；复用 `audit/<id>.json` 作「已学」标记，零新增状态文件。
    - 必处理的并发边界：learn 写 lessons 与 sync push 读 lessons 会并发，需保证不把半成品文件上传（learn 写完后再让本轮 push 可见，或两者对 lessons 互斥）。
    - 状态：未实现，待定 `learnInterval` / `learnBatch` 默认值后实施；`daemon.since` 时间窗不变（仍约束 sync 收集范围，与 learn 范围解耦）。
