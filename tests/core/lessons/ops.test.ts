import { describe, it, expect } from 'vitest';
import { parseRawOps, validateOps } from '../../../src/core/lessons/ops.js';
import type { OpsContext, RawOp } from '../../../src/core/lessons/ops.js';
import type { Event } from '../../../src/core/events/schema.js';
import type { ExistingMemory, RelatedMemory } from '../../../src/core/lessons/existing.js';

function ev(seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 's1', kind, ...extra };
}

const EVENT: Event = ev(5, 'message', { role: 'user', text: '以后所有 shell 脚本都用 set -e，别再让错误被吞掉' });
const QUOTE = '以后所有 shell 脚本都用 set -e';

function related(m: ExistingMemory): RelatedMemory {
  return { ...m, score: 0.5 };
}

function ctx(existing: ExistingMemory[] = [], rel: ExistingMemory[] = []): OpsContext {
  return { session: 's1', project: '/Users/x/trove', events: [EVENT], existing, related: rel.map(related) };
}

const EXPERIENCE = [
  '## 适用场景',
  'shell 脚本需要在任意命令失败时立即中断,而不是继续执行后续步骤、把错误掩盖掉的场景。',
  '',
  '## 做法',
  '在脚本开头加上 `set -e`,并配合 `set -u` 与 `set -o pipefail`,让未定义变量和管道失败也中断。',
  '',
  '## 验证',
  '在脚本中间插入一条必然失败的命令,观察脚本是否立刻以非零退出码结束,而不是继续打印后续输出。',
  '',
  '## 边界与反例',
  '不适用于需要忽略单条命令失败继续执行的场景;那种情况应显式使用 `command || true` 包裹。',
].join('\n');

function addOp(over: Partial<RawOp> = {}): RawOp {
  return { action: 'add', type: 'experiences/gotcha', title: 'shell 脚本应该启用 set -e', content: EXPERIENCE, evidence: [{ seq: 5, quote: QUOTE }], ...over };
}

describe('parseRawOps', () => {
  it('丢弃非法 action/type,保留合法 op', () => {
    const raw = parseRawOps({
      ops: [
        addOp(),
        { action: 'delete', type: 'experiences/gotcha' },
        { action: 'add' },
        null,
      ],
    });
    expect(raw).toHaveLength(1);
    expect(raw[0]!.action).toBe('add');
  });

  it('非对象/缺 ops 返回空数组', () => {
    expect(parseRawOps(null)).toEqual([]);
    expect(parseRawOps({ foo: 1 })).toEqual([]);
  });
});

describe('validateOps · 确定性校验', () => {
  it('合法 add → MemoryOp,带 scope 与 meta', () => {
    const { ops, rejected } = validateOps([addOp({ slug: 'set-e' })], ctx());
    expect(rejected).toEqual([]);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.op).toBe('add');
    if (op.op !== 'add') throw new Error('expected add');
    expect(op.path).toBe('experiences/gotcha-set-e.md');
    expect(op.meta?.scope).toBe('project:trove');
    expect(op.meta?.promptVersion).toBe('ops-v1');
  });

  it('未知 type → rejected unknown_type', () => {
    const { ops, rejected } = validateOps([addOp({ type: 'nope/x' })], ctx());
    expect(ops).toEqual([]);
    expect(rejected[0]!.reason).toBe('unknown_type');
  });

  it('证据在原文中找不到 → rejected evidence_missing', () => {
    const { ops, rejected } = validateOps([addOp({ evidence: [{ seq: 5, quote: '这段文字不在会话里' }] })], ctx());
    expect(ops).toEqual([]);
    expect(rejected[0]!.reason).toBe('evidence_missing');
  });

  it('经验类缺五段式 → lint 拒绝', () => {
    const { ops, rejected } = validateOps([addOp({ content: '只有一句话,没有五段式结构'.padEnd(120, '。') })], ctx());
    expect(ops).toEqual([]);
    expect(rejected[0]!.reason).toMatch(/^lint:/);
  });

  it('add 目标路径已存在 → rejected add_path_collision,不覆盖', () => {
    const existing: ExistingMemory[] = [
      { type: 'experiences/gotcha', path: 'experiences/gotcha-set-e.md', title: '旧的 set-e 经验', content: '旧正文' },
    ];
    const { ops, rejected } = validateOps([addOp({ slug: 'set-e' })], ctx(existing, existing));
    expect(ops).toEqual([]);
    expect(rejected[0]!.reason).toBe('add_path_collision');
  });

  it('patch 锚点不匹配 → rejected before_mismatch', () => {
    const target: ExistingMemory = {
      type: 'preferences/coding_style',
      path: 'preferences/coding_style.md',
      title: '编码风格偏好设置项与约束',
      content: '用户偏好:统一用 TypeScript',
    };
    const op: RawOp = {
      action: 'patch',
      type: 'preferences/coding_style',
      title: '编码风格偏好设置项与约束',
      content: '用户偏好:统一用 TypeScript 并开启 strict',
      target: target.path,
      before: '这段锚点在现有正文里不存在,但长度足够二十字',
      evidence: [{ seq: 5, quote: QUOTE }],
    };
    const { ops, rejected } = validateOps([op], ctx([target], [target]));
    expect(ops).toEqual([]);
    expect(rejected[0]!.reason).toBe('before_mismatch');
  });

  it('patch 合法 → MemoryOp,patch 锚点保留', () => {
    const target: ExistingMemory = {
      type: 'preferences/coding_style',
      path: 'preferences/coding_style.md',
      title: '编码风格偏好设置项与约束',
      content: '用户偏好:统一用 TypeScript,并且开启 strict 模式',
    };
    const op: RawOp = {
      action: 'patch',
      type: 'preferences/coding_style',
      title: '编码风格偏好设置项与约束',
      content: '用户偏好:统一用 TypeScript,开启 strict 模式,shell 脚本用 set -e',
      target: target.path,
      before: '统一用 TypeScript,并且开启 strict 模式',
      evidence: [{ seq: 5, quote: QUOTE }],
    };
    const { ops, rejected } = validateOps([op], ctx([target], [target]));
    expect(rejected).toEqual([]);
    expect(ops[0]!.op).toBe('patch');
  });

  it('target 不在注入的相关记忆里 → rejected target_not_in_context', () => {
    const op: RawOp = {
      action: 'patch',
      type: 'preferences/coding_style',
      title: '编码风格偏好设置项与约束',
      content: '新内容',
      target: 'preferences/coding_style.md',
      before: '二十个字以上的锚点内容在这里',
      evidence: [{ seq: 5, quote: QUOTE }],
    };
    const { rejected } = validateOps([op], ctx());
    expect(rejected[0]!.reason).toBe('target_not_in_context');
  });

  it('append 内容已存在 → rejected append_duplicate', () => {
    const target: ExistingMemory = {
      type: 'resources/doc',
      path: 'resources/docs/a.md',
      title: '文档资源条目与来源链接',
      content: '已经存在的资源正文内容',
    };
    const op: RawOp = { action: 'append', type: 'resources/doc', title: '文档资源条目与来源链接', content: '已经存在的资源正文内容', target: target.path };
    const { rejected } = validateOps([op], ctx([target], [target]));
    expect(rejected[0]!.reason).toBe('append_duplicate');
  });
});
