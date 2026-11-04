# 0001 · web 界面采用独立前端工程 + Node 后端服务

- 日期：2026-11-04
- 状态：已接受

## 上下文

trove 是零前端依赖的 CLI（`tsc` 编译，`files: ["dist"]` 发布）。
但用户要一个能读会话/沉淀/用量的 web 界面，且后续还要加 skills 管理、深搜、
同步进度等交互 —— 这些都需要前端状态管理、路由、虚拟列表。

## 决策

web 界面拆成两部分：

- **前端**：根目录 `web/`，独立 `package.json`（React + Vite + TypeScript），
  作为 pnpm workspace 成员（共享根 lockfile，`pnpm install` 一次装齐，
  但 `dependencies` 不污染根包，npm 消费者不会拖进 React）。
  构建产物输出到 `dist/public/`，随 `files: ["dist"]` 一并发布。
- **后端**：根目录 `src/server/`，Node 内置 `node:http`，零新依赖，
  复用现有 `src/core/*`（`listSessions` / `sync` / `daemon` / `status`）。

CLI 侧只加一个 `trove web` 子命令，负责拉起后端并伺服 `dist/public/` 的静态文件。

## 理由

- 服务端渲染零依赖方案的交互天花板太低：多页签、无限滚动、深搜结果高亮、
  同步进度推送，每一项都要手写 DOM 操作，越写越像在造一个烂框架。
- 后端放在 `src/` 内而不是另起进程：读取 vault、触发 sync、控制 daemon
  都需要 `src/core` 的模块，进程内调用省掉一层 IPC 和参数序列化。
- 前端独立成工程而不是塞进 `src/`：让 `src/` 保持"可被 tsc 编译的 Node 代码"
  这一条不变量，`tsconfig` 的 `rootDir: src` 不需要为前端开特例。

## 代价

- 两条构建链：`pnpm build` 要先 `tsc` 再构建前端；前端 dev server 与后端
  分两个进程（vite proxy `/api`）。
- 多一个 lockfile 参与者：根 `pnpm-workspace.yaml` 增加 `packages: ["web"]`。
- 前端类型不进 `tsc --noEmit` 的检查范围，前端要自带 `tsc --noEmit` 脚本。
