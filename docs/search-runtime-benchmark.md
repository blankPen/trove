# 检索运行时改造：前后性能对比

日期：2026-11-06
机器：macOS (darwin 24.6.0)，Node 22.18.0，本机 1034 条 lessons

## 1. 改造内容

daemon 从「只做同步/学习的控制面」升级为「本机唯一持有检索模型的数据面」：

- daemon 启动时在 `127.0.0.1:<随机端口>` 发布检索端点，端口与 Bearer token 写入 `~/.trove/daemon.search.json`（0600）。
- `[SearchRuntime](../src/core/search/runtime.ts)` 统一持有 qmd store：串行闸门（避免 Metal 并发卡死）、模型保活（抵消 qmd 的 5 分钟空闲卸载）、健康统计。
- 端点暴露三条路由：`GET /v1/health`、`POST /v1/lessons/search`、`POST /mcp`（Streamable HTTP，无状态）。
- CLI 与 `trove mcp` 通过 `[client](../src/core/search/client.ts)` 探测并复用 daemon；探测失败（未运行 / 协议不匹配 / token 不对 / 超时）自动回落本进程加载，结果一致。
- 新增配置：`search.mode`（auto/daemon/local）、`search.timeoutMs`、`daemon.search.{enabled,port,keepWarmMinutes}`。

## 2. 测量方法

统一脚本 `scripts/bench-search.mjs`，同一台机器、同一语料、同一查询（`trove`，limit 3）：

- **CLI**：`spawn node dist/main.js lessons search`，采 5 次取均值——这是用户真实体感（每次新进程）。
- **进程基础开销**：`trove lessons list --limit 1`（不碰模型），用来剥离 Node 启动与目录索引的成本。
- **进程内**：直接调用 `dist/core/search/qmd.js`，分别是打开 store、首次检索（含模型加载）、同 query 热检索、新 query（模型热）。
- **daemon 端点**：`DaemonSearchClient.search`，采 5 次。

复现：

```bash
pnpm build
node scripts/bench-search.mjs --label before --out /tmp/bench-before.json   # 改造前代码
node scripts/bench-search.mjs --label after  --out /tmp/bench-after.json    # 改造后 + daemon 运行中
```

## 3. 结果

| 指标 | 改造前 | 改造后 | 变化 |
|---|---:|---:|---:|
| CLI 单次检索（5 次均值） | **2038 ms** | **578 ms** | **−72%（3.5×）** |
| CLI 明细 | 2052 / 1950 / 1887 / 2170 / 2129 | 621 / 563 / 566 / 557 / 582 | 方差也更小 |
| daemon 端点 RPC | — | **141 ms** | 新增 |
| 进程内首次检索（含模型加载） | 1669 ms | 1360 ms | 模型加载成本本身不变 |
| 进程内热检索（同 query） | 316 ms | 122 ms | 查询扩展缓存命中 |
| 进程内热检索（新 query） | 680 ms | 69 ms | 同上 + 模型已热 |
| 进程基础开销（`lessons list`） | 722 ms | 660 ms | 与改造无关 |

### 拆解

改造后的 578 ms ≈ **进程与 lessons 基础开销 ~437 ms + daemon RPC 141 ms**；改造前是 **~370 ms + 进程内冷加载 1669 ms**。

daemon RPC 的 141 ms 与进程内热检索（122 ms）基本持平，说明 RPC 自身开销可以忽略——省掉的是每次 CLI 重新装 2.5 GB 模型的 1.4–1.7 秒。

### 客观限制

- 数字是本机单次采样（每项 5 次），不是统计显著的基准；但差距（3.4×）远大于噪声。
- 首次查询仍受模型下载/加载影响；`keepWarmMinutes` 默认 15 分钟，闲置超窗后第一枪仍会有一次冷加载。
- daemon 重启后的首个检索要等模型预热（实测约 12s，请求在串行闸门里排队），之后稳定在 ~300ms；索引检查只在同步确有变更时触发。

## 4. 功能验证

| 场景 | 验证方式 | 结果 |
|---|---|---|
| CLI 走 daemon | `trove lessons search "trove" --json` → `backend` | `daemon` |
| CLI 兜底 | `trove daemon stop` 后同一命令 | `backend: qmd`，1.69 s，结果正常 |
| daemon 水平 | `trove doctor` / `trove daemon status` | 显示 `127.0.0.1:57003（协议 v1）` |
| MCP HTTP | `initialize` + `tools/call trove_lessons_search` | 正常返回经验条目 |
| MCP stdio 代理 | `trove mcp` 握手 + `tools/call` | 167 ms（本地加载时约 1.5 s） |
| 鉴权 | 错误 token / 无 token | 401 |
| 串行闸门 | 单测：3 个并发检索 | 峰值并发 1 |
| 保活窗口 | 单测：tick 内 touch、超窗停止 | 通过 |
| 全量测试 | `pnpm test` | 112 文件 / 877 用例全部通过 |

## 5. 已知取舍

- **daemon 是单点但非故障点**：端点不可用时 CLI 回落本地，只是慢，不失败。
- **保活依赖 qmd 内部 API** `store.internal.llm.touchActivity()`；已在 `touchQmdActivity()` 一处封装并做能力探测，qmd 升级断了就按「不保活」降级。
- **并发为 1**：这是 Metal 上 llama.cpp 的硬约束，不是保守选择；吞吐换稳定。
- **模型常驻内存约 2.8 GB RSS**：笔记本上可用 `daemon.search.keepWarmMinutes = 0` 关闭保活。
