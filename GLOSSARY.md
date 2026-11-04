# GLOSSARY

trove 项目的专有名词。定义用一两句话说清「是什么」,被放弃的说法列在 _Avoid_ 下。

## 沉淀

vault/library 层里从 AI 会话提炼出的三类长期资产:会话记录、lessons、skills。

_Avoid_: 归档(指 raw 层的事实搬运)、知识库、记忆库

## 归档

把本机 harness 的原始文件搬进 vault/raw。只搬运、不改写,内容寻址落盘。

_Avoid_: 沉淀、同步

## 原始层(raw)

`vault/raw/<deviceId>/`,按设备分区保存 harness 原始文件。事实层,只追加。

## 资产层(library)

`vault/library/`,派生层:会话事件流、lessons、skills、统一索引。可重建。

_Avoid_: 沉淀、原始层

## 会话(session)

一次 harness 对话,主键是 `(harness, session id)`。跨设备同一个会话是同一主键。

## 变体(variant)

同一 `(harness, session)` 在某台设备上的那一份事件流。多设备各持一部分时会有多个变体。

## 规范变体(canonical variant)

多个变体中被选为代表的那一份。选法:事件最多者优先,同数按 hash 字典序,保证确定性。

## 记忆(lesson)

`lessons/` 下的一篇 markdown。用 frontmatter 标注 `type` / `title` / `tags` / `scope` / `source`,
并以 `(harness, session, seq)` 引用会话,不复制会话正文。

_Avoid_: 沉淀物、笔记

## 用量台账

`~/.trove/usage.jsonl`,记录 **trove 自身** 调用 LLM 的 token 消耗(learn 提取、summarize 等)。
一次调用一行,只追加。

_Avoid_: 消耗统计、token 统计

## 会话消耗

**归档会话**里发生的 token 消耗。会话事件带 `usage` 字段,但 trove 从不聚合它。

_Avoid_: 用量(指用量台账)、消耗统计

## 技能(skill)

一组内容寻址的文件。同名技能可以有多个版本,版本标识就是内容 hash。
同名去重靠内容 hash,来源由 frontmatter 或 `.git/config` 判定(self / github / skillsh / unknown)。

_Avoid_: 插件、扩展

## 统一索引

`library/index.json`,由各设备分片 `library/index/<deviceId>.json` 合并而来。
是派生视图,不是事实源。
