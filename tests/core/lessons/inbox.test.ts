import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import {
  writeInboxItem,
  listInbox,
  readInboxItem,
  removeInboxItem,
  updateInboxItem,
  acceptInboxItem,
  rejectInboxItem,
  newInboxId,
} from '../../../src/core/lessons/inbox.js';
import type { InboxItem } from '../../../src/core/lessons/inbox.js';
import { HeuristicGateway } from '../../../src/core/lessons/gateway.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import { readTrust } from '../../../src/core/lessons/trust.js';
import { readDecisions } from '../../../src/core/lessons/decisions.js';
import { parseMemory } from '../../../src/core/lessons/memory.js';
import type { LearnConfig } from '../../../src/config.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-inbox-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const now = new Date('2026-02-01T00:00:00.000Z');

const learn: LearnConfig = { mode: 'review', autoMigrate: true, quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 }, jev: { maxCallsPerSession: 8, timeoutMs: 2000 } };

function item(partial: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox_aaa',
    session: 'sess-1',
    type: 'experiences/gotcha',
    title: 'git push 报错需检查密钥',
    content: '## 适用场景\n推送报 Permission denied\n\n## 做法\n运行 `ssh-add -l` 检查密钥\n\n## 验证\n加载后 push 成功\n\n## 边界与反例\n不适用 HTTPS 凭证错误',
    evidence: [{ session: 'sess-1', seq: 1, quote: 'Permission denied' }],
    quality: { specific: 0.9, actionable: 0.9, transferable: 0.9, evidence: 1, non_duplicate: 0.9 },
    confidence: 0.9,
    trajectoryId: 'traj_1',
    promptVersion: 'exp-v3',
    createdAt: now.toISOString(),
    ...partial,
  };
}

describe('inbox 写入/列表/读取', () => {
  it('write → list(按 createdAt 升序) → read → update → remove', async () => {
    await writeInboxItem(storage, item({ id: 'inbox_later', createdAt: '2026-02-02T00:00:00.000Z', title: '较晚' }));
    await writeInboxItem(storage, item({ id: 'inbox_earlier', createdAt: '2026-01-01T00:00:00.000Z', title: '较早' }));

    const list = await listInbox(storage);
    expect(list.map((i) => i.id)).toEqual(['inbox_earlier', 'inbox_later']);

    expect((await readInboxItem(storage, 'inbox_earlier'))?.title).toBe('较早');

    const updated = await updateInboxItem(storage, 'inbox_earlier', { title: '改名' });
    expect(updated?.title).toBe('改名');
    expect((await readInboxItem(storage, 'inbox_earlier'))?.title).toBe('改名');

    await removeInboxItem(storage, 'inbox_earlier');
    expect(await readInboxItem(storage, 'inbox_earlier')).toBeNull();
  });

  it('listInbox 按 session 过滤', async () => {
    await writeInboxItem(storage, item({ id: 'inbox_a', session: 's-1' }));
    await writeInboxItem(storage, item({ id: 'inbox_b', session: 's-2' }));
    expect((await listInbox(storage, { session: 's-2' })).map((i) => i.id)).toEqual(['inbox_b']);
  });

  it('列表跳过损坏文件,不抛', async () => {
    await writeInboxItem(storage, item({ id: 'inbox_good' }));
    await storage.write('.trove/inbox/inbox_bad.json', '{ not json');
    const list = await listInbox(storage);
    expect(list.map((i) => i.id)).toEqual(['inbox_good']);
  });

  it('id 校验拒绝路径穿越', async () => {
    await expect(writeInboxItem(storage, item({ id: '../evil' }))).rejects.toThrow();
    expect(await readInboxItem(storage, '../../etc')).toBeNull();
    expect(await readInboxItem(storage, 'inbox_<x>')).toBeNull();
  });

  it('newInboxId 生成合法 inbox_ 前缀 id', () => {
    const id = newInboxId(now);
    expect(id.startsWith('inbox_')).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('accept / reject', () => {
  it('accept 走 Gate C 写记忆、删 inbox、写 review 决策、trust.accepted 递增', async () => {
    await writeInboxItem(storage, item());
    const r = await acceptInboxItem(storage, 'inbox_aaa', { gateway: new HeuristicGateway(), llm: new MockLlm(() => ({ content: 'x' })), learn, now: () => now });

    expect(r.removed).toBe(true);
    expect(r.paths.length).toBeGreaterThan(0);

    const files = await storage.list();
    const memPath = files.find((f) => f.startsWith('experiences/') && f.endsWith('.md') && !f.includes('/.'));
    expect(memPath).toBeTruthy();
    const mem = parseMemory((await storage.read(memPath!))!);
    expect(mem!.id.startsWith('exp_')).toBe(true);
    expect(mem!.body).toContain('## 证据');

    expect(await storage.read('.trove/inbox/inbox_aaa.json')).toBeNull();
    expect((await readTrust(storage, () => now)).accepted).toBe(1);
    const decisions = await readDecisions(storage);
    expect(decisions.some((d) => d.stage === 'review' && d.decision === 'accepted' && d.source === 'human')).toBe(true);
  });

  it('reject 删 inbox、写 review 决策、trust.rejected 递增', async () => {
    await writeInboxItem(storage, item());
    const ok = await rejectInboxItem(storage, 'inbox_aaa');

    expect(ok).toBe(true);
    expect(await readInboxItem(storage, 'inbox_aaa')).toBeNull();
    expect((await readTrust(storage, () => now)).rejected).toBe(1);
    const decisions = await readDecisions(storage);
    expect(decisions.some((d) => d.stage === 'review' && d.decision === 'rejected' && d.source === 'human')).toBe(true);
  });

  it('accept 不存在的 item 幂等返回 removed:false', async () => {
    const r = await acceptInboxItem(storage, 'inbox_nope', { gateway: new HeuristicGateway(), llm: new MockLlm(() => ({ content: 'x' })), learn, now: () => now });
    expect(r).toEqual({ paths: [], removed: false });
  });

  it('ops 为空(重复记忆)也删除并记录,不翻倍', async () => {
    await writeInboxItem(storage, item());
    await acceptInboxItem(storage, 'inbox_aaa', { gateway: new HeuristicGateway(), llm: new MockLlm(() => ({ content: 'x' })), learn, now: () => now });
    // 重新写入同一条,再用 identity=add 会被同路径幂等跳过 → ops 为空
    await writeInboxItem(storage, item());
    const r = await acceptInboxItem(storage, 'inbox_aaa', { gateway: new HeuristicGateway(), llm: new MockLlm(() => ({ content: 'x' })), learn, now: () => now });
    expect(r.removed).toBe(true);
    expect(await readInboxItem(storage, 'inbox_aaa')).toBeNull();
    expect((await storage.list()).filter((f) => f.startsWith('experiences/') && f.endsWith('.md') && !f.includes('/.')).length).toBe(1);
  });

  it('容量满时 accept 保留 inbox item 并返回 reason', async () => {
    const capacityLearn = { ...learn, capacity: { experiencesPerProject: 1, experiencesGlobal: 600, profileBytes: 8192, entitiesPerType: 200 } };
    await storage.write('experiences/workflow-existing.md', '---\ntype: experiences/workflow\ntitle: "旧经验"\ntags: ["experiences"]\nscope: project:trove\n---\n\n旧正文\n');
    await writeInboxItem(storage, item({ scope: 'project:trove' }));
    const r = await acceptInboxItem(storage, 'inbox_aaa', { gateway: new HeuristicGateway(), llm: new MockLlm(() => ({ content: 'x' })), learn: capacityLearn, now: () => now });

    expect(r.removed).toBe(false);
    expect(r.paths).toEqual([]);
    expect(r.reason).toBe('capacity_exceeded:experiences_project');
    expect(await readInboxItem(storage, 'inbox_aaa')).not.toBeNull();
  });
});
