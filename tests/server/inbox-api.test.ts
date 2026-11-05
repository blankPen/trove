import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { trovePaths } from '../../src/paths.js';
import { defaultConfig } from '../../src/config.js';
import { libraryLessonsDir } from '../../src/core/layout.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import {
  readInboxItem,
  writeInboxItem,
  type InboxItem,
} from '../../src/core/lessons/inbox.js';
import { tmpVault, vaultRoot } from '../helpers/vault.js';

/** 沉淀 Inbox 的 HTTP 缝:列表、接受、拒绝。 */
describe('trove web API · inbox', () => {
  let base: string;
  let storage: LocalStorageAdapter;
  let server: RunningServer;

  beforeEach(async () => {
    base = await tmpVault();
    storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot(base)));
  });

  afterEach(async () => {
    await server.close();
  });

  function item(partial: Partial<InboxItem> = {}): InboxItem {
    return {
      id: 'inbox_a',
      session: 'sess-1',
      type: 'experiences/gotcha',
      title: 'git push 权限排查',
      content: '## 做法\n运行 ssh-add -l',
      evidence: [{ session: 'sess-1', seq: 1, quote: 'Permission denied' }],
      quality: { specific: 0.9, actionable: 0.9, transferable: 0.9, evidence: 1, non_duplicate: 0.9 },
      confidence: 0.9,
      promptVersion: 'exp-v3',
      createdAt: '2026-02-01T00:00:00.000Z',
      ...partial,
    };
  }

  async function start(opts: { withLlm?: boolean } = {}): Promise<void> {
    const config = defaultConfig({ deviceId: 'dev1', deviceName: 'pzdeMac-mini' });
    if (opts.withLlm) {
      config.llm = { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k' };
      config.jev = { apiKey: 'k', model: 'm' };
    }
    server = await startServer({ paths: trovePaths(base), config, remote: null, adapters: [], port: 0 });
  }

  it('GET /api/inbox 返回待审列表与信任阶梯', async () => {
    await writeInboxItem(storage, item());
    await start();

    const res = await fetch(`${server.url}/api/inbox`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['inbox_a']);
    expect(body.items[0]).toMatchObject({ title: 'git push 权限排查', type: 'experiences/gotcha' });
    expect(body.trust).toMatchObject({ level: 0, accepted: 0, rejected: 0 });
  });

  it('POST /api/inbox/:id/reject 删除候选并返回 ok', async () => {
    await writeInboxItem(storage, item());
    await start();

    const res = await fetch(`${server.url}/api/inbox/inbox_a/reject`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await readInboxItem(storage, 'inbox_a')).toBeNull();
  });

  it('POST /api/inbox/:id/reject 不存在的候选返回 404', async () => {
    await start();
    const res = await fetch(`${server.url}/api/inbox/inbox_nope/reject`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /api/inbox/:id/accept 缺 LLM/Jev 配置返回 400 中文错误', async () => {
    await writeInboxItem(storage, item());
    await start(); // 不配 llm/jev

    const res = await fetch(`${server.url}/api/inbox/inbox_a/accept`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('LLM');
  });

  it('POST /api/inbox/:id/accept 写入记忆并返回路径', async () => {
    // 全新 type:身份裁决直接 add,不触发任何模型调用,离线可跑。
    await writeInboxItem(storage, item({ type: 'experiences/fresh' }));
    await start({ withLlm: true });

    const res = await fetch(`${server.url}/api/inbox/inbox_a/accept`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.paths)).toBe(true);
    expect(body.paths.length).toBeGreaterThan(0);

    expect(await readInboxItem(storage, 'inbox_a')).toBeNull();
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/') && f.endsWith('.md'))).toBe(true);
  });

  it('POST /api/inbox/:id/accept 不存在的候选返回 404', async () => {
    await start({ withLlm: true });
    const res = await fetch(`${server.url}/api/inbox/inbox_nope/accept`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /api/curator 默认 dry-run,返回报告结构', async () => {
    await start();
    const res = await fetch(`${server.url}/api/curator`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ stale: [], archived: [], revived: [], usageUpdated: [], skipped: [] });
  });
});
