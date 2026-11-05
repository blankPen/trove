# trove 经验学习沉淀与检索：现状诊断与改造方案

- 日期：2026-11-06
- 状态：方案已定，待实现
- 范围：`src/core/lessons/**`（学习沉淀）、`src/core/search/**`（检索召回）
- 依据：本机真实 vault（2535 个会话 / 1004 条记忆 / 391 条经验）。本文所有数字均在
  `~/.trove` 上实测得出，可复现；外部结论标注了出处。
- 本文档只承载**方案与评审**。检索换 qmd 的**实现**由编排者另开 ticket 承接（§7.1 是交接规格）。

---

## 1. 结论摘要

### 1.1 三个诊断

| # | 结论 | 关键证据 |
| --- | --- | --- |
| **D1** | 学习是**单会话、串行**流水线。每个会话约 7 次 LLM 调用、**9.5 万 token**，其中 82% 是把同一份会话转录**重复发 4~5 遍**。2535 个会话只学了 129 个（5%），队列积压 150。 | `usage.jsonl` 实测 28 次调用 / 385,286 token / 178 秒；`audit/` 129 份 vs 索引 2535 会话；`learn.db` 队列 queued=150 |
| **D2** | **跨会话去重实际失效**。Gate C（合并/取代裁决）在没有 Jev 时恒返回 `add`，所以每条新经验都新建文件。391 条经验实际只有 ~301 个主题，**同一个洞察最多被重复沉淀 50 次**。 | `src/core/lessons/gateway.ts:195` 无 Jev → `decision:'add'`；按标题 2-gram Dice≥0.45 聚类：391→301，最大簇 50 条 |
| **D3** | **检索对中文自然语言基本失效**。13 条真实查询里 7 条 FTS 零命中；FTS 落空后混合召回退化为**纯向量**，没有关键词锚点，返回的是噪声。 | `src/core/search/tokenize.ts:60` bigram 拼成 phrase、`:66` term 间 AND；实测表见 §3.3 |

### 1.2 三个改造方向

| 优先级 | 方向 | 一句话 |
| --- | --- | --- |
| **P0** | 检索层重做 | 把 CJK bigram 从「phrase + AND」改成「双路召回 + 查询扩展 + 章节级召回 + 重排」 |
| **P1** | 学习层提速 | 会话并发 + 一次摘要多处复用 + 按主题聚类批量提取，把每会话 token 砍掉 ~60% |
| **P2** | 跨会话关联 | 让 Gate C 不依赖外部 Jev 也能工作，并让 `scope`（项目隔离）真正生效 |

### 1.3 关于 qmd 的决定（已定案）

**检索侧确定重构：删除现有 bge（`Xenova/bge-small-zh-v1.5`）方案，改用 qmd + Qwen3-Embedding-0.6B。**

可行性已在本地核实到实现级：

| 事实 | 出处 |
| --- | --- |
| qmd 官方支持换嵌入模型，环境变量 `QMD_EMBED_MODEL` | `dist/llm.js:113` 的注释直接给出的示例就是 `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf` |
| 该 GGUF 文件存在 | `Qwen/Qwen3-Embedding-0.6B-GGUF`（Apache-2.0，167k 下载），文件 `Qwen3-Embedding-0.6B-Q8_0.gguf` |
| qmd 支持换下载源 | `HF_ENDPOINT=https://hf-mirror.com`（`dist/cli/qmd.js:3353`） |

> ⚠️ **实测到的部署前提**：`huggingface.co` 在本机**连接超时**（15s 无响应），
> `hf-mirror.com` 正常（0.7s）。qmd 默认从 huggingface.co 拉模型，
> 在本机必须带 `HF_ENDPOINT=https://hf-mirror.com`，否则 `qmd pull` 会一直挂住。
> 这条要写进 trove 的安装与 daemon 启动流程。

§5 记录的实测结论仍然成立、且是**定案的重要依据**：qmd 的 BM25 本身在中文上比现状差
（自然语言查询 5 条全 0，现状能捞到 15 条），qmd 的收益来自 `qmd query` 的
**查询扩展 + HyDE + 向量 + 重排**整条管线。所以迁移必须接的是 **qmd 的完整管线**，
不是把 FTS5 换成它的 BM25。

**本 ticket 只出方案与评审文档；实现由编排者另开 ticket 承接**（见 §7）。

---

## 2. 现状一：学习沉淀流程

### 2.1 入口与调度

```
sync ──▶ changedSessions ──▶ learn.db 队列 ──▶ learnPendingBatch ──▶ runLessonExtraction
                                                          │
daemon learn 循环（learnIntervalSeconds=60，learnBatch=3）
                                                          ▼
                                            单会话 v2 流水线（runLessonPipelineV2）
```

- 队列：`src/core/lessons/jobs.ts`，状态 `queued / leased / retry_wait / dead / done / skipped`，
  带租约、心跳、指数退避、当日 token 预算闸门（`src/core/lessons/runner.ts:90`）。
- 幂等键：`audit/<sessionKey>.json` 存在即视为已学（`src/core/lessons/learn.ts:108`）。
- 手动入口：`trove learn <session-id>`、`trove learn -n <数量>`、`trove learn-memo`、`trove learn-recent`。

### 2.2 单会话 v2 流水线

`src/core/lessons/v2.ts` 的 `runLessonPipelineV2`，7 个阶段：

| # | 阶段 | 做什么 | LLM 调用 | 并发 |
| --- | --- | --- | --- | --- |
| 0 | T0 启发式 | 空内容 / 高置信密钥形态 → 直接跳过 | 0 | — |
| 0.5 | Jev 压缩 | 只保留关键 tool 调用对，user/assistant 文字永不删 | 0（外部 Jev） | — |
| 1 | 摘要 | `summarizeSession` → topic/intent/outcome/keySteps | **1** | — |
| 2 | 分类 | `classifySession` → 5 个类目布尔 | **1** | — |
| 3 | Gate A | 会话级分诊（是否值得沉淀） | 0~1 | — |
| 4 | 轨迹 | `extractTrajectoryFacts` → 落 `trajectories/` | **1** | — |
| 5 | 提取 | 按类目各调一次 LLM 抽候选 | **1 × 命中类目数** | ✅ 已并行（`extract.ts:181`） |
| 6 | 质量 | contract lint → 证据校验 → Gate B → 质量裁决 | **1 × 候选数** | ❌ 串行（`v2.ts:201`） |
| 7 | Gate C 合并 | 与已有记忆判 add/merge/supersede | 0~1 × 候选数 | ❌ 串行 |
| 8 | 写盘 | 落记忆 → 审计 → 决策日志 | 0 | — |

### 2.3 成本模型（实测）

`~/.trove/usage.jsonl` 最近一次连续学习窗口：

| 指标 | 值 |
| --- | --- |
| 窗口 | 178 秒 |
| LLM 调用 | 28 次（≈ 7 次/会话 × 4 个会话） |
| prompt token | 317,959（**82.5%**） |
| completion token | 67,327（17.5%） |
| 合计 | 385,286（≈ **9.6 万/会话**） |

按任务拆：

| 任务 | 调用数 | prompt | completion | 每次 prompt |
| --- | --- | --- | --- | --- |
| `learn:extract` | 9 | 172,823 | 51,327 | 19,203 |
| `learn:summarize` | 7 | 83,194 | 7,779 | 11,885 |
| `learn:trajectory` | 3 | 57,700 | 4,389 | 19,233 |
| `learn:classify` | 6 | 3,381 | 3,052 | 564 |
| `learn:quality` | 3 | 861 | 780 | 287 |

**关键观察：prompt token 占 82.5%，且集中在三次「把整份会话转录重新发一遍」的调用上**
（extract 每个命中类目发一次全文、summarize 发一次、trajectory 发一次）。
也就是说同一份 ~19k token 的转录，一个会话被重复发送 **4~5 遍**。

产出/覆盖比：

| 指标 | 值 |
| --- | --- |
| 索引里的会话 | 2,535（claude-code 1665 / opencode 780 / doubao 59 / codex 31） |
| 已学习会话 | 129（5.1%） |
| 队列积压 | 150（queued） |
| 当日 token 预算 | 200,000 → 按 9.6 万/会话，**每天只能学 ~2 个会话** |
| 全量补齐的 token 需求 | ≈ 2.4 亿 token |

### 2.4 缺口

1. **串行**：`runner.ts:98`（批次内会话串行）、`learn.ts:287`（手动批量串行）、
   `v2.ts:201`（候选质量裁决串行）。并发度上界是 1。
2. **重复投递转录**：见 §2.3，是 82% 的 token 去处。
3. **跨会话去重失效**：`gateway.ts:195`，无 Jev 时 `resolveIdentity` 恒返回 `add`。
   `merge.ts:251` 的向量粗筛也从未被接上——`v2.ts:277` 调用 `mergeMemoriesV2` 时没有传
   `embedder` / `vectorIndex`，所以 `learn.embedding.gateTopK` 是死配置。
4. **只有一条跨会话通道**：`preferences/recent_matters`（`src/core/lessons/recent.ts`），
   靠最近 30 个会话的清单让 LLM 重写一个文件，与经验层没有关联。
5. **scope 未生效**：实体的 1004 条记忆 `scope` 全是 `global`（1003 条 `prompt_version: legacy`
   是 v1 管线写的，没写 scope；只有 1 条 `exp-v3`）。项目隔离形同虚设。

---

## 3. 现状二：检索召回流程

### 3.1 调用链

```
trove lessons search / trove_lessons_search (MCP)
  └─▶ searchLessons()                         src/core/search/service.ts:87
        ├─▶ LessonsIndex.build()              进程内 FTS5（内存，每次指纹变化重建）
        ├─▶ searchLessonsHybrid()             src/core/search/hybrid.ts:40
        │     ├─ FTS5 MATCH（BM25，字段权重 5/3/1）
        │     ├─ 向量余弦 top-10（bge-small-zh-v1.5，512 维，暴力全表扫）
        │     └─ RRF 融合（k=60）
        └─▶ applyUsageRanking()               使用反馈加权（retrieved/helpful/recency）
```

MCP 侧对模型暴露 7 个只读工具（`src/mcp/server.ts`）：`trove_whoami`、
`trove_lessons_search`、`trove_lesson_get`、`trove_lessons_list`、`trove_sessions_search`、
`trove_session_get`、`trove_status`。**记忆是按需检索的，不做整包注入。**

### 3.2 混合召回的实现细节

- `src/core/search/tokenize.ts` 是索引侧与查询侧共用的分词器：
  - 中文按 **2-gram** 切；英文保留整词并额外补 camelCase / 分隔符切分。
  - 查询侧 `toFtsQuery()` 把中文 bigram **拼成相邻短语** `"数据 据库 库连 连接 接超 超时"`，
    不同 term 之间用 **AND** 连接。
- `src/core/search/lessons-index.ts:170` 只在**整个查询是 1 个汉字**时降级为线性匹配；
  混在长查询里的单字 token（例如「怎么办」被剥掉「怎么」后剩下的「办」）没有任何兜底。
- 向量库 `~/.trove/cache/vectors.sqlite`：1004 条 × 512 维，`VectorIndex.search()` 每次
  查询 **全表读出并逐条解码计算余弦**（`src/core/lessons/vector-index.ts:109`）。

### 3.3 实测：13 条真实查询

同一批查询分别跑「现状严格 FTS」与「把 bigram phrase 换成 OR 的放宽版」，量化查询构造本身的损失：

| 类别 | 查询 | 现状 FTS | 放宽 FTS | 现状实际生成的 MATCH 串 |
| --- | --- | --- | --- | --- |
| 自然问句 | 为什么数据库连接超时 | **0** | 191 | `"数据 据库 库连 连接 接超 超时"` |
| 自然问句 | webdav 同步慢怎么办 | **0** | 41 | `"webdav" AND "同步 步慢" AND "办"` |
| 自然问句 | 怎么配置 llm | 15 | 113 | `"配置" AND "llm"` |
| 自然问句 | trove 的经验提取流程 | **0** | 269 | `"trove" AND "的经 经验 验提 提取 取流 流程"` |
| 自然问句 | 飞书文档评论怎么读 | **0** | 300 | `"飞书 书文 文档 档评 评论" AND "读"` |
| 术语 | COS 签名 | **0** | 4 | `"cos" AND "签名"` |
| 术语 | SignatureDoesNotMatch | 0 | 38 | `"signaturedoesnotmatch" AND "signature" AND …` |
| 术语 | quarantine | 2 | 2 | `"quarantine"` |
| 术语 | gitlab webhook | 2 | 25 | `"gitlab" AND "webhook"` |
| 短词 | 飞书 | 300 | 300 | `"飞书"` |
| 短词 | trove | 80 | 80 | `"trove"` |
| 混合 | playwright 截图 | 11 | 170 | `"playwright" AND "截图"` |
| 混合 | s3 multipart upload | 0 | 9 | `"s3" AND "multipart" AND "upload"` |

读法：

- **语料里有，查询串把它卡死了。**「放宽」只改了查询构造，文档没变，命中从 0 变成 191/269/300。
- **两个独立缺陷叠加**：
  1. bigram 被要求**相邻**（phrase），「数据库」「连接池」「超时」分开写在文档里就必然落空；
  2. term 之间 **AND**，任何一段没命中整条查询归零。
- **单字 token 是死条件**：索引侧不建 unigram，`"办"` 永远匹配不上 → 这条查询必然 0。
- **FTS 落空后混合召回救不回来**：`hybrid.ts:63` 的 RRF 融合里，FTS 列表为空时排名完全由
  向量决定。实测 `trove lessons search "COS 签名"` 返回的 5 条全是无关内容
  （trove status 输出、飞书用户身份……），因为向量 top-10 没有任何关键词锚点约束。
- **未被向量覆盖的文档直接消失**：`hybrid.ts:67` 用 `hitFromDoc` 兜底，
  但只有进了向量 top-10 的文档才可能出现。

### 3.4 缺口

1. 没有查询扩展 / 同义词 / 变体：用户说「数据库连不上」，语料里写「connection timeout」，两边对不上。
2. 没有重排：BM25 与向量融合后直接返回，没有第二阶段判断「这条是否真的回答了问题」。
3. 召回粒度是整篇文档：一条经验正文里的「## 做法」和「## 边界与反例」无法分开命中。
4. FTS 候选池被 `limit` 截断（`lessons-index.ts:168` 默认 10），向量池 `recallTopK` 也是 10，
   两边加起来最多 20 个候选进 RRF。
5. 向量检索每次全表解码（1004 × 512 × 4B ≈ 2MB），随语料线性变慢。
6. `scope` 全是 `global`，项目隔离在检索侧也用不上。

---

## 4. hermes-agent 对比

仓库：[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)（260k★，Python）。
以下均来自仓库源码。

### 4.1 学习沉淀

| 维度 | hermes-agent | trove |
| --- | --- | --- |
| 记忆分两层 | **过程性记忆 = Skills**（`SKILL.md` + `references/` + `scripts/`）；**陈述性记忆 = `MEMORY.md` / `USER.md`**（只放「用户是谁、环境是什么」这类事实，字符上限 2200 / 1375） | 17 类记忆、1004 个独立 Markdown 文件，事实与流程混在一起 |
| 谁来写 | **agent 自己**调 `memory` / `skill_manage` 工具写入，带写审批闸门 | 后台 LLM 流水线从历史会话里抽 |
| 什么时候写 | 会话中即时写；另有 **nudge**：每 **10 个用户轮次**（skill 每 15 次工具迭代）触发一次 | 事后批处理（`trove learn` / daemon learn 循环） |
| 抽取由谁做 | `agent/background_review.py`：**回复发出之后**再 fork 一个后台评审，复用父进程的 warm prompt cache，成本约 **30K token / 次** | 同一个前台流水线，一次会话一个 run |
| 过程性记忆怎么产生 | `/learn` 把用户描述的材料（代码目录、文档 URL、口述）变成可复用 skill；复杂任务后自动建 skill；skill 在使用中自我改进 | 无对应物（`resources/*` 只是链接归档） |
| 跨会话关联 | `agent/learning_graph.py` 构造 **skill ↔ memory ↔ related_skills 图谱**（`related_skills` frontmatter 显式声明边，memory→skill 边由词法重叠推导），桌面端画成「学习历程」 | 只有 `preferences/recent_matters` 一条聚合通道 |
| 合并 / 淘汰 | **curator 只管 skill**：`active → stale(14d) → archived(30d)`，归档可恢复；另有**可选的 LLM 合并**（`curator.consolidate`，默认关）把重叠 skill 并成上位类，带备份与 append-only 审计账本 | `curator` 管记忆生命周期，但**没有合并通道** |
| 记忆条目会不会过期 | **不会**。memory 条目无 TTL、无衰减、无归档、无自动合并，只有字符预算 | 有 stale/archived，但归档的是重复条目 |

**要点**：hermes 的学习是 **「在场学习」**——agent 在干活时顺手把经验写成 skill 或 memory；
trove 的学习是 **「事后考古」**——把 agent 自己都没回看过的历史会话批量蒸馏成经验。
前者上下文最丰富（知道为什么这么做）、单次成本更低（~30K vs ~96K token），
但只覆盖 agent 在场的会话；后者覆盖率高（本机 2535 个会话 vs 129 个已学），
但每次都从零重建上下文。**两者互补，不是替代关系。**

### 4.2 检索召回

| 维度 | hermes-agent | trove |
| --- | --- | --- |
| 记忆注入 | `MEMORY.md`/`USER.md` 在**会话开始时冻结注入 system prompt**（保持 prefix cache），**不做相关性排序** | 按需检索，7 个 MCP 工具 |
| 跨会话回溯 | `tools/session_search_tool.py`：单工具四种形态（DISCOVERY / SCROLL / READ / BROWSE），走 SQLite **FTS5**，**零 LLM 调用**，返回真实消息 | `trove_sessions_search` 走 `search.sqlite` FTS5 + `--exact` 线性兜底 |
| 中文怎么处理 | **CJK bigram 索引 → trigram 索引 → LIKE 兜底**三级路由（`hermes_state_fts.py`），只在 miss 时降级，命中仍走 BM25 排序 | bigram 索引，但查询侧拼成 phrase + AND（见 §3.3） |
| 召回质量的坑 | 明确处理「recall blindness」#19434：cron 会话的词汇量压过交互会话 → **降权而非排除** cron 来源 | 无来源区分 |
| 上下文安全 | 召回内容用 `<memory-context>` 围栏包裹，并从输出里剥除（`agent/memory_context.py` 的 `sanitize_context` / `StreamingContextScrubber`） | 有脱敏与路径校验，但记忆回填没有围栏机制 |
| 压缩前存档 | `on_pre_compress` checkpoint 钩子：上下文压缩前先落盘 | 无对应钩子 |
| 用户的文档/笔记 | **交给 qmd**（可选 skill / MCP server），见 §5 | 无外部检索后端 |

> 更正一条常见误传：hermes README 写「FTS5 session search with LLM summarization」，
> 但 `auxiliary.session_search` 早已移除（`hermes_cli/config_defaults.py` 注明 #27590），
> 代码与 `website/docs/user-guide/features/sessions.md` 都明确「不调用 LLM，返回真实消息」。
> 以代码为准。

### 4.3 关键差异（结论）

1. **hermes 没有「后台批量蒸馏全部历史会话」这一步**，因此不存在 trove 的 D1（慢）与 D2（重复沉淀）——
   但代价是覆盖不到 agent 没在场的会话。
2. **hermes 把「事实」与「流程」分开**：memory 只放事实（且整体注入），流程放 skill（按需加载）。
   trove 的 17 类记忆里 `experiences/*` 其实同时承担了这两者。
3. **hermes 的合并/淘汰能力挂在 skill 上，不挂 memory 上**——正好是 trove 反过来的：
   trove 有 memory 的 curator，却没有 skill 那样的合并通道。
4. **hermes 的会话检索是纯 FTS5、零 LLM**，且中文有三级路由兜底；trove 的向量检索每次全表解码，
   随语料线性变慢。
5. **hermes 把「用户自己的文档」明确交给外部检索引擎（qmd）**，自己只管自己的记忆——
   这是一个值得借鉴的**职责边界**。

---

## 5. qmd 评估

### 5.1 qmd 是什么

[tobi/qmd](https://github.com/tobi/qmd)（MIT，本地 CLI + MCP server + Node SDK）。
本地混合检索：BM25（SQLite FTS5）+ 向量（node-llama-cpp / GGUF）+ **LLM 查询扩展** + **HyDE** +
**RRF 融合** + **LLM 重排**，全程离线。

- 默认 3 个 GGUF 模型：embeddinggemma-300M（嵌入）、qwen3-reranker-0.6b（重排）、
  qmd-query-expansion-1.7B（查询扩展），合计约 2GB。
- 检索管线的官方描述：查询扩展生成 2 个变体（原查询融合时权重 2×）→ BM25 与向量并行召回
  → RRF（k=60）→ 重排器对候选打分（qmd 自身文档 `candidateLimit` 默认 40；Hermes 的 qmd
  skill 文档写的是 top-30）→ **位置感知融合**（1~3 名 75% 召回分 / 25% 重排分，
  4~10 名 60/40，11 名以后 40/60）。
- **智能切块**：按标题/代码块/空行切，目标 ~900 token、15% 重叠，代码块不切开。
- 集合（collection）+ 上下文（context）元数据，可按 metadata 过滤。
- MCP 工具：`query` / `get` / `multi_get` / `status` / `metadata`。

### 5.2 实测：qmd BM25 vs 现状 FTS

把同一个 lessons 目录注册成 qmd collection（1031 个 md，含 archive/audit/trajectories），
跑同一批查询，只用 BM25（`qmd search`，不加载任何模型）：

| 查询 | 现状 FTS 严格 | qmd BM25 | 说明 |
| --- | --- | --- | --- |
| 为什么数据库连接超时 | 0 | **0** | 都没命中 |
| webdav 同步慢怎么办 | 0 | **0** | 都没命中 |
| 怎么配置 llm | 15 | **0** | 现状更好 |
| trove 的经验提取流程 | 0 | **0** | 都没命中 |
| 飞书文档评论怎么读 | 0 | **0** | 都没命中 |
| COS 签名 | 0 | 4 | qmd 略好（现状 AND 要求共现） |
| quarantine | 2 | 3 | 持平 |
| gitlab webhook | 2 | 2 | 持平 |
| 飞书 | 300 | 20 | 两者各自截断（现状 LIMIT 300 / qmd 默认 20），实际相当 |
| trove | 80 | 20 | 同上 |
| playwright 截图 | 11 | 13 | 持平 |
| s3 multipart upload | 0 | 0 | 都没命中 |

**qmd 的 BM25 用的是标准 FTS5 unicode61 分词器，不做中文切词**，实测确认：
`数据库` 8 条、`超时` 20 条，但 `连接超时` 0 条、`数据库 连接` 0 条。

### 5.3 结论（已据此定案）

1. **直接换成 qmd 的 BM25 会更差**，尤其中文。trove 现有的 CJK bigram 方向是对的，
   错在「拼成 phrase + term 间 AND」。→ **迁移必须接 qmd 的完整 `qmd query` 管线**，
   不能只换 FTS 后端。
2. **qmd 真正的价值在 `qmd query` 那条管线**：查询扩展 + HyDE + 向量 + 重排。
   救回自然语言召回的是**查询扩展**（把「为什么数据库连接超时」扩成
   「数据库 连接池 超时 connection timeout」这类词面变体）和**重排**（在候选里挑真正对题的那条），
   不是它的 BM25。
3. **嵌入模型换 Qwen3-Embedding-0.6B，而不是 qmd 默认的 embeddinggemma-300M**
   （已定案，见 §1.3）。`QMD_EMBED_MODEL` 是 qmd 官方支持的覆盖点。
   Qwen3-Embedding-0.6B 是中英混合场景的强模型，比 trove 现用的 bge-small-zh-v1.5
   （512 维、小模型）更通用；代价是模型从 ~130MB 涨到 ~600MB，推理从 WASM/transformers.js
   换到 node-llama-cpp 原生。
4. **qmd 的模型有前置成本**：约 2GB GGUF + node-llama-cpp 原生编译（macOS 还要
   Homebrew SQLite 才能加载扩展）。而 trove 现在的嵌入是 transformers.js + q8 量化，
   已经在 `~/.trove/cache/models` 里跑着。→ 迁移必须**删掉 bge 依赖**，
   同时把 transformers.js 从 `dependencies` 里摘掉（否则白留一个 200MB+ 的依赖树）。

### 5.4 迁移目标形态

```
                    ┌─ qmd 索引（trove 的 lessons 目录注册为 collection）
                    │    · BM25（FTS5）
                    │    · 向量：Qwen3-Embedding-0.6B
                    │    · 查询扩展（1.7B）+ HyDE
                    │    · RRF(k=60) + Qwen3-Reranker-0.6B 重排 + 位置感知融合
searchLessons() ───┤
                    └─ trove 侧保留：frontmatter 语义、scope 过滤、merge/去重、使用反馈
```

- **qmd 负责「找得回」**：它不知道 trove 的记忆语义，只当纯文档库。
- **trove 负责「说得清」**：17 类记忆、frontmatter、`scope`、`evidence`、质量分、
  合并/取代、生命周期，全部留在 trove 侧。
- **接口不变**：`searchLessons()` 仍是 CLI 与 MCP 的唯一入口，MCP 的 7 个工具签名不变，
  只是内部把 `LessonsIndex` + `VectorIndex` 换成一次 `qmd query` 调用。
- **qmd 的 `context add` 正好承接 `scope`**：给每个类目/项目挂一段人写的描述，
  是 qmd 官方推荐且对召回质量影响最大的手段（qmd skill 文档：「dramatically improves
  retrieval accuracy」）。trove 可以按 5 个类目 + 项目自动生成。

---

## 6. 改造方案

### P0 · 检索层（收益最大，改动最可控）

**P0-1 修 tokenizer：bigram 不再拼 phrase，term 间不再全 AND**

- 索引侧保持 bigram（不动存量索引）。
- 查询侧改成**双路**：
  - `strict` 路：现逻辑（phrase + AND），命中即强信号；
  - `relaxed` 路：bigram 之间 OR，AND 只作用于**高信息量词**（长度 ≥ 2 的 ASCII 词、
    以及非疑问词的 CJK 段）。
- 两路结果用 RRF 融合后，再与向量路融合。
- 删掉纯单字 token（`"办"`），或把它降级为 relaxed 路的 OR 项。
- 预计：§3.3 表里 7 条 0 命中的查询全部恢复（放宽版 191/41/269/300/4/38/25/9）。

**P0-2 查询扩展（借 qmd）**

- 对「自然语言问句」形态的查询，额外跑一次小模型，产出 2~3 个词面变体
  （含同义词/英文术语/错误码形态），与原查询一起进多路召回。
- 扩展调用走**已有的 LLM 端点**（`llm.baseUrl`），不引入 qmd 的 2GB 模型依赖。
- 扩展结果按查询哈希缓存，避免每次检索都烧 token。

**P0-3 章节级召回**

- 经验类正文固定五段式（`## 适用场景 / ## 做法 / ## 验证 / ## 边界与反例`），
  按 `##` 切块建二级索引，命中后回填所属记忆。
- 好处：「这条经验的**边界**是什么」不必命中整篇；「做法」和「反例」不会互相稀释 BM25 权重。

**P0-4 轻量重排**

- RRF 融合后，取 top-20 做一次交叉编码式重排（可复用现有 LLM 端点，或用
  `bge-reranker-v2-m3` 这类小模型本地跑）。
- 同时输出 `scoreParts`（bm25 / 向量 / 扩展 / 时间 / 项目），让召回结果可解释。

**P0-5 向量检索提速**

- `VectorIndex.search()` 改成一次性把向量读进 `Float32Array` 缓存（当前每次查询全表
  `all()` + 逐条解码），或直接用 SQLite 的 `vector` 扩展 / 暴力点积的批量版本。
- 语料到 1 万条时这一步会先崩。

### P1 · 学习层提速

**P1-1 并发**

- `runner.ts:98` 批次内会话并发（默认并发 2~4，用 `learn.concurrency` 控制，
  注意 `dailyTokenBudget` 仍按天闸）。
- `v2.ts:201` 候选质量裁决并发（本来就是独立候选，串行没有理由）。
- `learn.ts:287` 手动批量并发。
- 预期：同样的墙钟时间吞吐 2~4 倍。

**P1-2 一次摘要，多处复用（省 60% token）**

- 现状：整份转录被发 4~5 遍（extract 每个类目一遍 + summarize 一遍 + trajectory 一遍）。
- 改造：拆成两段——
  1. **一次**「事实摘要」调用：把转录压成结构化事实（涉及的文件/命令/错误串/决策/纠正），
     作为后续所有调用的**唯一上下文**；
  2. 后续的 summarize / classify / trajectory / extract 全部基于这份事实摘要，
     prompt 体积从 ~19k 降到 ~2k。
- 预期：prompt token 从 31.8 万降到 ~12 万/窗口，约 −60%；**而且顺带解决了
  「缺少多会话关联性」的前置条件**——事实摘要天然可以跨会话合并。

**P1-3 按主题聚类批处理**

- 不再「一个会话一条经验」，改成「**一个主题一条经验**」：
  - 先按项目 + 关键词把相关会话聚成簇（可用 P0-1 的 relaxed FTS + 向量做近邻）；
  - 一个簇一次调用，把 N 个会话里的同类经验合并成一条带多来源 evidence 的记忆。
- 直接对上 D2：391 条经验 → ~301 条主题（去重后 ~250），一次调用覆盖多次会话。

**P1-4 增量维护取代全量重跑**

- `curator` 已有生命周期（active → stale → archived）与使用计数回写，
  但没有「经验更新」通道：同一主题的新证据目前会新建文件。
- 改造：主题级记忆带 `evidence[]`（多会话多来源），新证据只追加 `evidence` 与
  「更新记录」小节，不再新建文件。

### P2 · 跨会话关联

**P2-1 Gate C 不依赖 Jev**

- 现状：`gateway.ts:195` 无 Jev → 恒 `add`。这是 D2 的根因。
- 改造：把「无 Jev」从「恒 add」改成「**确定性粗筛 + LLM 裁决**」：
  - 粗筛：标题 2-gram Dice（现有 `titleScore`）+ 同 type + scope 兼容，取 top-5；
  - 裁决：复用 `llmIdentityDecision`（已存在，`merge.ts:207`），
    但只在粗筛分数落在**边界带**时才调用（避免每条候选都烧一次 LLM）；
  - 边界带之外：`merge` 判定直接采信，`add` 判定直接采信。
- 顺带把 `v2.ts:277` 漏传的 `embedder` / `vectorIndex` 接上，让 `gateTopK` 生效。

**P2-2 scope 真正生效**

- `inferScope` 已能算出 `project:<slug>`，但存量 1004 条全是 `global`。
- 改造：加一次性迁移，按记忆引用到的会话 `cwd` 回填 scope；
  检索侧同时启用 scope 过滤（`applyUsageRanking` 已有 `cwdScope` 概念，但只加 0.1 分，
  不是过滤）。

**P2-3 主题图谱**

- 借鉴 hermes 的 `learning_graph.py`：给记忆加 `related[]`（同主题/同项目/同工具的兄弟记忆），
  由 P1-3 的聚类结果直接产出。
- 用途一：检索命中一条时，可展开相邻记忆，解决「只召回一条孤立的经验」。
- 用途二：web 端「沉淀」页签可以像 hermes 桌面端那样画学习图谱。

---

## 7. 落地顺序

### 7.1 S0 · 检索换 qmd（已定案，本 ticket 只出方案，实现另开 ticket）

| 步骤 | 做什么 | 要点 |
| --- | --- | --- |
| S0-1 | 引入 `@tobilu/qmd` 依赖 | SDK 模式 `createStore({ dbPath, config: { collections } })`，索引落 `~/.trove/cache/qmd.sqlite` |
| S0-2 | 把 `library/lessons` 注册成 collection | 按 5 个类目分别注册（`preferences` / `entities` / `experiences` / `events` / `resources`），便于按类目过滤 |
| S0-3 | 写 `context` | 每个类目一段人写描述；qmd 官方称这对召回质量影响最大 |
| S0-4 | 固定模型 | `QMD_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`；下载走 `HF_ENDPOINT=https://hf-mirror.com`（**本机 hf.co 超时，实测**） |
| S0-5 | 换掉 `searchLessons()` 的内部实现 | 一次 `store.search({ query, collections, limit })` 取代 `LessonsIndex` + `VectorIndex` + RRF |
| S0-6 | **删除 bge 链路** | 删 `src/core/lessons/embedding.ts` 的 bge 路径、`src/core/lessons/vector-index.ts`、`src/core/lessons/vector-sync.ts`、`src/core/search/hybrid.ts`；从 `package.json` 摘掉 `@huggingface/transformers`；清 `~/.trove/cache/vectors.sqlite` |
| S0-7 | 保留 trove 语义层 | frontmatter 解析、`scope` 过滤、`evidence`、`use_count` 回写、merge/取代 全部留在 trove 侧 |
| S0-8 | 回归 | §3.3 的 13 条查询 + §5.2 的 qmd 对照表固化成回归脚本，入库 |

**验收口径**：同一批 13 条真实查询上，`qmd query` 的 top-3 命中率 ≥ 现状 FTS 的 2 倍；
且去掉 bge 后 trove 的安装体积与常驻内存不劣化。

### 7.2 学习与关联侧

| 阶段 | 内容 | 依赖 | 预估 |
| --- | --- | --- | --- |
| S4 | P2-1 Gate C 去 Jev 依赖 + 接上向量粗筛 | 无 | 中（改 `gateway.ts`/`merge.ts`/`v2.ts`） |
| S5 | P1-2 事实摘要复用 | 无 | 中（改 `v2.ts` 编排，影响 prompt 版本号） |
| S6 | P1-1 并发 | S5 | 小 |
| S7 | P1-3 主题聚类批处理 + P2-2 scope 回填 | S0、S4、S5 | 大（新管线 + 迁移） |
| S8 | P0-3 章节级召回 | S0 | 中 |
| S9 | P2-3 主题图谱 | S7 | 中 |

> S1（tokenizer 双路召回）与 S2（向量缓存提速）**在 S0 之后由 qmd 内部接管**，
> 不再单独排期；§6 的 P0-1/P0-5 只在「暂缓 S0」时才需要做。

**建议先做 S4 + S5**：S4 直接修掉「缺少多会话关联性」，S5 直接修掉「慢」。
两者都不需要新模型、不改存储格式。S7 是最大的一块，但收益也最大（吞吐与去重一起解决）。

---

## 8. 风险与不做的事

**风险**

| # | 风险 | 预警信号 | 影响 | 应对 |
| --- | --- | --- | --- | --- |
| R1 | **模型下载源不可达**（**已实测**：`huggingface.co` 在本机 15s 超时，`hf-mirror.com` 0.7s 正常） | `qmd pull` 长时间无进展、缓存目录不增长 | 检索完全不可用 | 安装脚本与 daemon 启动一律带 `HF_ENDPOINT=https://hf-mirror.com`；首次启动做探测，失败则明确报错而不是静默降级 |
| R2 | **node-llama-cpp 原生编译**（macOS 还要 Homebrew SQLite 才能加载扩展） | `qmd --version` 报 extension 加载失败 | 检索不可用 | 启动自检；把「装 Homebrew SQLite」写进 `trove init` 的前置提示 |
| R3 | **换后端后召回排序整体变化** | 13 条查询的回归命中率低于现状 | 用户体感变差 | §3.3/§5.2 的对照表固化成回归脚本，CI/本地都能跑；上线前必须过 |
| R4 | **P1-2 事实摘要会改变 prompt 版本** | 新旧记忆在同一库里互相污染 | 提取质量下降 | 新版本号 + 迁移期按 `prompt_version` 过滤新旧 |
| R5 | **P1-3 聚类批处理会重写存量** | 主题条目数骤降但 evidence 数暴涨 | 经验被揉坏 | 保留 `supersedes` / `evidence` 溯源 + 可回滚；聚类阈值按类目分别调 |
| R6 | **删 bge 后失去中文兜底** | qmd 重排未跑通时召回质量无底线 | 无降级路径 | 灰度期双跑（qmd + 现有 FTS）对比一周，确认后再删 `vectors.sqlite` |

**不做的事**

- **不动 lessons 的存储格式与 frontmatter**：17 类记忆、frontmatter 字段、审计目录结构都保持，
  避免破坏已有 vault 与同步协议。
- **不删存量记忆**：P1-3 的合并通过 supersede 归档，不做物理删除。
- **不把 merge/去重/生命周期交给 qmd**：qmd 是检索引擎，不知道 trove 的记忆语义；
  Gate C、curator、inbox 审核全部留在 trove 侧。
- **不在 trove 内再训一套向量模型**：嵌入由 qmd + Qwen3-Embedding-0.6B 提供。

---

## 9. 复现方式

本文数字的复现入口：

| 结论 | 复现 |
| --- | --- |
| 学习成本 | `~/.trove/usage.jsonl` 按 `task` 聚合；`~/.trove/vault/library/lessons/audit/` 计已学会话数 |
| 覆盖缺口 | `library/index.json` 的 `sessions` 数 vs `audit/` 文件数；`~/.trove/cache/learn.db` 的 `jobs` 表 |
| 检索命中 | 复刻 `src/core/search/tokenize.ts` 的分词 + FTS5 建索引，跑 §3.3 的 13 条查询 |
| 经验重复 | `library/lessons/experiences/**` 的 frontmatter `title` 做 2-gram Dice 聚类（Dice≥0.45） |
| qmd 对比 | `qmd collection add ~/.trove/vault/library/lessons --name lessons` 后 `qmd search <query> -c lessons --json` |
| qmd 混合管线 | `HF_ENDPOINT=https://hf-mirror.com QMD_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf qmd pull` → `qmd embed` → `qmd query "<query>" -c lessons --json` |

> 说明：qmd 的 `qmd query` 混合路径（查询扩展 + HyDE + 重排）在本机**尚未完成实测**——
> 模型下载（3 个 GGUF，约 2.3GB）需要 `HF_ENDPOINT` 镜像才能拉下来（默认源 hf.co 实测超时）。
> §5.3 关于「查询扩展与重排才是 qmd 的价值来源」的判断来自 qmd 官方文档与源码描述
> （`dist/llm.js` 的模型解析、qmd README 的管线图），以及 §5.2 已实测的 BM25 对比，
> 属于**未在本机验证**的部分。实现 ticket 的第一步应当补这次同语料 A/B，
> 作为 S0 验收的基线。
