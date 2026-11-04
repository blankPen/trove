import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { trovePaths } from '../../src/paths.js';
import { defaultConfig } from '../../src/config.js';
import { seedSession, tmpVault } from '../helpers/vault.js';

/**
 * HTTP 缝:web 后端唯一被观察的接口。
 * 这里只断言"请求 → 响应",不碰内部结构。
 */
describe('trove web API', () => {
  let server: RunningServer;
  let vault: string;

  beforeAll(async () => {
    vault = await tmpVault();
    await seedSession(vault, 'dev1', {
      harness: 'claude-code',
      session: 's-a',
      firstText: '为什么我 link 了还是 trove init',
      cwd: '/Users/admin/orca/trove',
      model: 'claude-opus-5',
      startedAt: '2026-10-22T13:00:00.000Z',
      events: [{ kind: 'message', role: 'user', text: '看下 PATH 环境变量' }],
    });
    await seedSession(vault, 'dev2', {
      harness: 'codex',
      session: 's-c',
      firstText: '消化 feishu ingest 文档',
      startedAt: '2026-10-20T09:00:00.000Z',
    });

    const paths = trovePaths(vault);
    const config = defaultConfig({ deviceId: 'dev1', deviceName: 'pzdeMac-mini' });
    server = await startServer({ paths, config, remote: null, adapters: [], port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('总览返回设备、远端与库计数', async () => {
    const res = await fetch(`${server.url}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device).toEqual({ id: 'dev1', name: 'pzdeMac-mini' });
    expect(body.counts.sessions).toBe(2);
    expect(body.counts.events).toBe(3);
    expect(body.remote.type).toBe('webdav');
  });

  it('总览给出最近 30 天的逐日会话数,没有会话的日子留空', async () => {
    const body = await (await fetch(`${server.url}/api/overview`)).json();
    const perDay = body.counts.perDay as Array<{ date: string; count: number }>;
    expect(perDay).toHaveLength(30);
    // 两个会话分别在 2026-10-22 与 2026-10-20;其余日子是 0
    const byDate = new Map(perDay.map((d: { date: string; count: number }) => [d.date, d.count]));
    expect(byDate.get('2026-10-22')).toBe(1);
    expect(byDate.get('2026-10-20')).toBe(1);
    expect(byDate.get('2026-10-21')).toBe(0);
    // 日期连续升序
    const dates = perDay.map((d: { date: string }) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('未知路由返回 404', async () => {
    const res = await fetch(`${server.url}/api/nope`);
    expect(res.status).toBe(404);
  });

  it('会话列表按开始时间倒序,带总数与分页', async () => {
    const res = await fetch(`${server.url}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((s: { session: string }) => s.session)).toEqual(['s-a', 's-c']);
    expect(body.items[0]).toMatchObject({
      harness: 'claude-code',
      cwd: '/Users/admin/orca/trove',
      model: 'claude-opus-5',
      devices: ['dev1'],
    });
  });

  it('会话列表支持 harness 与设备过滤', async () => {
    const cc = await (await fetch(`${server.url}/api/sessions?harness=codex`)).json();
    expect(cc.items.map((s: { session: string }) => s.session)).toEqual(['s-c']);
    const dev2 = await (await fetch(`${server.url}/api/sessions?device=dev2`)).json();
    expect(dev2.items.map((s: { session: string }) => s.session)).toEqual(['s-c']);
  });

  it('会话列表支持正文关键词搜索', async () => {
    const body = await (await fetch(`${server.url}/api/sessions?q=PATH`)).json();
    expect(body.items.map((s: { session: string }) => s.session)).toEqual(['s-a']);
  });

  it('会话列表分页:limit 与 offset 切同一份结果', async () => {
    const body = await (await fetch(`${server.url}/api/sessions?limit=1&offset=1`)).json();
    expect(body.total).toBe(2);
    expect(body.items.map((s: { session: string }) => s.session)).toEqual(['s-c']);
  });

  it('会话详情给出规范变体与事件总数', async () => {
    const res = await fetch(`${server.url}/api/sessions/${encodeURIComponent('claude-code:s-a')}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      harness: 'claude-code',
      session: 's-a',
      cwd: '/Users/admin/orca/trove',
      eventTotal: 2,
    });
    expect(body.sources).toEqual(['dev1']);
  });

  it('不存在的会话返回 404', async () => {
    const res = await fetch(`${server.url}/api/sessions/${encodeURIComponent('claude-code:zzz')}`);
    expect(res.status).toBe(404);
  });

  it('事件按 offset/limit 分页,eventTotal 与详情一致', async () => {
    const body = await (
      await fetch(`${server.url}/api/sessions/${encodeURIComponent('claude-code:s-a')}/events?offset=0&limit=1`)
    ).json();
    expect(body.eventTotal).toBe(2);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].kind).toBe('session');
  });

  it('超长字段在服务端截断,并记录原长度', async () => {
    const long = 'x'.repeat(200_000);
    await seedSession(vault, 'dev1', {
      harness: 'claude-code',
      session: 's-big',
      startedAt: '2026-10-22T13:00:00.000Z',
      events: [{ kind: 'tool_result', role: 'tool', result: { status: 'ok', output: long } }],
    });
    const body = await (
      await fetch(`${server.url}/api/sessions/${encodeURIComponent('claude-code:s-big')}/events`)
    ).json();
    const ev = body.events.find((e: { kind: string }) => e.kind === 'tool_result');
    expect(ev.result.output.length).toBeLessThanOrEqual(64 * 1024);
    expect(ev.__truncated['result.output']).toBe(200_000);
  });
});
