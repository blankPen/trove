# 0002 · web 触发的同步复用 vault 锁，不新增 IPC 通道

- 日期：2026-11-04
- 状态：已接受

## 上下文

`trove sync` 的写权由 `~/.trove/state.json.lock` 独占：daemon 与手动 sync
共用同一把锁，抢不到就抛「已有同步在运行」。daemon 每 300s 跑一轮，
每轮持锁约 28s（本机实测），web 的「立即同步」大概率撞上。

有两条路：web 自己调 `sync()`（自己抢锁），或者让 daemon 代跑（web 通过
某种 IPC 通知 daemon）。

## 决策

web 在**自己的进程内**调用 `sync()`，抢同一把锁。

- 抢不到锁 → 返回「daemon 正在同步（pid N），请稍后」，前端轮询锁释放后重试一次。
- 抢到锁 → 用现成的 `Progress` 接口把 `phase` / `item` 进度经 SSE 推给前端。
- 不引入 daemon IPC 通道：daemon 仍是一个纯定时循环，不接受外部指令。

## 理由

- 锁本来就是 trove 保证「同一份 vault/state 只允许一个进程写」的机制，
  web 尊重它就够了，不需要第二套并发控制。
- daemon 的设计是「定时同步」，不是「常驻服务」；给它加 IPC 会让它从
  一个 cron 变成一个服务，daemon 的复杂度与它解决的问题不成比例。

## 代价

- web 进程因此有了写 vault 的能力，不再是纯只读。这是刻意的：
  「同步」本身就是写操作，用户在 UI 上点了就是授权了。
- 撞锁时体验不如 daemon 代跑顺畅（要重试），但避免了「停 daemon → 同步 →
  重启 daemon」这套会引入 daemon 起不来的流程。
